/**
 * `--doctor`: one report on stderr that shows why a start fails or is slow.
 * Findings come first. Never a token, and nothing on stdout.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInnerEnv, fetchUsesProxy, npmPickOptions, proxyBlocksFetch, tlsChecksOff } from './env.js';
import { checkEntraToken } from './jwt.js';
import { addSecret, maskUrlCredentials, redact } from './log.js';
import { findCachedStart, installOrigin, isCached, isFromFeedOrg, npmCacheDir, packumentCacheKey, readNpxInstall } from './npm-cache.js';
import { npmVersionOf } from './npm-cli.js';
import { azLoginCommands } from './notice.js';
import { chooseBaseDir, findShadowingBin, TEMP_PREFIX, UnsafeTempError } from './npmrc.js';
import { findOnPath, getEnv } from './proc.js';
import { parseSpec, RegistryError, SpecError } from './registry.js';
import { fetchPackument, probeTarball } from './resolve.js';
import { npmFetchFlags } from './run.js';
import { classifyWanted } from './semver.js';
import { readLeases, readState, signInMemory, stateDir, stateKey, tenantMemory } from './state.js';
import { TokenError, timeoutFromEnv } from './tokens.js';
import { npmForwardsSignals } from './tree.js';

/**
 * @typedef {object} DoctorOptions
 * @property {import('./args.js').ParsedArgs} parsed
 * @property {string | undefined} tenant
 * @property {NodeJS.ProcessEnv} env
 * @property {NodeJS.Platform} platform
 * @property {(s: string) => void} write
 * @property {(input: string | undefined) => import('./registry.js').Registry} validateRegistry
 * @property {typeof import('./tenant.js').discoverTenant} discover
 * @property {typeof import('./tokens.js').acquireToken} acquire
 * @property {typeof import('./resolve.js').resolveSpec} resolve
 * @property {typeof import('./npm-cli.js').resolveNpm} findNpm
 * @property {string} [tmpdir]
 * @property {() => number} now
 * @property {typeof fetch} [fetchImpl]
 */

/** @param {NodeJS.ProcessEnv} env */
function detectEnvironment(env) {
  /** @type {string[]} */
  const kinds = [];
  if (getEnv(env, 'CODESPACES') === 'true') kinds.push('codespaces');
  if (getEnv(env, 'REMOTE_CONTAINERS') || fs.existsSync('/.dockerenv')) kinds.push('container');
  if (getEnv(env, 'CI') || getEnv(env, 'TF_BUILD') || getEnv(env, 'GITHUB_ACTIONS') || getEnv(env, 'BUILD_BUILDID')) kinds.push('ci');
  if (getEnv(env, 'SSH_CONNECTION') || getEnv(env, 'SSH_CLIENT') || getEnv(env, 'SSH_TTY')) kinds.push('ssh');
  if (getEnv(env, 'WSL_DISTRO_NAME')) kinds.push('wsl');
  return kinds.length ? kinds.join(', ') : 'local';
}

/** @param {number} ms */
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** @param {number} ms */
function ago(ms) {
  if (ms < 90_000) return `${Math.round(ms / 1000)} s ago`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 36 * 3_600_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return `${Math.round(ms / 86_400_000)} days ago`;
}

/** @param {Record<string, unknown>} claims */
function describeClaims(claims) {
  const who = [claims.upn, claims.unique_name, claims.preferred_username, claims.appid].find((v) => typeof v === 'string' && v);
  const exp = typeof claims.exp === 'number' ? `expires in ${Math.round((claims.exp * 1000 - Date.now()) / 60_000)} min` : 'no expiry';
  return `${who ? `${who}, ` : ''}tenant ${claims.tid ?? 'unknown'}, ${exp}`;
}

/** npm settings worth showing with their value (credentials never are). */
const SHOWN_NPM_KEYS = /^npm_config_(?:registry|cache|prefix|globalconfig|userconfig|proxy|https[-_]proxy|noproxy|no[-_]proxy|cafile|strict[-_]ssl|replace[-_]registry[-_]host|fetch[-_][a-z_-]+|offline|prefer[-_]offline|prefer[-_]online|scope|@[^:]+:registry)$/i;

/** @param {number} ms */
function isoTime(ms) {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? `invalid time ${ms}` : d.toISOString();
}

/**
 * @param {DoctorOptions} o
 * @returns {Promise<number>} 0 without errors, 1 with
 */
