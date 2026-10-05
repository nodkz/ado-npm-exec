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
  ].map(normalize),
);

/**
 * @param {NodeJS.ProcessEnv} parentEnv
 * @param {{ npmrcFile: string, registryHost: string, scope?: string,
 *   platform?: NodeJS.Platform, execPath?: string }} opts
 * @returns {NodeJS.ProcessEnv}
 */
export function buildInnerEnv(parentEnv, { npmrcFile, registryHost, scope, platform = process.platform, execPath = process.execPath }) {
  const feedHostPrefix = normalize(`npm_config_//${registryHost}`);
  const scopeKey = scope ? normalize(`npm_config_@${scope}:registry`) : undefined;
  /** @type {string | undefined} */ let inheritedPrefix;
  /** @type {string | undefined} */ let envPrefix;
  let hasGlobalconfig = false;
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    const n = normalize(key);
    if (n === 'npm_config_prefix' && value) inheritedPrefix = value;
    if (n === 'prefix' && value) envPrefix = value;
    if (n === 'npm_config_globalconfig' && value) hasGlobalconfig = true;
    if (DROPPED.has(n) || n === scopeKey || n.startsWith(feedHostPrefix) || n.startsWith('ado_npm_exec_')) continue;
    out[key] = value;
  }
  out.npm_config_userconfig = npmrcFile;
  if (!hasGlobalconfig) {
    // The inner npm gets --prefix=<temp dir>, which would also move npm's
    // default global config to <temp dir>/etc/npmrc. Point it back at the
    // real one, located the way npm itself does it.
    const p = platform === 'win32' ? path.win32 : path.posix;
    const prefix = inheritedPrefix || envPrefix || (platform === 'win32' ? p.dirname(execPath) : p.dirname(p.dirname(execPath)));
    out.npm_config_globalconfig = p.join(prefix, 'etc', 'npmrc');
  }
  return out;
}
