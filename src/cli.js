/**
 * ado-npm-exec: run a package from a private Azure Artifacts npm feed. A
 * version npm already installed starts from npm's cache with no token and no
 * request. Otherwise a silently acquired Entra ID token picks the exact
 * version and installs it under its install lock, and it starts the same way.
 * Never writes to stdout and never reads stdin.
 */

import fs from 'node:fs';
import tty from 'node:tty';
import { resolveTopLaunchShim } from './ancestry.js';
import { parseArgs, UsageError, USAGE } from './args.js';
import { runDoctor } from './doctor.js';
import { buildInnerEnv, npmPickOptions } from './env.js';
import { collectGarbage } from './gc.js';
import { claimCached, EXIT, feedTenant, INSTALL_WAIT_MS, pickVersion, preinstall, recoverInterrupted, reportFailure } from './install.js';
import { addSecret, createLogger } from './log.js';
import { runLogin } from './login.js';
import { signInNotice, unsupportedOrgNotice } from './messages.js';
import { findCachedStart, npmCacheDir } from './npm-cache.js';
import { npmVersionOf, resolveNpm } from './npm-cli.js';
import { chooseBaseDir, createTempNpmrc, findShadowingBin, renderNpmrc, sweepStaleTempDirs, UnsafeTempError } from './npmrc.js';
import { writeNotice } from './notice.js';
import { runPrewarm } from './prewarm.js';
import { getEnv } from './proc.js';
import { parseSpec, RegistryError, SpecError, validateRegistryUrl } from './registry.js';
import { resolveSpec } from './resolve.js';
import { buildNpmArgv, scriptShellFlags, spawnNpm, waitForExit } from './run.js';
import { classifyWanted } from './semver.js';
import { LEASE_HEARTBEAT_MS, readState, recordVersion, signInMemory, stateDir, stateKey, updateState, writeLease } from './state.js';
import { createSupervisor, signalExitCode } from './supervisor.js';
import { discoverTenant, isGuid } from './tenant.js';
import { acquireToken, AbortedError, timeoutFromEnv, TokenError } from './tokens.js';
import { npmForwardsSignals } from './tree.js';
import { isCheckDue, startUpdates } from './update.js';

/** A start from npm's cache that fails sooner than this makes the next start ask the feed. */
const QUICK_FAILURE_MS = 10_000;
/** While a session has no lease (it could not be written), it tries again this often. */
const LEASE_RETRY_MS = 30_000;

/**
 * @typedef {object} MainResult
 * @property {number} code  exit code to use
 * @property {NodeJS.Signals} [signal]  re-raise this signal instead (POSIX)
 */

/**
 * @typedef {object} MainDeps
 * @property {NodeJS.ProcessEnv} [env]
 * @property {NodeJS.Platform} [platform]
 * @property {(s: string) => void} [writeErr]
 * @property {boolean} [stderrIsTTY]  whether notices may use color
 * @property {boolean} [stdinIsTTY]  whether stdin is a terminal (--login signs in interactively)
 * @property {(input: string | undefined) => import('./registry.js').Registry} [validateRegistry]
 *   Test seam for running against a localhost registry; never reachable from the command line.
 * @property {typeof discoverTenant} [discover]
 * @property {typeof acquireToken} [acquire]
 * @property {typeof resolveSpec} [resolve]
 * @property {typeof resolveNpm} [findNpm]
 * @property {typeof spawnNpm} [spawn]
 * @property {string} [tmpdir]  base directory for the temp npmrc (default: a trusted one, see chooseBaseDir)
 * @property {Pick<NodeJS.Process, 'on' | 'off'>} [signals]
 * @property {number} [parentWatchMs]  how often to check whether our parent exited (0 disables)
 * @property {number} [stageMs]  after a signal, when to signal processes npm did not pass it to
 * @property {number} [killAfterMs]  after a signal, when to SIGKILL whatever is left
 * @property {number} [leaseRetryMs]  how often a session without a lease tries to write it
 * @property {() => number} [now]
 * @property {() => number} [random]  for the delays that spread out servers started together
 * @property {typeof startUpdates} [updates]  background updates of a cached start
 * @property {typeof resolveTopLaunchShim} [topShim]
 * @property {typeof runLogin} [login]
 * @property {typeof runDoctor} [doctor]
 * @property {typeof runPrewarm} [prewarm]
 */

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

