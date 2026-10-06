/**
 * ado-npm-exec: run a package from a private Azure Artifacts npm feed.
 *
 * Flow: validate the feed URL against the allowlist, acquire a Microsoft
 * Entra ID token silently, write it to a private temp npmrc, then run
 * `npm exec` against the feed with inherited stdio and propagate its exit.
 * This process never writes to stdout and never reads stdin.
 */

import fs from 'node:fs';
import os from 'node:os';
import tty from 'node:tty';
import { parseArgs, UsageError, USAGE } from './args.js';
import { buildInnerEnv } from './env.js';
import { addSecret, createLogger } from './log.js';
import { resolveNpm } from './npm-cli.js';
import { chooseBaseDir, createTempNpmrc, findShadowingBin, renderNpmrc, sweepStaleTempDirs, UnsafeTempError } from './npmrc.js';
import { getEnv, killProcessTree } from './proc.js';
import { parseSpec, RegistryError, SpecError, validateRegistryUrl } from './registry.js';
import { buildNpmArgv, spawnNpm, waitForExit } from './run.js';
import { discoverTenant, isGuid } from './tenant.js';
import { acquireToken, AbortedError, DEFAULT_TIMEOUT_MS, TokenError } from './tokens.js';
import { descendantsOf, isAlive, npmForwardsSignals, readProcessTable, signalPid } from './tree.js';

export const EXIT = Object.freeze({ INTERNAL: 1, USAGE: 2, NO_TOKEN: 3, NPM: 4 });

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
 * @property {(input: string | undefined) => import('./registry.js').Registry} [validateRegistry]
 *   Test seam for running against a localhost registry; never reachable from the command line.
 * @property {typeof discoverTenant} [discover]
 * @property {typeof acquireToken} [acquire]
 * @property {typeof resolveNpm} [findNpm]
 * @property {typeof spawnNpm} [spawn]
 * @property {string} [tmpdir]  base directory for the temp npmrc (default: a trusted one, see chooseBaseDir)
 * @property {Pick<NodeJS.Process, 'on' | 'off'>} [signals]
 * @property {number} [parentWatchMs]  how often to check whether our parent exited (0 disables)
 * @property {number} [stageMs]  after a signal, when to signal processes npm did not forward it to
 * @property {number} [killAfterMs]  after a signal, when to SIGKILL whatever is left
 */

