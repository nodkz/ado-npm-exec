/**
 * Background update checks of a running session: a newer version is found
 * (token, lookup, install into its own `_npx` folder) and recorded for the
 * NEXT start. The running server is never replaced.
 */

import { npmPickOptions, proxyBlocksFetch } from './env.js';
import { collectGarbage } from './gc.js';
import { feedTenant, pickVersion, preinstall } from './install.js';
import { addSecret } from './log.js';
import { isReadyToStart } from './npm-cache.js';
import { readState, recordVersion, signInMemory, updateState } from './state.js';
import { AbortedError, TokenError } from './tokens.js';

/** A start checks the feed at most this often. */
export const START_CHECK_GAP_MS = 60 * 60 * 1000;
/** A long session checks this often... */
const PERIODIC_CHECK_MS = 6 * 60 * 60 * 1000;
/** ...after this much running time without a freeze: not inside a short wake from sleep that the next sleep cuts. */
const SETTLE_MS = 5 * 60 * 1000;
/** A feed that does not answer, or no sign-in, backs off from START_CHECK_GAP_MS, doubling up to this. */
export const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
/** A check another process started this recently is left to it. */
export const CHECK_IN_FLIGHT_MS = 2 * 60 * 1000;
/** The first check waits up to this long, so that servers started together do not run their sign-in tools at once. */
const FIRST_CHECK_JITTER_MS = 10_000;

/**
 * How long until a check is due: 0 when it is due now.
 *
 * @param {import('./state.js').SpecState | undefined} state
 * @param {number} now
 * @param {number} [gapMs]
 */
export function checkDueIn(state, now, gapMs = START_CHECK_GAP_MS) {
  if (!state) return 0;
  const inFlight = state.checkStartedAt === undefined ? 0 : state.checkStartedAt + CHECK_IN_FLIGHT_MS - now;
  const sinceCheck = state.checkedAt === undefined ? 0 : state.checkedAt + gapMs - now;
  return Math.max(0, (state.nextCheckAt ?? 0) - now, inFlight, sinceCheck);
}

/**
 * @param {import('./state.js').SpecState | undefined} state
 * @param {number} now
 * @param {number} [gapMs]
 */
export function isCheckDue(state, now, gapMs = START_CHECK_GAP_MS) {
  return checkDueIn(state, now, gapMs) === 0;
}

