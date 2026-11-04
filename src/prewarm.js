/**
 * `--prewarm`: install packages into npm's exec cache ahead of time (an image,
 * a dev container, a CI cache, a laptop before a flight), so that their next
 * start needs no token and no network.
 */

import { npmPickOptions } from './env.js';
import { collectGarbage } from './gc.js';
import { EXIT, feedTenant, INSTALL_WAIT_MS, pickVersion, preinstall, reportFailure } from './install.js';
import { addSecret } from './log.js';
import { signInNotice, unsupportedOrgNotice } from './messages.js';
import { writeNotice } from './notice.js';
import { readState, recordVersion, signInMemory, stateDir, stateKey } from './state.js';
import { signalExitCode } from './supervisor.js';
import { AbortedError, TokenError } from './tokens.js';

/**
 * @typedef {object} PrewarmOptions
 * @property {import('./registry.js').Registry} registry
 * @property {import('./registry.js').PackageSpec[]} specs
 * @property {string | undefined} tenant
 * @property {import('./npm-cli.js').NpmCommand} npm
 * @property {string | undefined} npmVersion
 * @property {string} baseDir
 * @property {string} cacheDir
 * @property {NodeJS.ProcessEnv} env
 * @property {NodeJS.Platform} platform
 * @property {import('./log.js').Logger} log
 * @property {{ write: (s: string) => void, isTTY: boolean, columns?: number }} noticeStream
 * @property {typeof import('./tenant.js').discoverTenant} discover
 * @property {typeof import('./tokens.js').acquireToken} acquire
 * @property {typeof import('./resolve.js').resolveSpec} resolve
 * @property {() => number} now
 * @property {number} tokenTimeoutMs
 * @property {typeof import('./proc.js').runCapture} [run]
 * @property {Pick<NodeJS.Process, 'on' | 'off'>} [signals]
 */

/**
 * Each spec is resolved like a start resolves it, installed without running
 * it, and recorded as the version its next start runs.
 *
 * @param {PrewarmOptions} o
 * @returns {Promise<number>} exit code: 0, or the first failure's
 */
export async function runPrewarm(o) {
  const { registry, env, platform, log, cacheDir, signals = process } = o;
  const debug = (/** @type {string} */ m) => log.debug(m);
  const dir = stateDir(cacheDir);
  const ac = new AbortController();
  /** @type {Set<import('./npmrc.js').TempNpmrc>} */
  const temps = new Set();
  /** @type {NodeJS.Signals | undefined} */
  let received;
  const onSignal = (/** @type {NodeJS.Signals} */ sig) => {
    received ??= sig;
    for (const t of temps) t.cleanup();
    ac.abort();
  };
  /** @type {NodeJS.Signals[]} */
  const handled = platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const s of handled) signals.on(s, onSignal);
  const interrupted = () => signalExitCode(received ?? 'SIGINT');
  try {
    const found = await feedTenant({ registry, tenant: o.tenant, env, dir, discover: o.discover, signal: ac.signal, now: o.now });
    if (ac.signal.aborted) return interrupted();
    /** @type {import('./tokens.js').AcquiredToken} */
    let acquired;
    try {
      acquired = await o.acquire({
        env,
        tenant: found.tenant,
        msa: !!found.msa,
        platform,
        timeoutMs: o.tokenTimeoutMs,
        signal: ac.signal,
        debug,
        ...signInMemory(dir, found.tenant),
      });
    } catch (error) {
      if (error instanceof AbortedError) return interrupted();
      if (!(error instanceof TokenError)) throw error;
      if (found.remembered) found.forget();
      if (found.msa) writeNotice(o.noticeStream, unsupportedOrgNotice({ hint: error.hint }), env);
      else if (error.attempts.length === 0) log.error(`${error.message} ${error.hint}`);
      else writeNotice(o.noticeStream, signInNotice({ feed: registry.href, tenant: found.tenant, attempts: error.attempts, env, platform }), env);
      return EXIT.NO_TOKEN;
    }
    addSecret(acquired.token);

    let code = 0;
    /** @type {Set<string>} */
    const names = new Set();
    for (const spec of o.specs) {
      if (ac.signal.aborted) return interrupted();
      /** @param {import('./install.js').Failure} f */
      const report = (f) => {
        if (f.kind === 'auth' && found.remembered) found.forget();
        const c = reportFailure(f, { spec, registry, claims: acquired.claims, tenant: found.tenant, env, platform, log, noticeStream: o.noticeStream, action: 'install' });
        code ||= c;
      };
      const ctx = { npm: o.npm, registry, spec, token: acquired.token, cacheDir, dir, baseDir: o.baseDir, env, platform, temps, signal: ac.signal, run: o.run, debug };
      const picked = await pickVersion(ctx, { resolve: o.resolve, npmVersion: o.npmVersion });
      if (!picked.ok) {
        if (picked.kind === 'stopped' || ac.signal.aborted) return interrupted();
        report(picked);
        continue;
      }
      const { version } = picked;
      const key = stateKey(registry.href, spec.raw, npmPickOptions(env));
      const state = readState(dir, key);
      // The copy of this version failed at start: install it again.
      const reinstall = !!state?.offlineFailedAt && state.version === version;
      const pre = await preinstall(ctx, { version, waitMs: INSTALL_WAIT_MS, reinstall });
      if (!pre.ok) {
        if (pre.kind === 'stopped' || ac.signal.aborted) return interrupted();
        report(pre);
        continue;
      }
      recordVersion(dir, key, { registry: registry.href, spec: spec.raw, name: spec.name }, version, {
        now: o.now(),
        created: pre.created,
        repaired: !reinstall || pre.created,
        used: true,
      });
      names.add(spec.name);
      log.info(`${pre.created ? 'installed' : "already in npm's cache:"} ${spec.name}@${version}`);
    }
    if (names.size > 0) await collectGarbage({ cacheDir, dir, names: [...names], now: o.now(), debug });
    return code;
  } finally {
    for (const s of handled) signals.off(s, onSignal);
    const left = [...temps].filter((t) => !t.cleanup());
    if (left.length) log.error(`could not remove ${left.map((t) => t.dir).join(', ')}; delete it manually`);
  }
}