/**
 * @param {readonly string[]} argv
 * @param {MainDeps} [deps]
 * @returns {Promise<MainResult>}
 */
export async function main(argv, deps = {}) {
  const {
    env = process.env,
    platform = process.platform,
    writeErr = (s) => void process.stderr.write(s),
    stderrIsTTY = !!process.stderr.isTTY,
    stdinIsTTY = tty.isatty(0),
    validateRegistry = validateRegistryUrl,
    discover = discoverTenant,
    acquire = acquireToken,
    resolve = resolveSpec,
    findNpm = resolveNpm,
    tmpdir,
    now = Date.now,
    login = runLogin,
    doctor = runDoctor,
    prewarm = runPrewarm,
  } = deps;

  /** @type {import('./args.js').ParsedArgs} */
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    writeErr(`ado-npm-exec: ${error.message}\n\n${USAGE}`);
    return { code: EXIT.USAGE };
  }
  if (parsed.help) {
    writeErr(USAGE);
    return { code: 0 };
  }
  if (parsed.version) {
    writeErr(`${readVersion()}\n`);
    return { code: 0 };
  }

  const log = createLogger({ verbose: parsed.verbose || getEnv(env, 'ADO_NPM_EXEC_VERBOSE') === '1', write: writeErr });
  /** Where framed notices go: our stderr, colored only on a terminal. */
  const noticeStream = { write: (/** @type {string} */ s) => writeErr(s), isTTY: stderrIsTTY, columns: process.stderr.columns };

  let tenant = parsed.tenant ?? getEnv(env, 'ADO_NPM_EXEC_TENANT') ?? undefined;
  if (tenant !== undefined && tenant !== '') {
    if (!isGuid(tenant)) {
      log.error(`invalid tenant ${JSON.stringify(tenant)}: expected a GUID`);
      return { code: EXIT.USAGE };
    }
    tenant = tenant.toLowerCase();
  } else {
    tenant = undefined;
  }

  if (parsed.action === 'doctor') {
    const code = await doctor({ parsed, tenant, env, platform, write: writeErr, validateRegistry, discover, acquire, resolve, findNpm, tmpdir, now });
    return { code };
  }

  /** @type {import('./registry.js').Registry} */
  let registry;
  /** @type {import('./registry.js').PackageSpec[]} */
  let specs = [];
  try {
    registry = validateRegistry(parsed.registry);
    if (parsed.action !== 'login') specs = [parsed.spec ?? '', ...(parsed.action === 'prewarm' ? parsed.args : [])].map((s) => parseSpec(s));
  } catch (error) {
    if (!(error instanceof RegistryError || error instanceof SpecError)) throw error;
    log.error(error.message);
    return { code: EXIT.USAGE };
  }

  const cacheDir = npmCacheDir(env, { platform });
  if (parsed.action === 'login') {
    const code = await login({ registry, tenant, env, platform, log, noticeStream, discover, acquire, dir: cacheDir && stateDir(cacheDir), stdinIsTTY, stderrIsTTY });
    return { code };
  }

  // Fail fast, before the slow token acquisition, on anything local.
  const npm = findNpm({ env, platform });
  if (!npm) {
    log.error("could not locate npm's npm-cli.js; make sure npm is installed with Node.js.");
    return { code: EXIT.NPM };
  }
  /** @type {string} */
  let baseDir;
  try {
    baseDir = tmpdir ?? chooseBaseDir({ platform, env });
  } catch (error) {
    if (!(error instanceof UnsafeTempError)) throw error;
    log.error(error.message);
    return { code: EXIT.INTERNAL };
  }
  if (!cacheDir) {
    log.error("npm's cache folder cannot be determined: set npm_config_cache to an absolute path.");
    return { code: EXIT.INTERNAL };
  }
  const npmVersion = npmVersionOf(npm.cli);

  if (parsed.action === 'prewarm') {
    sweep(baseDir, log);
    const code = await prewarm({
      registry,
      specs,
      tenant,
      npm,
      npmVersion,
      baseDir,
      cacheDir,
      env,
      platform,
      log,
      noticeStream,
      discover,
      acquire,
      resolve,
      now,
      tokenTimeoutMs: timeoutFromEnv(env),
    });
    return { code };
  }

  return launch({ deps, parsed, registry, spec: specs[0], tenant, npm, npmVersion, baseDir, cacheDir, log, noticeStream });
}

