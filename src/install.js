/**
 * The online part every start, background update and prewarm shares: find
 * the feed's tenant, pick the exact version npm would run, install it into
 * npm's exec cache under its install lock, and say what a failure means.
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildInnerEnv, lookupsNeedNpm, npmPickOptions, tlsChecksOff } from './env.js';
import { refusedNotice } from './messages.js';
import { installOrigin, isFromFeedOrg, isInstalledFromFeed, isReadyToStart, isUsableInstall, npxInstallDir, readNpxInstall } from './npm-cache.js';
import { createTempNpmrc, renderNpmrc } from './npmrc.js';
import { writeNotice } from './notice.js';
import { getEnv, runCapture, withTrustedPath } from './proc.js';
import { buildPreinstallArgv, npmBaseArgs, npmFetchFlags, scriptShellFlags } from './run.js';
import { classifyWanted, parseVersion } from './semver.js';
import { backUp, emptyTrash, hasBackup, installLockName, moveToTrash, readLeases, restoreBackup, tenantMemory, waitForLock, writeLease } from './state.js';

export const EXIT = Object.freeze({ INTERNAL: 1, USAGE: 2, NO_TOKEN: 3, NPM: 4, NOT_FOUND: 5 });

/** How long a start waits for another process that installs the same version. */
export const INSTALL_WAIT_MS = 5 * 60 * 1000;
const NPM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * @typedef {'stopped' | 'auth' | 'gone' | 'network' | 'busy' | 'local' | 'other'} FailureKind
 *   auth: the feed refused the token; gone: the feed has no such package or
 *   version (npm said so about the requested package itself); network: the
 *   feed could not be reached; busy: another process installs the version;
 *   local: a problem on this machine (a lock, a folder)
 */

/**
 * @typedef {object} Failure
 * @property {false} ok
 * @property {FailureKind} kind
 * @property {string} reason
 * @property {number} [status]   the feed's HTTP status (auth)
 * @property {string} [npmCode]  npm's error code (E404, ETARGET, E401, ...)
 */

/**
 * @typedef {object} InstallContext
 * @property {import('./npm-cli.js').NpmCommand} npm
 * @property {import('./registry.js').Registry} registry
 * @property {import('./registry.js').PackageSpec} spec
 * @property {string} token
 * @property {string} cacheDir  npm's cache folder
 * @property {string} dir       state folder
 * @property {string} baseDir   private folder for token files
 * @property {NodeJS.ProcessEnv} env
 * @property {NodeJS.Platform} platform
 * @property {Set<import('./npmrc.js').TempNpmrc>} temps  token files, removed at once on a signal
 * @property {AbortSignal} [signal]
 * @property {typeof runCapture} [run]
 * @property {(msg: string) => void} debug
 */

/** @type {Failure} */
const STOPPED = Object.freeze({ ok: false, kind: 'stopped', reason: 'stopped' });

/**
 * @param {FailureKind} kind
 * @param {string} reason
 * @param {{ status?: number, npmCode?: string }} [more]
 * @returns {Failure}
 */
function fail(kind, reason, more = {}) {
  return { ok: false, kind, reason, ...more };
}

/** @param {number} ms */
const minutes = (ms) => `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? '' : 's'}`;

/**
 * The feed's tenant: given, remembered from an earlier discovery, or
 * discovered from the feed's anonymous answer (and remembered). `forget`
 * drops a remembered tenant the feed or the sign-in tools did not accept.
 *
 * @param {{ registry: import('./registry.js').Registry, tenant: string | undefined, env: NodeJS.ProcessEnv, dir?: string,
 *   discover: typeof import('./tenant.js').discoverTenant, signal?: AbortSignal, now?: () => number }} o
 * @returns {Promise<import('./tenant.js').TenantInfo & { remembered?: boolean, forget: () => void }>}
 */
