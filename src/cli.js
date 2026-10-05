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
import { parseArgs, UsageError, USAGE } from './args.js';
import { buildInnerEnv } from './env.js';
import { addSecret, createLogger } from './log.js';
import { resolveNpm } from './npm-cli.js';
import { createTempNpmrc, renderNpmrc } from './npmrc.js';
import { getEnv } from './proc.js';
import { parseSpec, RegistryError, SpecError, validateRegistryUrl } from './registry.js';
import { buildNpmArgv, spawnNpm, waitForExit } from './run.js';
import { discoverTenant, isGuid } from './tenant.js';
import { acquireToken, AbortedError, DEFAULT_TIMEOUT_MS, TokenError } from './tokens.js';

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
 * @property {string} [tmpdir]
 * @property {Pick<NodeJS.Process, 'on' | 'off'>} [signals]
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
    tmpdir = os.tmpdir(),
    signals = process,
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

  // One signal handler for the whole run. Before npm starts it cancels token
  // acquisition; afterwards it removes the token file first (the client may
  // follow up with SIGKILL) and then forwards the signal to npm.
  const abort = new AbortController();
  /** @type {import('./npmrc.js').TempNpmrc | undefined} */
  let temp;
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  /** @type {NodeJS.Signals | undefined} */
  let received;
  const onSignal = (/** @type {NodeJS.Signals} */ sig) => {
    received ??= sig;
    temp?.cleanup();
    if (!child) {
      abort.abort();
      return;
    }
    // On Windows the console already delivered Ctrl+C to npm, and killing it
    // would orphan the server instead of letting it shut down.
    if (platform !== 'win32' && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(sig === 'SIGHUP' ? 'SIGTERM' : sig); // npm forwards only SIGINT/SIGTERM
      } catch {
        // already gone
      }
    }
  };
  /** @type {NodeJS.Signals[]} */
  const handled = platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const s of handled) signals.on(s, onSignal);
  const exitHook = () => temp?.cleanup();
  process.on('exit', exitHook);

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

    const npm = findNpm({ env, platform });
    if (!npm) {
      log.error("could not locate npm's npm-cli.js; make sure npm is installed with Node.js.");
      return { code: EXIT.NPM };
    }

    temp = createTempNpmrc(renderNpmrc({ registry, token: acquired.token, scope: spec.scope }), { tmpdir });
    if (received) return { code: signalExitCode(received), signal: received };

    const argvForNpm = buildNpmArgv({ cli: npm.cli, prefixDir: temp.dir, registryHref: registry.href, spec: spec.raw, args: parsed.args });
    const innerEnv = buildInnerEnv(env, { npmrcFile: temp.file, registryHost: registry.host, scope: spec.scope, platform });
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
    if (result.signal) return { code: signalExitCode(result.signal), signal: result.signal };
    return { code: result.code ?? EXIT.INTERNAL };
  } catch (error) {
    log.error(`unexpected error: ${/** @type {Error} */ (error)?.stack || error}`);
    return { code: EXIT.INTERNAL };
  } finally {
    if (temp && !temp.cleanup()) log.error(`could not remove ${temp.dir}; delete it manually`);
    for (const s of handled) signals.off(s, onSignal);
    process.off('exit', exitHook);
  }
}
