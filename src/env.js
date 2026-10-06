/**
 * Environment for the inner `npm exec`.
 *
 * The outer `npm exec` (the one that fetched ado-npm-exec from the public
 * registry) exports its effective config as `npm_config_*` variables,
 * including `npm_config_registry` pointing at the public registry and
 * `npm_config_userconfig`. Environment config outranks config files, so those
 * would override our temp npmrc. They are removed here, together with any
 * credential for the feed's host and our own ADO_NPM_EXEC_* variables.
 * Everything else (cache, proxy, cafile, other settings) is kept.
 */

import path from 'node:path';

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