export async function feedTenant({ registry, tenant, env, dir, discover, signal, now }) {
  if (tenant || getEnv(env, 'ADO_NPM_EXEC_TOKEN')) return { ...(tenant ? { tenant } : {}), forget: () => {} };
  const memory = tenantMemory(dir, registry.org || registry.host, { now });
  if (memory.tenant) return { tenant: memory.tenant, remembered: true, forget: memory.forget };
  const found = await discover(registry.href, { signal });
  if (found.tenant) memory.remember(found.tenant);
  return { ...found, forget: memory.forget };
}

/** @param {string} text */
const stripColor = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * npm's error code from its stderr (`npm error code E404`; npm 9: `npm ERR! code E404`).
 *
 * @param {string} text
 * @returns {string | undefined}
 */
export function npmErrorCode(text) {
  return /\bnpm (?:error|ERR!) code ([A-Z][A-Z0-9_]+)\b/.exec(stripColor(text))?.[1];
}

/** The most useful line of npm's stderr. @param {string} text */
function npmErrorLine(text) {
  const lines = stripColor(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.find((l) => /npm (?:error|ERR!) (?:code|[0-9]{3})|E[A-Z0-9]{3,}/.test(l)) ?? lines.find((l) => /error/i.test(l)) ?? lines[0] ?? '';
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/** npm's codes for a feed it could not reach: the network, a proxy, TLS, or the feed itself (5xx). */
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'EPROTO',
  'ERR_SOCKET_TIMEOUT',
  'FETCH_ERROR',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'E407',
]);

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether npm's error names the requested package, not a dependency: its 404
 * names the package (`'<name>@<spec>' is not in this registry`, `GET
 * <registry>/<escaped name>`), its ETARGET the spec (`No matching version
 * found for <name>@<spec>`).
 *
 * @param {string} text
 * @param {string} name
 */
function namesPackage(text, name) {
  const escaped = escapeRe(name.replace('/', '%2f'));
  return new RegExp(`(?:No matching version found for |')${escapeRe(name)}@|/${escaped}(?:\\s|$)`, 'i').test(text);
}

/**
 * The hosts of the URLs in npm's error output.
 *
 * @param {string} text
 */
