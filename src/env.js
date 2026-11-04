/**
 * Environment for the inner npm. The outer `npm exec` exports its config as
 * `npm_config_*` variables (its public registry, its userconfig), which would
 * outrank our temp npmrc: those are removed, with any credential for the
 * feed's host and our own ADO_NPM_EXEC_* variables. The rest is kept.
 */

import path from 'node:path';
import { getEnv } from './proc.js';

/** npm resolves config keys case-insensitively and treats "-" and "_" alike. */
const normalize = (/** @type {string} */ key) => key.toLowerCase().replace(/-/g, '_');

const DROPPED = new Set(
  [
    'npm_config_registry',
    'npm_config_userconfig',
    'npm_config_prefix',
    'npm_config_package',
    'npm_config_call',
    'npm_config_global',
    'npm_config_location',
    'npm_config_workspace',
    'npm_config_workspaces',
    'npm_config_include_workspace_root',
    // A default scope makes npm resolve unscoped packages through
    // `@<scope>:registry` instead of --registry.
    'npm_config_scope',
  ].map(normalize),
);

/**
 * @param {NodeJS.ProcessEnv} parentEnv
 * @param {{ npmrcFile: string, registryHost: string, scope?: string,
 *   platform?: NodeJS.Platform, execPath?: string }} opts
 * @returns {NodeJS.ProcessEnv}
 */
export function buildInnerEnv(parentEnv, { npmrcFile, registryHost, scope, platform = process.platform, execPath = process.execPath }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const feedHostPrefix = normalize(`npm_config_//${registryHost}`);
  const scopeKey = scope ? normalize(`npm_config_@${scope}:registry`) : undefined;
  /** @type {string | undefined} */ let inheritedPrefix;
  /** @type {string | undefined} */ let localPrefix;
  /** @type {string | undefined} */ let envPrefix;
  /** @type {string | undefined} */ let globalconfig;
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    const n = normalize(key);
    if (n === 'npm_config_prefix' && value) inheritedPrefix = value;
    if (n === 'npm_config_local_prefix' && value) localPrefix = value;
    if (n === 'prefix' && value) envPrefix = value;
    if (n === 'npm_config_globalconfig' && value) globalconfig = value;
    if (DROPPED.has(n) || n === scopeKey || n.startsWith(feedHostPrefix) || n.startsWith('ado_npm_exec_')) continue;
    // A scoped registry over plain http on the feed's host would receive the
    // token (npm matches credentials by host and path, not by protocol).
    if (/^npm_config_@[^:]+:registry$/.test(n) && !/^https:\/\//i.test(value.trim())) continue;
    out[key] = value;
  }
  out.npm_config_userconfig = npmrcFile;
  if (platform === 'win32') {
    // npm runs the package's bin through cmd.exe in the current folder, and
    // cmd.exe looks there before PATH: a workspace file <bin>.cmd would run
    // instead of the package.
    for (const k of Object.keys(out)) if (k.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete out[k];
    out.NoDefaultCurrentDirectoryInExePath = '1';
  }

  // The inner npm gets --prefix=<temp dir>, which also moves npm's default
  // global config to <temp dir>/etc/npmrc. The outer `npm exec --prefix=~/`
  // has the same effect and exports ~/etc/npmrc. In both cases point npm at
  // the real global config (proxy and CA settings often live there), located
  // the way npm itself does it. An explicitly configured one is kept.
  const same = (/** @type {string} */ a, /** @type {string} */ b) =>
    platform === 'win32' ? p.resolve(a).toLowerCase() === p.resolve(b).toLowerCase() : p.resolve(a) === p.resolve(b);
  const derivedFromCliPrefix =
    globalconfig !== undefined &&
    inheritedPrefix !== undefined &&
    localPrefix !== undefined &&
    same(inheritedPrefix, localPrefix) &&
    same(globalconfig, p.join(inheritedPrefix, 'etc', 'npmrc'));
  if (globalconfig === undefined || derivedFromCliPrefix) {
    const nodePrefix = platform === 'win32' ? p.dirname(execPath) : p.dirname(p.dirname(execPath));
    const prefix = envPrefix || (derivedFromCliPrefix ? undefined : inheritedPrefix) || nodePrefix;
    out.npm_config_globalconfig = p.join(prefix, 'etc', 'npmrc');
  }
  return out;
}

/**
 * Whether npm or Node is told to use an HTTP proxy.
 *
 * @param {NodeJS.ProcessEnv} env
 */
function proxyConfigured(env) {
  return ['npm_config_proxy', 'npm_config_https_proxy', 'https_proxy', 'http_proxy'].some((k) => !!getEnv(env, k));
}

/**
 * Whether this process's fetch uses the HTTPS_PROXY/HTTP_PROXY variables:
 * only with Node's own proxy support turned on (`NODE_USE_ENV_PROXY=1` from
 * Node 22.21 and 24, or `--use-env-proxy` from 22.21 and 24.5).
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ nodeVersion?: string, execArgv?: readonly string[] }} [opts]
 */
export function fetchUsesProxy(env, { nodeVersion = process.versions.node, execArgv = process.execArgv } = {}) {
  const [major, minor] = nodeVersion.split('.').map(Number);
  const since = (/** @type {number} */ m24) => major > 24 || (major === 24 && minor >= m24) || (major === 22 && minor >= 21);
  // The command line outranks NODE_OPTIONS; the last one wins.
  const flags = [...(getEnv(env, 'NODE_OPTIONS') ?? '').split(/\s+/), ...execArgv].filter((a) => /^--(?:no-)?use[-_]env[-_]proxy$/.test(a));
  const flag = flags.at(-1);
  const on = flag && since(5) ? !flag.startsWith('--no-') : getEnv(env, 'NODE_USE_ENV_PROXY') === '1' && since(0);
  return on && !!(getEnv(env, 'https_proxy') || getEnv(env, 'http_proxy'));
}

/**
 * Whether a proxy is configured that this process's fetch does not use:
 * tenant discovery and version lookups cannot reach the feed directly then,
 * but npm (which uses the proxy) can.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function proxyBlocksFetch(env) {
  return proxyConfigured(env) && !fetchUsesProxy(env);
}

/**
 * Whether Node's TLS certificate checks are off (a common workaround for an
 * intercepting proxy). Our own requests never carry the token then; npm,
 * which always gets --strict-ssl=true, makes the lookups instead.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function tlsChecksOff(env = process.env) {
  return getEnv(env, 'NODE_TLS_REJECT_UNAUTHORIZED') === '0';
}

/**
 * Whether version lookups go to npm instead of this process's fetch.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function lookupsNeedNpm(env) {
  return proxyBlocksFetch(env) || tlsChecksOff(env);
}

/**
 * npm settings that change which version npm picks for a spec, so that our
 * own pick matches: `tag` (the default dist-tag) and `before` (a date).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ defaultTag?: string, before?: string }}
 */
export function npmPickOptions(env) {
  const defaultTag = getEnv(env, 'npm_config_tag')?.trim();
  const before = getEnv(env, 'npm_config_before')?.trim();
  return { ...(defaultTag ? { defaultTag } : {}), ...(before ? { before } : {}) };
}