/** @param {NodeJS.Signals} signal */
function signalExitCode(signal) {
  return 128 + (os.constants.signals[signal] ?? 0);
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

/** @param {NodeJS.ProcessEnv} env */
function timeoutFromEnv(env) {
  const raw = getEnv(env, 'ADO_NPM_EXEC_TIMEOUT_MS');
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 1000 && n <= 120_000 ? n : DEFAULT_TIMEOUT_MS;
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
    validateRegistry = validateRegistryUrl,
    discover = discoverTenant,
    acquire = acquireToken,
    findNpm = resolveNpm,
    spawn = spawnNpm,
    tmpdir,
    signals = process,
    parentWatchMs = 1000,
    stageMs = 1000,
    killAfterMs = 5000,
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

  /** @type {import('./registry.js').Registry} */
  let registry;
  /** @type {import('./registry.js').PackageSpec} */
  let spec;
  try {
    registry = validateRegistry(parsed.registry);
    spec = parseSpec(parsed.spec);
  } catch (error) {
    if (!(error instanceof RegistryError || error instanceof SpecError)) throw error;
    log.error(error.message);
    return { code: EXIT.USAGE };
  }

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
  const swept = sweepStaleTempDirs(baseDir);
  if (swept > 0) log.debug(`removed ${swept} stale temp director${swept === 1 ? 'y' : 'ies'} from ${baseDir}`);

  // Shutdown. Before npm starts, a signal cancels token acquisition. After,
  // the token file is removed first (the client may follow up with SIGKILL),
  // then npm's process tree is stopped in stages:
  //   1. npm, plus its direct children when this npm does not forward signals
  //      (npm 10.2 traps SIGINT/SIGTERM and ignores them);
  //   2. after stageMs, any other process of the tree that is still running
  //      (launchers that do not forward, install scripts);
  //   3. after killAfterMs, SIGKILL for whatever is left. A second signal
  //      does this immediately.
  // If our parent exits (an MCP client killed `npm exec` and npm did not
  // forward the signal), the same shutdown runs.
  const abort = new AbortController();
  const forwards = npmForwardsSignals(npm.cli);
  /** @type {import('./npmrc.js').TempNpmrc | undefined} */
  let temp;
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  /** @type {NodeJS.Signals | undefined} */
  let received;
  let shutdownAt = 0;
  /** @type {Set<number>} */
  const tracked = new Set();
  /** @type {NodeJS.Timeout[]} */
  const timers = [];

  const snapshot = () => {
    const pid = child?.pid;
    if (pid === undefined) return { direct: /** @type {number[]} */ ([]), all: /** @type {number[]} */ ([]) };
    const tree = descendantsOf(pid, readProcessTable(platform));
    tracked.add(pid);
    for (const p of tree.all) tracked.add(p);
    return tree;
  };
  const killTracked = () => {
    snapshot();
    for (const pid of tracked) if (isAlive(pid)) signalPid(pid, 'SIGKILL');
  };
  const stopChild = (/** @type {NodeJS.Signals} */ sig, /** @type {boolean} */ alreadyDelivered) => {
    const pid = child?.pid;
    if (pid === undefined) return;
    if (platform === 'win32') {
      // No POSIX signals: Ctrl+C reaches npm through the console window, and
      // only a vanished parent needs the tree killed (see the watchdog).
      return;
    }
    const term = sig === 'SIGHUP' ? 'SIGTERM' : sig;
    const tree = snapshot();
    const firstWave = new Set([pid, ...tree.direct]);
    if (!alreadyDelivered) {
      if (child?.exitCode === null && child.signalCode === null) signalPid(pid, term);
      if (!forwards) for (const p of tree.direct) signalPid(p, term);
    }
    timers.push(
      setTimeout(() => {
        snapshot();
        for (const p of tracked) if (!firstWave.has(p) && isAlive(p)) signalPid(p, term);
      }, stageMs),
      setTimeout(killTracked, killAfterMs),
    );
  };
  const onSignal = (/** @type {NodeJS.Signals} */ sig) => {
    temp?.cleanup();
    if (received) {
      if (child && platform !== 'win32') killTracked();
      return;
    }
    received = sig;
    shutdownAt = Date.now();
    if (!child) {
      abort.abort();
      return;
    }
    // A terminal's Ctrl+C has already reached every process in our group.
    stopChild(sig, sig === 'SIGINT' && tty.isatty(0));
  };
  /** @type {NodeJS.Signals[]} */
  const handled = platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const s of handled) signals.on(s, onSignal);
  const exitHook = () => temp?.cleanup();
  process.on('exit', exitHook);

  const parentPid = process.ppid;
  const watchdog =
    parentWatchMs > 0 && parentPid > 1
      ? setInterval(() => {
          const gone = platform === 'win32' ? !isAlive(parentPid) : process.ppid !== parentPid;
          if (!gone) return;
          clearInterval(watchdog);
          log.debug('the parent process exited; shutting down');
          if (platform !== 'win32') return onSignal('SIGTERM');
          temp?.cleanup();
          received ??= 'SIGTERM';
          if (child) killProcessTree(child, platform, env);
          else abort.abort();
        }, parentWatchMs)
      : undefined;
  watchdog?.unref();

  try {
    log.debug(`feed ${registry.href}, package ${spec.raw}`);
    let msa = false;
    if (!tenant && !getEnv(env, 'ADO_NPM_EXEC_TOKEN')) {
      const found = await discover(registry.href, { signal: abort.signal });
      tenant = found.tenant;
      msa = !!found.msa;
      log.debug(
        found.tenant
          ? `tenant ${found.tenant} (from the feed's 401 response)`
          : `tenant unknown${found.msa ? ' (organization is not backed by Entra ID)' : ''}${found.error ? `: ${found.error}` : ''}`,
      );
    } else if (tenant) {
      log.debug(`tenant ${tenant}`);
    }
    if (received) return { code: signalExitCode(received), signal: received };

    /** @type {import('./tokens.js').AcquiredToken} */
    let acquired;
    try {
      acquired = await acquire({
        env,
        tenant,
        msa,
        platform,
        timeoutMs: timeoutFromEnv(env),
        signal: abort.signal,
        debug: (m) => log.debug(m),
      });
    } catch (error) {
      if (error instanceof AbortedError && received) return { code: signalExitCode(received), signal: received };
      if (!(error instanceof TokenError)) throw error;
      log.error(error.message);
      for (const a of error.attempts) log.error(`  ${a.source}: ${a.reason}`);
      if (error.hint) log.error(error.hint);
      return { code: EXIT.NO_TOKEN };
    }
    addSecret(acquired.token);
    const exp = typeof acquired.claims.exp === 'number' ? Math.round((acquired.claims.exp * 1000 - Date.now()) / 60000) : '?';
    log.debug(`token from ${acquired.source} (tenant ${acquired.claims.tid ?? 'unknown'}, expires in ${exp} min)`);

    temp = createTempNpmrc(renderNpmrc({ registry, token: acquired.token, scope: spec.scope }), { tmpdir: baseDir });
    if (received) return { code: signalExitCode(received), signal: received };

    // npm runs `<dir>/node_modules/.bin/<spec>` from the temp dir or any parent
    // directory instead of fetching the package, if such a file exists.
    const shadow = findShadowingBin(temp.dir, spec.raw);
    if (shadow) {
      log.error(`refusing to run: npm would execute ${shadow} instead of ${spec.raw} from the feed. Remove that file.`);
      return { code: EXIT.INTERNAL };
    }

    const argvForNpm = buildNpmArgv({ cli: npm.cli, prefixDir: temp.dir, registryHref: registry.href, spec: spec.raw, args: parsed.args });
    const innerEnv = buildInnerEnv(env, { npmrcFile: temp.file, registryHost: registry.host, scope: spec.scope, platform, execPath: npm.node });
    log.debug(`running ${npm.node} ${argvForNpm.join(' ')}`);

    let result;
    try {
      child = spawn({ node: npm.node, argv: argvForNpm, env: innerEnv });
      result = await waitForExit(child);
    } catch (error) {
      log.error(`failed to start npm: ${/** @type {Error} */ (error).message}`);
      return { code: EXIT.NPM };
    }
    log.debug(`npm exited with ${result.signal ?? result.code}`);
    if (received && platform !== 'win32') {
      // Give the rest of the tree until the SIGKILL deadline to exit.
      const deadline = shutdownAt + killAfterMs + 250;
      while (Date.now() < deadline && [...tracked].some((p) => p !== child?.pid && isAlive(p))) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (result.signal) return { code: signalExitCode(result.signal), signal: result.signal };
    return { code: result.code ?? EXIT.INTERNAL };
  } catch (error) {
    log.error(`unexpected error: ${/** @type {Error} */ (error)?.stack || error}`);
    return { code: EXIT.INTERNAL };
  } finally {
    if (temp && !temp.cleanup()) log.error(`could not remove ${temp.dir}; delete it manually`);
    for (const t of timers) clearTimeout(t);
    if (watchdog) clearInterval(watchdog);
    for (const s of handled) signals.off(s, onSignal);
    process.off('exit', exitHook);
  }
}