function urlHosts(text) {
  return [...text.matchAll(/\bhttps?:\/\/[^\s'"]+/g)].flatMap((m) => {
    try {
      return [new URL(m[0]).host.toLowerCase()];
    } catch {
      return [];
    }
  });
}

/**
 * @typedef {object} NpmRun
 * @property {string} name       the requested package
 * @property {string} feedHost   the feed's host
 * @property {boolean} [single]  npm asked about the requested package alone (npm view): every 404 is about it
 * @property {number} timeoutMs
 * @property {(msg: string) => void} debug
 */

/**
 * A finished npm run as a Failure, or undefined when npm succeeded. A refusal
 * counts as the feed's only when npm names no other host; "not found" counts
 * as gone only when npm names the requested package. Anything else (a
 * dependency, another registry) is "other": the copy in npm's cache may
 * still start.
 *
 * @param {import('./proc.js').CaptureResult} r
 * @param {NpmRun} run
 * @returns {Failure | undefined}
 */
function npmFailure(r, { name, feedHost, single = false, timeoutMs, debug }) {
  if (r.aborted) return STOPPED;
  if (r.error) return fail('other', `npm did not start: ${r.error.message}`);
  if (r.timedOut) return fail('network', `npm did not finish within ${minutes(timeoutMs)}`);
  if (r.code === 0 && !r.signal) return undefined;
  const text = stripColor(r.stderr).trim();
  if (text) debug(`npm said:\n${text}`);
  const npmCode = npmErrorCode(text);
  const line = npmErrorLine(text);
  const reason = `npm exited with ${r.signal ?? r.code}${line ? `: ${line}` : ''}`;
  const more = npmCode ? { npmCode } : {};
  if (npmCode === 'E401' || npmCode === 'E403') {
    const hosts = urlHosts(text);
    if (hosts.length && !hosts.includes(feedHost.toLowerCase())) return fail('other', `${reason} (another registry refused it)`, more);
    return fail('auth', reason, { ...more, status: Number(npmCode.slice(1)) });
  }
  if (npmCode === 'E404' || npmCode === 'ETARGET') return single || namesPackage(text, name) ? fail('gone', reason, more) : fail('other', `${reason} (a dependency)`, more);
  if ((npmCode && (NETWORK_CODES.has(npmCode) || /^E5\d\d$/.test(npmCode))) || /npm (?:error|ERR!) network\b/.test(text)) return fail('network', reason, more);
  return fail('other', reason, more);
}

/**
 * Run npm with a private token file, output captured, then remove the file
 * (one that cannot be removed stays in `temps` for the shutdown). The token
 * is in npm's environment, so PATH has no folder a workspace controls: npm
 * starts `sh` and `git` through it.
 *
 * @template T
 * @param {InstallContext} ctx
 * @param {(prefix: string, env: NodeJS.ProcessEnv) => Promise<T>} fn  prefix: the private folder (real path)
 * @returns {Promise<T>}
 */
async function withNpm(ctx, fn) {
  const temp = createTempNpmrc(renderNpmrc({ registry: ctx.registry, token: ctx.token, scope: ctx.spec.scope }), { tmpdir: ctx.baseDir });
  ctx.temps.add(temp);
  try {
    // Through a symlink (macOS /var), npm keys the lockfile by a relative path.
    const prefix = fs.realpathSync(temp.dir);
    const env = withTrustedPath(
      buildInnerEnv(ctx.env, { npmrcFile: temp.file, registryHost: ctx.registry.host, scope: ctx.spec.scope, platform: ctx.platform, execPath: ctx.npm.node }),
      ctx.platform,
    );
    return await fn(prefix, env);
  } finally {
    if (temp.cleanup()) ctx.temps.delete(temp);
    else ctx.debug(`could not remove ${temp.dir} yet`);
  }
}

/** @param {unknown} v */
function exactVersion(v) {
  const parsed = typeof v === 'string' ? parseVersion(v) : undefined;
  return parsed && /^[0-9A-Za-z.+-]+$/.test(parsed.version) ? parsed.version : undefined;
}

/**
 * Let npm pick the version of the spec, without touching npm's exec cache: a
 * dist-tag through `npm view` (one request), anything else through
 * `npm install --package-lock-only` in a private folder (the dependency tree
 * is resolved; nothing is downloaded or run). For a spec only npm can decide,
 * and a feed only npm can reach.
 *
 * @param {InstallContext} ctx
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true, version: string } | Failure>}
 */
export async function resolveWithNpm(ctx, { timeoutMs = NPM_TIMEOUT_MS } = {}) {
  const { spec, debug } = ctx;
  const wanted = classifyWanted(spec.range ?? '');
  const tag = wanted?.type === 'tag' && !npmPickOptions(ctx.env).before ? wanted.tag : undefined;
  try {
    return await withNpm(ctx, async (prefix, env) => {
      const base = [
        ...npmBaseArgs({ prefixDir: prefix, registryHref: ctx.registry.href, cacheDir: ctx.cacheDir }),
        '--color=false',
        ...scriptShellFlags(env, ctx.platform),
        ...npmFetchFlags(env),
        '--prefer-online',
      ];
      const argv = tag
        ? [ctx.npm.cli, 'view', ...base, `${spec.name}@${tag}`, 'version']
        : [ctx.npm.cli, 'install', ...base, '--package-lock-only', '--ignore-scripts', '--save=true', '--package-lock=true', '--save-exact', spec.raw];
      debug(`asking npm which version ${spec.raw} is`);
      const r = await (ctx.run ?? runCapture)(ctx.npm.node, argv, { env, timeoutMs, signal: ctx.signal, cwd: prefix });
      const failure = npmFailure(r, { name: spec.name, feedHost: ctx.registry.host, single: !!tag, timeoutMs, debug });
      if (failure) return failure;
      /** @param {string} file @returns {any} */
      const read = (file) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(prefix, file), 'utf8'));
        } catch {
          return undefined;
        }
      };
      const version = tag
        ? exactVersion(r.stdout.trim())
        : [read('package-lock.json')?.packages?.[`node_modules/${spec.name}`]?.version, read('package.json')?.dependencies?.[spec.name]].map(exactVersion).find(Boolean);
      if (!version) return fail('other', `npm resolved ${spec.raw}, but its version could not be read`);
      debug(`npm picks ${spec.name}@${version}`);
      return { ok: true, version };
    });
  } catch (error) {
    return fail('other', /** @type {Error} */ (error)?.message || String(error));
  }
}