/**
 * Remove token folders a crashed run left behind.
 *
 * @param {string} baseDir
 * @param {import('./log.js').Logger} log
 */
function sweep(baseDir, log) {
  const swept = sweepStaleTempDirs(baseDir);
  if (swept > 0) log.debug(`removed ${swept} stale temp director${swept === 1 ? 'y' : 'ies'} from ${baseDir}`);
}

/**
 * @typedef {{ result?: { code: number | null, signal: NodeJS.Signals | null }, startedAt: number, early?: MainResult }} Ran
 */

/**
 * Start the package and supervise npm until it exits.
 *
 * @param {{ deps: MainDeps, parsed: import('./args.js').ParsedArgs, registry: import('./registry.js').Registry,
 *   spec: import('./registry.js').PackageSpec, tenant: string | undefined, npm: import('./npm-cli.js').NpmCommand,
 *   npmVersion: string | undefined, baseDir: string, cacheDir: string, log: import('./log.js').Logger,
 *   noticeStream: { write: (s: string) => void, isTTY: boolean, columns?: number } }} c
 * @returns {Promise<MainResult>}
 */
async function launch(c) {
  const { deps, parsed, registry, spec, npm, npmVersion, baseDir, cacheDir, log, noticeStream } = c;
  const {
    env = process.env,
    platform = process.platform,
    discover = discoverTenant,
    acquire = acquireToken,
    resolve = resolveSpec,
    spawn = spawnNpm,
    signals = process,
    parentWatchMs = 1000,
    stageMs = 1000,
    killAfterMs = 5000,
    leaseRetryMs = LEASE_RETRY_MS,
    now = Date.now,
    random = Math.random,
    updates = startUpdates,
    topShim = resolveTopLaunchShim,
  } = deps;
  const debug = (/** @type {string} */ m) => log.debug(m);

  const alwaysFresh = parsed.alwaysFresh || getEnv(env, 'ADO_NPM_EXEC_ALWAYS_FRESH') === '1';
  const offlineFallback = parsed.offlineFallback ?? getEnv(env, 'ADO_NPM_EXEC_OFFLINE_FALLBACK') !== '0';
  const pick = npmPickOptions(env);
  const wanted = classifyWanted(spec.range ?? '');
  const exact = wanted?.type === 'version' ? wanted.version : undefined;
  const dir = stateDir(cacheDir);
  const key = stateKey(registry.href, spec.raw, pick);
  const base = { registry: registry.href, spec: spec.raw, name: spec.name };
  const state = readState(dir, key);
  // With npm's `before` setting, npm decides every version, an exact one too.
  const remembered = pick.before ? undefined : (exact ?? state?.version);
  if (remembered) await recoverInterrupted({ cacheDir, dir, registryHref: registry.href, name: spec.name, version: remembered, debug });
  const cached = pick.before ? undefined : findCachedStart({ cacheDir, registry, spec, exact, state });
  const fallback = offlineFallback && !state?.missingAt ? cached : undefined;

  const sup = createSupervisor({ platform, env, forwards: npmForwardsSignals(npm.cli), signals, parentWatchMs, stageMs, killAfterMs, topShim, random, log });
  /** @returns {MainResult} */
  const stopped = () => {
    const signal = sup.received() ?? 'SIGTERM';
    return { code: signalExitCode(signal), signal };
  };
  /** @type {{ stop: () => void, idle: Promise<void> } | undefined} */
  let background;
  sup.onStop(() => background?.stop());
  /** @type {import('./state.js').Lease | undefined} */
  let lease;
  /** @type {{ version: string, pids: number[] } | undefined} */
  let claimed;
  /** @type {NodeJS.Timeout | undefined} */
  let heartbeat;
  /** Whether cleanup runs once npm started (a start of a new version). */
  let collect = false;

  /**
   * Claim the version this session runs, so that cleanup keeps its folder.
   * A lease that cannot be written (a full disk) is tried again every
   * LEASE_RETRY_MS: until then, cleanup in another process could remove it.
   *
   * @param {string} version
   */
  const claim = (version) => {
    const previous = lease;
    claimed = { version, pids: [] };
    lease = writeLease(dir, { name: spec.name, version });
    previous?.release();
    if (!lease) log.info(`could not write a session lease in ${dir}; trying again every ${Math.round(leaseRetryMs / 1000)} s`);
    clearInterval(heartbeat);
    const tick = () => {
      if (lease) return lease.heartbeat();
      if (!claimed) return;
      lease = writeLease(dir, { name: spec.name, version: claimed.version, pids: claimed.pids });
      if (!lease) return;
      log.debug(`wrote the session lease ${lease.file}`);
      clearInterval(heartbeat);
      heartbeat = setInterval(tick, LEASE_HEARTBEAT_MS);
      heartbeat.unref();
    };
    heartbeat = setInterval(tick, lease ? LEASE_HEARTBEAT_MS : leaseRetryMs);
    heartbeat.unref();
  };
  /** The server's npm uses the version too: its lease stays live while npm runs. @param {number | undefined} pid */
  const claimPid = (pid) => {
    if (pid === undefined || !claimed) return;
    claimed.pids.push(pid);
    lease?.addPid(pid);
  };

  /**
   * Run `npm exec --offline <runSpec>` and wait for it. Its npmrc only
   * routes the package to the feed: the server never sees a token.
   *
   * @param {string} runSpec
   * @returns {Promise<Ran>}
   */
  const runNpm = async (runSpec) => {
    const temp = createTempNpmrc(renderNpmrc({ registry, scope: spec.scope }), { tmpdir: baseDir });
    sup.temps.add(temp);
    if (sup.received()) return { startedAt: 0, early: stopped() };
    // npm runs `<dir>/node_modules/.bin/<spec>` from the temp dir or any parent
    // directory instead of the package, if such a file exists.
    const shadow = findShadowingBin(temp.dir, runSpec);
    if (shadow) {
      log.error(`refusing to run: npm would execute ${shadow} instead of ${runSpec} from the feed. Remove that file.`);
      return { startedAt: 0, early: { code: EXIT.INTERNAL } };
    }
    const innerEnv = buildInnerEnv(env, { npmrcFile: temp.file, registryHost: registry.host, scope: spec.scope, platform, execPath: npm.node });
    const argv = buildNpmArgv({
      cli: npm.cli,
      prefixDir: temp.dir,
      registryHref: registry.href,
      cacheDir,
      spec: runSpec,
      args: parsed.args,
      cacheMode: 'offline',
      extraFlags: scriptShellFlags(innerEnv, platform),
    });
    log.debug(`running ${npm.node} ${argv.join(' ')}`);
    const startedAt = now();
    try {
      const child = spawn({ node: npm.node, argv, env: innerEnv });
      sup.attach(child);
      claimPid(child.pid);
      setImmediate(() => {
        sweep(baseDir, log);
        // Older versions this tool installed that nothing uses any more.
        if (collect) collectGarbage({ cacheDir, dir, names: [spec.name], now: now(), debug }).catch((error) => log.debug(`cleanup failed: ${error?.message}`));
      });
      return { result: await waitForExit(child), startedAt };
    } catch (error) {
      log.error(`failed to start npm: ${/** @type {Error} */ (error).message}`);
      return { startedAt, early: { code: EXIT.NPM } };
    }
  };

  /** @param {boolean} checkNow */
  const startBackground = (checkNow) => {
    if (exact) return;
    background = updates(
      {
        registry,
        spec,
        cacheDir,
        dir,
        key,
        npm,
        npmVersion,
        baseDir,
        env,
        platform,
        tenant: c.tenant,
        tokenTimeoutMs: timeoutFromEnv(env),
        temps: sup.temps,
        acquire,
        discover,
        resolve,
        now,
        log,
      },
      {
        checkNow,
        random,
        onResult: (r) => {
          if (r.outcome === 'updated') log.info(`installed ${spec.name}@${r.version} in the background; the next start uses it`);
          else if (r.outcome === 'failed' && r.gone) log.info(`${spec.raw}: ${r.detail}; the next start asks the feed`);
          else if (r.outcome === 'failed' && r.signIn) log.info(`could not check for a newer ${spec.name}: ${r.detail}`);
          else log.debug(`update check: ${r.outcome}${'detail' in r ? `: ${r.detail}` : ''}${'version' in r ? ` ${r.version}` : ''}`);
        },
      },
    );
  };

  /**
   * Start from npm's cache, without a token. The session lease is written
   * under the version's install lock (see claimCached).
   *
   * @param {{ runSpec: string, version: string }} start
   * @param {{ why: string, info?: string, checkForUpdates?: boolean }} how  info: told once the copy is sure to start
   * @returns {Promise<Ran | undefined>} undefined: the copy cannot start now
   */
  const startCached = async (start, { why, info, checkForUpdates = false }) => {
    const claim1 = await claimCached({ cacheDir, dir, registryHref: registry.href, name: spec.name, version: start.version, signal: sup.signal, debug }, () =>
      claim(start.version),
    );
    if (claim1 !== 'ready') {
      log.debug(claim1 === 'busy' ? `another process installs or removes ${start.runSpec}` : `the copy of ${start.runSpec} in npm's cache is gone`);
      clearInterval(heartbeat);
      lease?.release();
      lease = undefined;
      claimed = undefined;
      return undefined;
    }
    if (info) log.info(info);
    log.debug(`starting ${start.runSpec} from npm's cache (${why})`);
    updateState(dir, key, base, (s) => {
      s.usedAt = now();
      // A pinned version is recorded too, so that cleanup keeps it.
      s.version = start.version;
    });
    if (checkForUpdates) startBackground(isCheckDue(state, now()));
    return runNpm(start.runSpec);
  };

  /**
   * Ask the feed: tenant, token, the exact version, its locked install. Then
   * start that version from npm's cache.
   *
   * @returns {Promise<{ exit: MainResult } | { ran: Ran, fromCache: boolean }>}
   */
  const startOnline = async () => {
    const found = await feedTenant({ registry, tenant: c.tenant, env, dir, discover, signal: sup.signal, now });
    if (sup.received()) return { exit: stopped() };
    const tenant = found.tenant;
    log.debug(
      tenant
        ? `tenant ${tenant}${found.remembered ? ' (remembered)' : c.tenant ? '' : " (from the feed's answer)"}`
        : `tenant unknown${found.msa ? ' (organization is not backed by Entra ID)' : ''}${found.error ? `: ${found.error}` : ''}`,
    );

    /** @type {import('./tokens.js').AcquiredToken} */
    let acquired;
    try {
      acquired = await acquire({ env, tenant, msa: !!found.msa, platform, timeoutMs: timeoutFromEnv(env), signal: sup.signal, debug, ...signInMemory(dir, tenant) });
    } catch (error) {
      if (error instanceof AbortedError && sup.received()) return { exit: stopped() };
      if (!(error instanceof TokenError)) throw error;
      if (found.remembered) found.forget();
      if (fallback) {
        const info = `${error.message} Starting the copy of ${fallback.runSpec} in npm's cache instead.${error.hint ? ` ${error.hint}` : ''}`;
        const ran = await startCached(fallback, { why: 'no token', info });
        if (ran) return { ran, fromCache: true };
      }
      if (found.msa) {
        writeNotice(noticeStream, unsupportedOrgNotice({ hint: error.hint }), env);
      } else if (error.attempts.length === 0) {
        // ADO_NPM_EXEC_TOKEN was set but is not usable.
        log.error(error.message);
        if (error.hint) log.error(error.hint);
      } else {
        writeNotice(noticeStream, signInNotice({ feed: registry.href, tenant, attempts: error.attempts, env, platform }), env);
      }
      return { exit: { code: EXIT.NO_TOKEN } };
    }
    addSecret(acquired.token);
    const { claims } = acquired;
    const exp = typeof claims.exp === 'number' ? Math.round((claims.exp * 1000 - Date.now()) / 60000) : '?';
    log.debug(`token from ${acquired.source} (tenant ${claims.tid ?? 'unknown'}, expires in ${exp} min)`);

    /**
     * Start the copy in npm's cache instead, unless the feed gave a final
     * answer (it refused the token, or has no such version); else report.
     *
     * @param {import('./install.js').Failure} f
     * @returns {Promise<{ exit: MainResult } | { ran: Ran, fromCache: boolean }>}
     */
    const failed = async (f) => {
      if (f.kind === 'stopped' || sup.received()) return { exit: stopped() };
      if (f.kind === 'auth' && found.remembered) found.forget();
      if (fallback && f.kind !== 'auth' && f.kind !== 'gone') {
        const what = f.kind === 'network' ? `could not reach ${registry.href} (${f.reason})` : f.reason;
        const ran = await startCached(fallback, { why: 'the feed cannot be used now', info: `${what}; starting the copy of ${fallback.runSpec} in npm's cache instead` });
        if (ran) return { ran, fromCache: true };
      }
      return { exit: { code: reportFailure(f, { spec, registry, claims, tenant, env, platform, log, noticeStream }) } };
    };

    const ctx = { npm, registry, spec, token: acquired.token, cacheDir, dir, baseDir, env, platform, temps: sup.temps, signal: sup.signal, debug };
    const picked = await pickVersion(ctx, { resolve, npmVersion, npmWhenUnanswered: !fallback });
    if (!picked.ok) return failed(picked);
    const { version } = picked;
    // The copy of this version failed at once last time: install it again.
    const reinstall = !!state?.offlineFailedAt && state.version === version;
    const pre = await preinstall(ctx, {
      version,
      waitMs: INSTALL_WAIT_MS,
      ownLeases: [lease?.file],
      reinstall,
      onReady: () => claim(version),
    });
    if (!pre.ok) return failed(pre);
    recordVersion(dir, key, base, version, { now: now(), created: pre.created, repaired: pre.created, used: true });
    collect = state?.version !== version;
    startBackground(false);
    return { ran: await runNpm(`${spec.name}@${version}`), fromCache: false };
  };

  try {
    log.debug(`feed ${registry.href}, package ${spec.raw}`);
    /** @type {Ran | undefined} */
    let ran;
    let fromCache = false;
    if (cached && !alwaysFresh && !state?.offlineFailedAt && !state?.missingAt) {
      ran = await startCached(cached, { why: 'no token needed', checkForUpdates: true });
      fromCache = !!ran;
    }
    if (!ran) {
      const online = await startOnline();
      if ('exit' in online) return online.exit;
      ({ ran, fromCache } = online);
    }
    if (ran.early) return ran.early;
    const result = /** @type {NonNullable<Ran['result']>} */ (ran.result);
    log.debug(`npm exited with ${result.signal ?? result.code}`);
    if (fromCache && !sup.received() && (result.signal || result.code !== 0) && now() - ran.startedAt < QUICK_FAILURE_MS) {
      // Perhaps npm's cache was cleaned or written by another npm version:
      // the next start asks the feed and installs the version again.
      updateState(dir, key, base, (s) => {
        s.offlineFailedAt = now();
      });
      log.info(`the copy in npm's cache exited at once with ${result.signal ?? result.code}; the next start asks the feed`);
    }
    await sup.settle();
    if (result.signal) return { code: signalExitCode(result.signal), signal: result.signal };
    return { code: result.code ?? EXIT.INTERNAL };
  } catch (error) {
    log.error(`unexpected error: ${/** @type {Error} */ (error)?.stack || error}`);
    return { code: EXIT.INTERNAL };
  } finally {
    if (background) {
      background.stop();
      await background.idle;
    }
    clearInterval(heartbeat);
    lease?.release();
    if (!sup.dispose()) log.error(`could not remove ${[...sup.temps].map((t) => t.dir).join(', ')}; delete it manually`);
  }
}