/** @param {number} failures consecutive failed checks, 1 or more */
export function backoffMs(failures) {
  return Math.min(START_CHECK_GAP_MS * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
}

/**
 * @typedef {object} UpdateContext
 * @property {import('./registry.js').Registry} registry
 * @property {import('./registry.js').PackageSpec} spec
 * @property {string} cacheDir
 * @property {string} dir     state folder
 * @property {string} key     state key
 * @property {import('./npm-cli.js').NpmCommand} npm
 * @property {string} [npmVersion]
 * @property {string} baseDir
 * @property {NodeJS.ProcessEnv} env
 * @property {NodeJS.Platform} platform
 * @property {string | undefined} tenant  given with --tenant
 * @property {number} tokenTimeoutMs
 * @property {Set<import('./npmrc.js').TempNpmrc>} temps
 * @property {typeof import('./tokens.js').acquireToken} acquire
 * @property {typeof import('./tenant.js').discoverTenant} discover
 * @property {typeof import('./resolve.js').resolveSpec} resolve
 * @property {typeof import('./proc.js').runCapture} [run]
 * @property {() => number} now
 * @property {import('./log.js').Logger} log
 */

/**
 * @typedef {{ outcome: 'current' | 'updated', version: string }
 *   | { outcome: 'skipped' | 'stopped', detail: string }
 *   | { outcome: 'failed', detail: string, signIn?: boolean, gone?: boolean }} CheckResult
 *   signIn: no token, or the feed refused it; gone: the feed has no version
 *   for the spec (any more), so the next start asks the feed
 */

/**
 * One background check: token, lookup, install of a newer version, record.
 *
 * @param {UpdateContext} ctx
 * @param {AbortSignal} signal
 * @returns {Promise<CheckResult>}
 */
export async function checkForUpdate(ctx, signal) {
  const { registry, spec, dir, key, log } = ctx;
  const base = { registry: registry.href, spec: spec.raw, name: spec.name };
  const debug = (/** @type {string} */ m) => log.debug(m);
  const started = readState(dir, key);
  if (started?.checkStartedAt !== undefined && ctx.now() - started.checkStartedAt < CHECK_IN_FLIGHT_MS) {
    return { outcome: 'skipped', detail: 'another process is checking' };
  }
  updateState(dir, key, base, (s) => {
    s.checkStartedAt = ctx.now();
  });
  const clear = () =>
    updateState(dir, key, base, (s) => {
      delete s.checkStartedAt;
    });
  /** @returns {CheckResult} */
  const stopped = () => {
    clear();
    return { outcome: 'stopped', detail: 'stopped' };
  };
  /** @param {string} detail @param {{ signIn?: boolean, gone?: boolean }} [how] @returns {CheckResult} */
  const failed = (detail, { signIn, gone } = {}) => {
    updateState(dir, key, base, (s) => {
      s.failures = (s.failures ?? 0) + 1;
      s.nextCheckAt = ctx.now() + backoffMs(s.failures);
      // The package, tag or version was removed from the feed (perhaps on
      // purpose): the copy in npm's cache must not keep starting.
      if (gone) s.missingAt = ctx.now();
      delete s.checkStartedAt;
    });
    return { outcome: 'failed', detail, ...(signIn ? { signIn } : {}), ...(gone ? { gone } : {}) };
  };

  try {
    const found = await feedTenant({ registry, tenant: ctx.tenant, env: ctx.env, dir, discover: ctx.discover, signal, now: ctx.now });
    if (signal.aborted) return stopped();
    // Offline, or the feed is down: a token would not help, and a failed
    // sign-in tool would only suggest signing in.
    if (found.error && !proxyBlocksFetch(ctx.env)) return failed(`could not reach ${registry.href}: ${found.error}`);

    /** @type {import('./tokens.js').AcquiredToken} */
    let acquired;
    try {
      acquired = await ctx.acquire({
        env: ctx.env,
        tenant: found.tenant,
        msa: !!found.msa,
        platform: ctx.platform,
        timeoutMs: ctx.tokenTimeoutMs,
        signal,
        debug,
        ...signInMemory(dir, found.tenant),
      });
    } catch (error) {
      if (error instanceof AbortedError || signal.aborted) return stopped();
      if (!(error instanceof TokenError)) throw error;
      if (found.remembered) {
        // No request was made: offline, the sign-in tools fail too, and
        // "sign in" would be the wrong advice.
        const probe = await ctx.discover(registry.href, { signal });
        if (signal.aborted) return stopped();
        if (probe.error && !proxyBlocksFetch(ctx.env)) return failed(`could not reach ${registry.href}: ${probe.error}`);
        found.forget();
      }
      return failed(`${error.message} ${error.hint}`.trim(), { signIn: true });
    }
    addSecret(acquired.token);

    /**
     * Only the lookup says that the spec is gone. An install step that fails
     * on the version the lookup gave keeps the copy in npm's cache starting.
     *
     * @param {import('./install.js').Failure} f
     * @param {boolean} lookup
     * @returns {CheckResult}
     */
    const failure = (f, lookup) => {
      if (f.kind === 'stopped' || signal.aborted) return stopped();
      if (f.kind === 'busy') {
        clear();
        return { outcome: 'skipped', detail: f.reason };
      }
      if (f.kind === 'auth' && found.remembered) found.forget();
      return failed(f.reason, { signIn: f.kind === 'auth', gone: lookup && f.kind === 'gone' });
    };
    const install = {
      npm: ctx.npm,
      registry,
      spec,
      token: acquired.token,
      cacheDir: ctx.cacheDir,
      dir,
      baseDir: ctx.baseDir,
      env: ctx.env,
      platform: ctx.platform,
      temps: ctx.temps,
      signal,
      run: ctx.run,
      debug,
    };
    const picked = await pickVersion(install, { resolve: ctx.resolve, npmVersion: ctx.npmVersion });
    if (!picked.ok) return failure(picked, true);
    const { version } = picked;

    if (readState(dir, key)?.version === version && isReadyToStart(ctx.cacheDir, registry.href, spec.name, version, { fullMetadata: !!npmPickOptions(ctx.env).before, listed: true })) {
      recordVersion(dir, key, base, version, { now: ctx.now(), created: false, repaired: false });
      return { outcome: 'current', version };
    }
    const pre = await preinstall(install, { version, ...(picked.metadataCached ? { cacheMode: /** @type {const} */ ('prefer-offline') } : {}) });
    if (!pre.ok) return failure(pre, false);
    recordVersion(dir, key, base, version, { now: ctx.now(), created: pre.created, repaired: pre.created });
    await collectGarbage({ cacheDir: ctx.cacheDir, dir, names: [spec.name], now: ctx.now(), debug });
    return { outcome: 'updated', version };
  } catch (error) {
    if (signal.aborted) return stopped();
    return failed(/** @type {Error} */ (error)?.message || String(error));
  }
}

/**
 * Resolves once the process has run `ms` without a freeze (a tick of a 1 s
 * timer arriving more than `freezeMs` late by either clock: the wall clock
 * counts sleep everywhere, the monotonic one only on some systems). Resolves
 * false when aborted.
 *
 * @param {number} ms
 * @param {AbortSignal} signal
 * @param {{ tickMs?: number, freezeMs?: number, wall?: () => number, mono?: () => number }} [opts]
 * @returns {Promise<boolean>}
 */
export function waitForSteadyRun(ms, signal, { tickMs = 1000, freezeMs = 20_000, wall = Date.now, mono = () => performance.now() } = {}) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    let lastWall = wall();
    let lastMono = mono();
    let calmSince = lastMono;
    const done = (/** @type {boolean} */ ok) => {
      clearInterval(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onAbort = () => done(false);
    const timer = setInterval(() => {
      const w = wall();
      const m = mono();
      const late = Math.max(w - lastWall, m - lastMono) - tickMs;
      lastWall = w;
      lastMono = m;
      if (late > freezeMs) calmSince = m;
      else if (m - calmSince >= ms) done(true);
    }, tickMs);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<boolean>} false when aborted
 */
function sleepUnref(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    t.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run checks for the life of a session: one soon when `checkNow` (after a
 * random delay of up to `firstDelayMs`), then one every `intervalMs`, unless
 * another session of the same spec checked meanwhile, after a steady run of
 * `settleMs`. `stop()` ends it (aborting a check in progress, which stops its
 * npm and removes its token file); `idle` resolves once nothing runs.
 *
 * @param {UpdateContext} ctx
 * @param {{ checkNow: boolean, intervalMs?: number, settleMs?: number, firstDelayMs?: number,
 *   random?: () => number, onResult?: (r: CheckResult) => void }} opts
 * @returns {{ stop: () => void, idle: Promise<void> }}
 */
export function startUpdates(ctx, { checkNow, intervalMs = PERIODIC_CHECK_MS, settleMs = SETTLE_MS, firstDelayMs = FIRST_CHECK_JITTER_MS, random = Math.random, onResult = () => {} }) {
  const ac = new AbortController();
  const { signal } = ac;
  const loop = async () => {
    if (checkNow && !(await sleepUnref(Math.floor(random() * firstDelayMs), signal))) return;
    // Another session of the spec may have checked during the delay.
    for (let first = checkNow && isCheckDue(readState(ctx.dir, ctx.key), ctx.now()); ; first = false) {
      if (!first) {
        if (!(await sleepUnref(intervalMs, signal))) return;
        for (let wait; (wait = checkDueIn(readState(ctx.dir, ctx.key), ctx.now(), intervalMs)) > 0; ) {
          if (!(await sleepUnref(Math.min(wait, intervalMs), signal))) return;
        }
        if (!(await waitForSteadyRun(settleMs, signal))) return;
      }
      const result = await checkForUpdate(ctx, signal);
      if (signal.aborted) return;
      onResult(result);
    }
  };
  const idle = loop().catch((error) => ctx.log.debug(`update check failed: ${error?.message || error}`));
  return { stop: () => ac.abort(), idle };
}