/**
 * A failed lookup on the feed as a Failure.
 *
 * @param {Exclude<import('./resolve.js').Resolution, { kind: 'resolved' } | { kind: 'unsupported' }>} res
 * @returns {Failure}
 */
function lookupFailure(res) {
  if (res.kind === 'refused') return fail('auth', res.detail, { status: res.status });
  if (res.kind === 'not-found') return fail('gone', res.detail);
  if (res.kind === 'no-match') return fail('gone', `${res.detail}${res.latest ? `; its latest version is ${res.latest}` : ''}`);
  return fail('network', res.detail);
}

/**
 * The exact version npm would run for the spec: asked of the feed directly,
 * or picked by npm when only npm can decide it (rare range syntax, npm's
 * `before` setting) or reach the feed (a proxy Node's fetch cannot use,
 * certificate checks off).
 *
 * @param {InstallContext} ctx
 * @param {{ resolve: typeof import('./resolve.js').resolveSpec, npmVersion?: string, npmWhenUnanswered?: boolean }} how
 *   npmWhenUnanswered: npm tries too when the feed does not answer our lookup (nothing else could start)
 * @returns {Promise<{ ok: true, version: string, metadataCached: boolean } | Failure>}
 *   metadataCached: npm just cached the registry metadata
 */
export async function pickVersion(ctx, { resolve, npmVersion, npmWhenUnanswered = false }) {
  const { spec, env, debug } = ctx;
  const pick = npmPickOptions(env);
  const exact = classifyWanted(spec.range ?? '')?.type === 'version' && !pick.before;
  if (exact || !lookupsNeedNpm(env)) {
    const res = await resolve({ registry: ctx.registry, spec, token: ctx.token, npmVersion, signal: ctx.signal, ...pick });
    if (ctx.signal?.aborted) return STOPPED;
    if (res.kind === 'resolved') {
      debug(res.via === 'exact' ? `version ${res.version}` : `${spec.raw} is ${res.version} (from the ${res.via})`);
      return { ok: true, version: res.version, metadataCached: false };
    }
    if (res.kind !== 'unsupported' && !(res.kind === 'unavailable' && npmWhenUnanswered)) return lookupFailure(res);
    debug(`${res.detail}: npm picks the version`);
  } else {
    debug(`${tlsChecksOff(env) ? 'certificate checks are off' : "Node's fetch cannot use the proxy"}: npm picks the version`);
  }
  const viaNpm = await resolveWithNpm(ctx);
  return viaNpm.ok ? { ...viaNpm, metadataCached: true } : viaNpm;
}

/**
 * @typedef {object} PreinstallOptions
 * @property {string} version      the exact version to install
 * @property {import('./run.js').CacheMode} [cacheMode]
 * @property {number} [waitMs]     how long to wait for another process installing the same folder
 * @property {(string | undefined)[]} [ownLeases]  lease files of this process
 * @property {boolean} [reinstall] install again although the folder looks complete (it failed at start)
 * @property {() => void} [onReady]  runs under the install lock once the version is ready: a start
 *   writes its session lease there, so that cleanup cannot remove the version in between
 * @property {number} [timeoutMs]
 * @property {number} [refreshMs]  how often the lock is checked and refreshed while npm runs
 */