export async function runDoctor(o) {
  const { parsed, env, platform, now } = o;
  /** @type {{ level: 'error' | 'warn' | 'info', text: string }[]} */
  const findings = [];
  /** @type {string[]} */
  const body = [];
  /** @param {'error' | 'warn' | 'info'} level @param {string} text */
  const find = (level, text) => findings.push({ level, text });
  /** @param {string} title @param {string[]} rows */
  const section = (title, rows) => body.push('', title, ...rows.map((r) => `  ${r}`));

  let version = 'unknown';
  try {
    version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    // keep 'unknown'
  }

  const npm = o.findNpm({ env, platform });
  if (!npm) find('error', "npm's npm-cli.js was not found: install npm with Node.js, or start your MCP client from a shell that has it on PATH.");
  const npmVersion = npm ? npmVersionOf(npm.cli) : undefined;
  section('Runtime', [
    `ado-npm-exec ${version}`,
    `Node.js ${process.version} (${process.execPath})`,
    `${platform} ${os.release()} ${process.arch}`,
    npm ? `npm ${npmVersion ?? 'unknown'} (${npm.cli}); forwards stop signals: ${npmForwardsSignals(npm.cli) ? 'yes' : 'no'}` : 'npm: not found',
    `environment: ${detectEnvironment(env)}`,
  ]);

  /** @type {import('./registry.js').Registry | undefined} */
  let registry;
  /** @type {import('./registry.js').PackageSpec | undefined} */
  let spec;
  if (parsed.registry) {
    try {
      registry = o.validateRegistry(parsed.registry);
    } catch (error) {
      if (!(error instanceof RegistryError)) throw error;
      find('error', error.message);
    }
  } else {
    find('info', 'Give the feed URL and a package spec to check them too: ado-npm-exec --doctor <feed-url> <package-spec>');
  }
  if (parsed.spec) {
    try {
      spec = parseSpec(parsed.spec);
    } catch (error) {
      if (!(error instanceof SpecError)) throw error;
      find('error', error.message);
    }
  }
  const alwaysFresh = parsed.alwaysFresh || getEnv(env, 'ADO_NPM_EXEC_ALWAYS_FRESH') === '1';
  const offlineFallback = parsed.offlineFallback ?? getEnv(env, 'ADO_NPM_EXEC_OFFLINE_FALLBACK') !== '0';
  section('Settings', [
    `feed: ${registry?.href ?? (parsed.registry ? 'invalid' : 'not given')}`,
    `package: ${spec?.raw ?? (parsed.spec ? 'invalid' : 'not given')}`,
    `tenant: ${o.tenant ?? 'from the feed'}`,
    `always-fresh: ${alwaysFresh ? 'on' : 'off'}; offline fallback: ${offlineFallback ? 'on' : 'off'}; token timeout per source: ${timeoutFromEnv(env)} ms`,
  ]);

  const cacheDir = npmCacheDir(env, { platform });
  const innerEnv = buildInnerEnv(env, {
    npmrcFile: path.join(os.tmpdir(), `${TEMP_PREFIX}doctor`, '.npmrc'),
    registryHost: registry?.host ?? 'pkgs.dev.azure.com',
    scope: spec?.scope,
    platform,
    execPath: npm?.node ?? process.execPath,
  });
  const inherited = Object.keys(env).filter((k) => /^npm_config_/i.test(k));
  const removed = inherited.filter((k) => !(k in innerEnv) && !/^npm_config_userconfig$/i.test(k));
  const shown = inherited.filter((k) => k in innerEnv && SHOWN_NPM_KEYS.test(k));
  const replaced = shown.filter((k) => innerEnv[k] !== env[k]);
  const globalconfig = getEnv(innerEnv, 'npm_config_globalconfig');
  const fetchFlags = npmFetchFlags(innerEnv);
  if (!cacheDir) find('error', "npm's cache folder cannot be determined: set npm_config_cache to an absolute path.");
  if (proxyBlocksFetch(env)) {
    find(
      'warn',
      "A proxy is configured, and Node's fetch does not use it: tenant discovery cannot reach the feed (pass --tenant <guid>), and npm picks every version. " +
        'On Node 22.21+ or 24+, NODE_USE_ENV_PROXY=1 makes fetch use HTTPS_PROXY.',
    );
  } else if (fetchUsesProxy(env)) {
    find('info', "Node's fetch uses the proxy from HTTPS_PROXY (NODE_USE_ENV_PROXY).");
  }
  if (/^false$/i.test(getEnv(env, 'npm_config_strict_ssl') ?? '')) find('info', 'strict-ssl=false is inherited; ado-npm-exec always passes --strict-ssl=true to the inner npm.');
  if (tlsChecksOff(env)) {
    find(
      'warn',
      'NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks: ado-npm-exec then sends the token only through npm (with --strict-ssl=true), so version lookups are slower. ' +
        "For an intercepting proxy, set NODE_EXTRA_CA_CERTS and npm's cafile to its CA certificate instead.",
    );
  }
  if (/^never$/i.test(getEnv(env, 'npm_config_replace_registry_host') ?? '')) {
    find('info', 'replace-registry-host=never is inherited; ado-npm-exec passes registry.npmjs.org so shrinkwrapped downloads use the feed.');
  }
  section('npm configuration of the inner npm', [
    `npm cache: ${cacheDir ?? 'unknown'}`,
    `global npmrc: ${globalconfig ?? 'npm default'}${globalconfig ? (fs.existsSync(globalconfig) ? ' (exists)' : ' (missing)') : ''}`,
    `removed from the inherited environment: ${removed.length ? removed.join(', ') : 'nothing'}`,
    ...shown.map((k) =>
      replaced.includes(k)
        ? `replaced ${k}: ${maskUrlCredentials(/** @type {string} */ (env[k]))} -> ${maskUrlCredentials(/** @type {string} */ (innerEnv[k]))}`
        : `kept ${k}=${maskUrlCredentials(/** @type {string} */ (env[k]))}`,
    ),
    'forced on the inner npm: --cache=<npm cache> --strict-ssl=true --bin-links=true --replace-registry-host=registry.npmjs.org (and more, see the README)',
    `fetch timeout: ${fetchFlags.length ? fetchFlags.join(' ') : 'npm settings (tuned in the environment or the global npmrc)'}`,
  ]);

  /** @type {string[]} */
  const tempRows = [];
  try {
    const baseDir = o.tmpdir ?? chooseBaseDir({ platform, env });
    let stale = 0;
    try {
      stale = fs.readdirSync(baseDir).filter((n) => n.startsWith(TEMP_PREFIX)).length;
    } catch {
      stale = 0;
    }
    tempRows.push(`folder for token files: ${baseDir} (private)`, `ado-npm-exec folders in it: ${stale}`);
    if (spec) {
      const shadow = findShadowingBin(path.join(baseDir, `${TEMP_PREFIX}doctor`), spec.raw);
      if (shadow) find('error', `npm would run ${shadow} instead of ${spec.raw} from the feed: remove that file.`);
    }
  } catch (error) {
    if (!(error instanceof UnsafeTempError)) throw error;
    find('error', error.message);
    tempRows.push('folder for token files: none is private');
  }
  section('Temporary files', tempRows);

  let tenant = o.tenant;
  /** @type {string[]} */
  const tokenRows = [];
  if (!tenant && registry) {
    const t0 = now();
    const found = await o.discover(registry.href);
    const remembered = tenantMemory(cacheDir && stateDir(cacheDir), registry.org || registry.host, { now }).tenant;
    tenant = found.tenant ?? remembered;
    tokenRows.push(
      `feed tenant: ${found.tenant ?? (found.msa ? 'none (not backed by Entra ID)' : 'unknown')} (anonymous request, ${seconds(now() - t0)}${found.error ? `: ${found.error}` : ''})`,
      `remembered tenant of the organization: ${remembered ?? 'none'} (a start uses it instead of asking the feed)`,
    );
    if (found.msa) find('error', 'This Azure DevOps organization is not connected to Microsoft Entra ID; only Entra ID tokens are supported.');
    if (found.error) find('warn', `Tenant discovery failed (${found.error}): pass --tenant <guid>.`);
    if (found.tenant && remembered && found.tenant !== remembered) find('warn', `The remembered tenant ${remembered} is not the feed's tenant ${found.tenant}: the next start that the feed refuses forgets it.`);
  } else if (tenant) {
    tokenRows.push(`feed tenant: ${tenant} (given)`);
  }
  /** @type {import('./tokens.js').AcquiredToken | undefined} */
  let token;
  const explicit = getEnv(env, 'ADO_NPM_EXEC_TOKEN')?.trim();
  if (explicit) {
    addSecret(explicit);
    const check = checkEntraToken(explicit, { tenant, nowMs: now() });
    tokenRows.push(`ADO_NPM_EXEC_TOKEN: ${check.ok ? `usable (${describeClaims(check.claims)}); it takes precedence` : `NOT usable: ${check.reason}`}`);
    if (check.ok) token = { token: explicit, source: 'ADO_NPM_EXEC_TOKEN', claims: check.claims };
    else find('error', `ADO_NPM_EXEC_TOKEN is not usable: ${check.reason}.`);
  }
  /** @type {NodeJS.ProcessEnv} */
  const toolEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k.toLowerCase() !== 'ado_npm_exec_token'));
  for (const tool of /** @type {const} */ (['az', 'azd', 'azureauth'])) {
    const t0 = now();
    try {
      const got = await o.acquire({
        env: toolEnv,
        tenant,
        platform,
        timeoutMs: timeoutFromEnv(env),
        find: (cmd, opts) => (cmd === tool ? findOnPath(cmd, opts) : undefined),
      });
      addSecret(got.token);
      tokenRows.push(`${tool}: token (${describeClaims(got.claims)}) in ${seconds(now() - t0)}`);
      token ??= got;
    } catch (error) {
      if (!(error instanceof TokenError)) throw error;
      const attempt = error.attempts.find((a) => a.source === tool);
      tokenRows.push(`${tool}: ${attempt?.reason ?? error.message}${attempt?.notFound ? '' : ` (${seconds(now() - t0)})`}`);
    }
  }
  const { prefer } = signInMemory(cacheDir ? stateDir(cacheDir) : undefined, tenant);
  tokenRows.push(
    prefer
      ? `remembered sign-in tool${tenant ? ` for tenant ${tenant}` : ''}: ${prefer} (a start runs it first, alone; the others only when it has no token)`
      : `remembered sign-in tool${tenant ? ` for tenant ${tenant}` : ''}: none yet (a start tries az, azd and azureauth, one at a time)`,
  );
  if (!token) {
    const login = azLoginCommands({ tenant, env, platform }).map((c) => (typeof c === 'string' ? c : `${c.label}: ${c.command}`));
    find('error', `No token source works. Sign in once: ${login.join('  |  ')}  (or: ado-npm-exec --login <feed-url>)`);
  } else if (tenant && typeof token.claims.tid === 'string' && token.claims.tid.toLowerCase() !== tenant.toLowerCase()) {
    find('error', `The token is for tenant ${token.claims.tid}, the feed belongs to ${tenant}.`);
  }
  section('Tenant and token sources (tokens are never printed)', tokenRows);

  if (registry && spec && token) {
    /** @type {string[]} */
    const feedRows = [];
    const t0 = now();
    const res = await o.resolve({ registry, spec, token: token.token, npmVersion, ...npmPickOptions(env) });
    const took = seconds(now() - t0);
    if (res.kind === 'resolved') feedRows.push(`${spec.raw} is ${res.version} (${res.via}, ${took})`);
    else feedRows.push(`${spec.raw}: ${res.kind}: ${res.detail} (${took})`);
    if (res.kind === 'refused') find('error', `The feed refused the token (${res.detail}): the account needs the Reader role on the feed.`);
    if (res.kind === 'not-found') find('error', `${spec.name} is not on the feed or its upstream sources.`);
    if (res.kind === 'no-match') find('error', `${res.detail}${res.latest ? `; its latest version is ${res.latest}` : ''}.`);
    if (res.kind === 'unavailable') find('warn', `The feed could not be asked (${res.detail}).`);
    if (res.kind === 'resolved') {
      const doc = await fetchPackument({ registry, spec, token: token.token, fetchImpl: o.fetchImpl });
      const tarball = doc.ok ? /** @type {any} */ (doc.body)?.versions?.[res.version]?.dist?.tarball : undefined;
      if (typeof tarball === 'string') {
        const probe = await probeTarball({ url: tarball, registry, token: token.token, fetchImpl: o.fetchImpl });
        feedRows.push(
          `download: ${probe.host}${probe.status !== undefined ? ` HTTP ${probe.status}` : ''}${probe.redirectHost ? ` -> ${probe.redirectHost} HTTP ${probe.blobStatus ?? '-'}` : ''}${probe.ok ? '' : ` (${probe.detail})`}`,
        );
        if (!probe.ok) {
          find('error', `npm cannot download the package: ${probe.detail}.${probe.redirectHost ? ` Allow ${probe.redirectHost} in your proxy or firewall.` : ''}`);
        }
      } else {
        feedRows.push(`download: not checked (${doc.ok ? `version ${res.version} is not in the packument` : doc.detail})`);
        // An exact version is not looked up before npm runs: this is where a
        // refused token or a missing package shows.
        if (!doc.ok && (doc.status === 401 || doc.status === 403)) {
          find('error', `The feed refused the token (${doc.detail}): the account needs the Reader role on the feed.`);
        } else if (!doc.ok && doc.status === 404) {
          find('error', `${spec.name} is not on the feed or its upstream sources (${doc.detail}).`);
        } else if (doc.ok) {
          find('error', `${spec.name}@${res.version} is not on the feed.`);
        } else {
          find('warn', `The package's registry metadata could not be read (${doc.detail}).`);
        }
      }
    }
    section('Feed', feedRows);
  }

  if (registry && spec && cacheDir) {
    const dir = stateDir(cacheDir);
    const pick = npmPickOptions(env);
    const state = readState(dir, stateKey(registry.href, spec.raw, pick));
    const t = now();
    /** @type {string[]} */
    const rows = [];
    if (state) {
      rows.push(
        `last resolved version: ${state.version ?? 'none'}${state.previous ? ` (before: ${state.previous})` : ''}`,
        `last check of the feed: ${state.checkedAt ? ago(t - state.checkedAt) : 'never'}${state.failures ? `; ${state.failures} failed since, next not before ${state.nextCheckAt ? isoTime(state.nextCheckAt) : 'now'}` : ''}`,
        `last start: ${state.usedAt ? ago(t - state.usedAt) : 'never'}`,
        `installed by ado-npm-exec: ${state.installed?.join(', ') || 'none recorded'}`,
      );
      if (state.offlineFailedAt) find('warn', `The last start from npm's cache failed (${ago(t - state.offlineFailedAt)}): the next start asks the feed.`);
      if (state.missingAt) {
        find('warn', `The feed had no version for ${spec.raw} at the last check (${ago(t - state.missingAt)}): the next start asks the feed instead of starting the copy in npm's cache.`);
      }
    } else {
      rows.push('no record yet (never started by this version of ado-npm-exec)');
    }
    const wanted = classifyWanted(spec.range ?? '');
    const exact = wanted?.type === 'version' ? wanted.version : undefined;
    const version = exact ?? state?.version;
    if (version) {
      const runSpec = `${spec.name}@${version}`;
      const inst = readNpxInstall(cacheDir, runSpec, spec.name);
      const foreign = inst.complete && !isFromFeedOrg(registry.href, inst.resolved);
      const status = !inst.exists
        ? 'not installed'
        : !inst.complete
          ? 'INCOMPLETE install (redone at the next start that asks the feed)'
          : foreign
            ? `installed from ${installOrigin(inst)}, NOT from this feed (never run; replaced at the next start that asks the feed)`
            : 'installed';
      rows.push(`${runSpec}: ${status} (${inst.dir})`);
      if (inst.exists && !inst.complete) find('warn', `The install of ${runSpec} in npm's cache is incomplete; it is redone at the next start that asks the feed.`);
      if (foreign) {
        find(
          'warn',
          `npm's cache holds ${runSpec} from ${installOrigin(inst)}, not from this feed (a manual npx with another registry?). ` +
            'ado-npm-exec never runs it; the next start that asks the feed replaces it.',
        );
      }
    }
    rows.push(`registry metadata cached: ${isCached(cacheDir, packumentCacheKey(registry.href, spec.name), { fullMetadata: !!pick.before }) ? 'yes' : 'no'}`);
    const start = pick.before ? undefined : findCachedStart({ cacheDir, registry, spec, exact, state });
    rows.push(
      alwaysFresh
        ? 'next start: resolves the spec on the feed (always-fresh)'
        : start && !state?.offlineFailedAt && !state?.missingAt
          ? `next start: ${start.runSpec} from npm's cache, no token and no network`
          : `next start: asks the feed (needs a token${pick.before ? "; npm's before setting is on" : ''})`,
    );
    const { leases, complete } = readLeases(dir);
    const running = leases.filter((l) => l.name === spec.name).map((l) => l.version);
    rows.push(`running sessions: ${running.length ? running.join(', ') : 'none'}${complete ? '' : ' (some leases cannot be read)'}`);
    section("npm's cache for this package", rows);
  }

  const errors = findings.filter((f) => f.level === 'error').length;
  const warnings = findings.filter((f) => f.level === 'warn').length;
  const head = [
    `ado-npm-exec doctor ${version}, ${isoTime(now())}: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`,
    'No token is ever printed, but the report shows your account, tenant, feed and folder names: review it before you share it.',
    '',
    'Findings',
    ...(findings.length ? findings.map((f) => `  [${f.level}] ${f.text}`) : ['  none']),
  ];
  o.write(`${redact([...head, ...body].join('\n'))}\n`);
  return errors > 0 ? 1 : 0;
}