/**
 * Install `name@version` into npm's exec cache without running it, under the
 * folder's install lock, and check that it can then start offline: npm
 * completed it, from the feed's organization, and cached the registry
 * metadata npm asks for. An incomplete folder, one from another registry, or
 * (with `reinstall`) one that failed at start is replaced, unless another
 * process uses it. A copy that could still start is moved aside first and
 * put back if the install fails; a start puts it back after a crash (see
 * claimCached).
 *
 * @param {InstallContext} ctx
 * @param {PreinstallOptions} o
 * @returns {Promise<{ ok: true, created: boolean } | Failure>}  created: npm created the folder
 */
export async function preinstall(ctx, { version, cacheMode, waitMs = 0, ownLeases = [], reinstall = false, onReady = () => {}, timeoutMs = NPM_TIMEOUT_MS, refreshMs = 10_000 }) {
  const { registry, cacheDir, dir, debug } = ctx;
  const { name } = ctx.spec;
  const runSpec = `${name}@${version}`;
  const fullMetadata = !!npmPickOptions(ctx.env).before;
  const ready = () => isReadyToStart(cacheDir, registry.href, name, version, { fullMetadata, listed: true });
  const got = await waitForLock(dir, installLockName(runSpec), { timeoutMs: waitMs, signal: ctx.signal });
  if ('stopped' in got) return STOPPED;
  if ('busy' in got) return fail('busy', waitMs ? `another process has been installing ${runSpec} for over ${minutes(waitMs)}` : `another process is installing ${runSpec}`);
  if ('unavailable' in got) return fail('local', `the install lock cannot be created in ${dir}: check the permissions of that folder`);
  const { lock } = got;
  const folder = npxInstallDir(cacheDir, [runSpec]);
  /** @returns {{ ok: true, created: boolean }} */
  const claimed = (/** @type {boolean} */ created) => {
    onReady();
    return { ok: true, created };
  };
  if (restoreBackup(dir, folder, () => isUsableInstall(readNpxInstall(cacheDir, runSpec, name), registry.href, version))) {
    debug(`put back the copy of ${runSpec} that an interrupted reinstall had moved aside`);
  }
  if (!reinstall && ready()) {
    try {
      return claimed(false);
    } finally {
      lock.release();
    }
  }
  // While npm writes the folder, it looks like an interrupted install: the
  // lease keeps other processes away from it, also when this process is
  // killed and its npm goes on (both name that npm).
  const lease = writeLease(dir, { name, version });
  // Stopped on a signal, or when another process took the lock over (it was
  // not refreshed for a long time: the machine slept).
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  if (ctx.signal?.aborted) stop.abort();
  else ctx.signal?.addEventListener('abort', onSignal, { once: true });
  let lost = false;
  const check = () => {
    if (lost || lock.refresh()) return;
    lost = true;
    stop.abort();
  };
  const refresh = setInterval(check, refreshMs);
  refresh.unref();
  const inst = readNpxInstall(cacheDir, runSpec, name);
  /** @type {string | undefined} */
  let backup;
  let done = false;
  try {
    let created = !inst.exists;
    if (inst.exists && (reinstall || !isUsableInstall(inst, registry.href, version))) {
      const usable = isUsableInstall(inst, registry.href, version);
      const what = !inst.complete ? 'incomplete' : !isFromFeedOrg(registry.href, inst.resolved) ? `from ${installOrigin(inst)}` : usable ? 'one that failed at start' : 'damaged';
      const { leases, complete } = readLeases(dir, { exclude: [lease?.file, ...ownLeases] });
      if (!complete || leases.some((l) => l.name === name && l.version === version)) {
        if (usable) return claimed(false);
        return fail('local', `the install of ${runSpec} in npm's cache is ${what}, and another process may use it: stop that process, or delete ${inst.dir}`);
      }
      debug(`replacing ${inst.dir}: the install is ${what}`);
      if (usable) {
        // It could still start: keep it until the new install is complete.
        try {
          backup = backUp(dir, inst.dir);
        } catch (error) {
          const why = /** @type {NodeJS.ErrnoException} */ (error).code ?? /** @type {Error} */ (error).message;
          return fail('local', `the install of ${runSpec} in npm's cache is ${what}, and it cannot be moved aside to install it again (${why}): delete ${inst.dir}`);
        }
      } else {
        try {
          moveToTrash(dir, inst.dir);
        } catch {
          try {
            fs.rmSync(inst.dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
          } catch (error) {
            const why = /** @type {NodeJS.ErrnoException} */ (error).code ?? /** @type {Error} */ (error).message;
            return fail('local', `the install of ${runSpec} in npm's cache is ${what}, and it cannot be removed (${why}): delete ${inst.dir}`);
          }
        }
      }
      created = true;
    }
    debug(`installing ${runSpec}`);
    const install = (/** @type {import('./run.js').CacheMode | undefined} */ mode) =>
      withNpm(ctx, (prefix, env) =>
        (ctx.run ?? runCapture)(
          ctx.npm.node,
          buildPreinstallArgv({
            cli: ctx.npm.cli,
            prefixDir: prefix,
            registryHref: registry.href,
            cacheDir,
            spec: runSpec,
            cacheMode: mode,
            extraFlags: [...scriptShellFlags(env, ctx.platform), ...npmFetchFlags(env)],
          }),
          {
            env,
            timeoutMs,
            signal: stop.signal,
            cwd: prefix,
            onSpawn: (pid) => {
              lock.addPid(pid);
              lease?.addPid(pid);
            },
          },
        ),
      );
    /** @param {import('./proc.js').CaptureResult} r @returns {Failure | undefined} */
    const outcome = (r) => {
      check();
      if (lost) return fail('busy', `another process took over the install of ${runSpec}`);
      return npmFailure(r, { name, feedHost: registry.host, timeoutMs, debug });
    };
    const failure = outcome(await install(cacheMode));
    if (failure) return failure;
    const result = readNpxInstall(cacheDir, runSpec, name);
    if (!result.complete || !isUsableInstall(result, registry.href, version)) {
      if (result.complete && !isFromFeedOrg(registry.href, result.resolved)) return fail('other', `npm installed ${runSpec} from ${installOrigin(result)}, not from the feed`);
      return fail('other', `npm finished, but ${runSpec} is not completely installed`);
    }
    if (!ready()) {
      // Another npm that read this metadata meanwhile (a server starting from
      // npm's cache) rewrites its index without a lock, and an entry written
      // in between is lost. Asked again, npm fetches the metadata again.
      debug(`npm's cache has no registry metadata that lists ${runSpec}; running npm again`);
      const again = outcome(await install(undefined));
      if (again) return again;
      if (!ready()) return fail('other', `npm installed ${runSpec}, but npm's cache has no registry metadata that lists it`);
    }
    done = true;
    return claimed(created);
  } catch (error) {
    return fail('other', /** @type {Error} */ (error)?.message || String(error));
  } finally {
    clearInterval(refresh);
    ctx.signal?.removeEventListener('abort', onSignal);
    // Lost: the folder is another process's now; the backup waits for a start that needs it.
    if (backup && !lost) {
      try {
        if (done || isInstalledFromFeed(cacheDir, registry.href, name, version)) {
          moveToTrash(dir, backup);
        } else {
          if (fs.existsSync(folder)) moveToTrash(dir, folder);
          fs.renameSync(backup, folder);
          debug(`put the earlier install of ${runSpec} back`);
        }
      } catch (error) {
        debug(`could not put ${backup} back yet: ${/** @type {Error} */ (error).message}`);
      }
    }
    lease?.release();
    lock.release();
    emptyTrash(dir).catch(() => {});
  }
}

/**
 * Claim a version that should start from npm's cache: under its install
 * lock, put back a copy that an interrupted reinstall moved aside, run
 * `claim` (the session lease), and check that the install is still there.
 * Cleanup removes folders under the same lock, after reading the leases.
 *
 * @param {{ cacheDir: string, dir: string, registryHref: string, name: string, version: string,
 *   signal?: AbortSignal, waitMs?: number, debug: (msg: string) => void }} o
 * @param {() => void} claim
 * @returns {Promise<'ready' | 'missing' | 'busy'>}  busy: another process installs or removes it
 */
export async function claimCached({ cacheDir, dir, registryHref, name, version, signal, waitMs = 2000, debug }, claim) {
  const runSpec = `${name}@${version}`;
  const got = await waitForLock(dir, installLockName(runSpec), { timeoutMs: waitMs, signal });
  if ('stopped' in got || 'busy' in got) return 'busy';
  // Unavailable: no other process can take the lock to remove the folder either.
  const lock = 'lock' in got ? got.lock : undefined;
  try {
    const usable = () => isInstalledFromFeed(cacheDir, registryHref, name, version);
    if (lock && restoreBackup(dir, npxInstallDir(cacheDir, [runSpec]), usable)) debug(`put back the copy of ${runSpec} that an interrupted reinstall had moved aside`);
    claim();
    return usable() ? 'ready' : 'missing';
  } finally {
    lock?.release();
  }
}

/**
 * Put back the copy of `name@version` that an interrupted reinstall moved
 * aside, when its folder is missing: so that the next start can use npm's
 * cache again (also offline).
 *
 * @param {{ cacheDir: string, dir: string, registryHref: string, name: string, version: string, debug: (msg: string) => void }} o
 */
export async function recoverInterrupted({ cacheDir, dir, registryHref, name, version, debug }) {
  const runSpec = `${name}@${version}`;
  const folder = npxInstallDir(cacheDir, [runSpec]);
  if (fs.existsSync(folder) || !hasBackup(dir, folder)) return;
  const got = await waitForLock(dir, installLockName(runSpec), { timeoutMs: 2000 });
  if (!('lock' in got)) return;
  try {
    if (restoreBackup(dir, folder, () => isInstalledFromFeed(cacheDir, registryHref, name, version))) debug(`put back the copy of ${runSpec} that an interrupted reinstall had moved aside`);
  } finally {
    got.lock.release();
  }
}

/**
 * Tell the person what a failure means, and return the exit code.
 *
 * @param {Failure} f
 * @param {{ spec: import('./registry.js').PackageSpec, registry: import('./registry.js').Registry, claims?: Record<string, unknown>,
 *   tenant?: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, log: import('./log.js').Logger,
 *   noticeStream: { write: (s: string) => void, isTTY: boolean, columns?: number }, action?: 'run' | 'install' }} info
 * @returns {number}
 */
export function reportFailure(f, { spec, registry, claims, tenant, env, platform, log, noticeStream, action = 'run' }) {
  switch (f.kind) {
    case 'auth':
      writeNotice(noticeStream, refusedNotice({ feed: registry.href, status: f.status ?? 401, detail: f.reason, claims, tenant, env, platform }), env);
      return EXIT.NO_TOKEN;
    case 'gone':
      log.error(`${spec.raw} is not on ${registry.href} or its upstream sources (${f.reason}).`);
      return EXIT.NOT_FOUND;
    case 'network':
      log.error(`could not reach ${registry.href} (${f.reason}). Check the network, VPN or proxy settings.`);
      return EXIT.INTERNAL;
    case 'busy':
      log.error(`${f.reason}; try again later.`);
      return EXIT.INTERNAL;
    case 'local':
      log.error(`refusing to ${action} ${spec.raw}: ${f.reason}.`);
      return EXIT.INTERNAL;
    default:
      log.error(`${spec.raw}: ${f.reason}.`);
      return EXIT.INTERNAL;
  }
}
