/**
 * Command lines and spawning of the inner npm.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { getEnv } from './proc.js';

/**
 * Settings forced on the inner npm, at command-line precedence so neither
 * the inherited environment nor any config file can override them:
 * - --yes: never prompt (stdin belongs to the MCP client)
 * - --scope=: no default scope, so unscoped packages use --registry
 * - --strict-ssl=true: certificates of https requests are checked (npm
 *   still sends the token over http, see the README)
 * - --foreground-scripts=false: install scripts must not inherit our
 *   stdin/stdout, which carry MCP JSON-RPC
 * - --json=false: npm errors must not be printed to stdout as JSON
 * - --update-notifier/--audit/--fund=false: no extra requests or output
 * - --replace-registry-host=registry.npmjs.org: a shrinkwrap's absolute
 *   registry.npmjs.org URLs go through the feed. A user `.npmrc` with
 *   `replace-registry-host=never` reaches us through the outer `npm exec`
 *   environment and would send those downloads past the feed (and fail where
 *   registry.npmjs.org is blocked). Not `always`: the feed's own tarball URLs
 *   (GUID paths on the same host) must stay as they are.
 * - --bin-links=true: the package's command is linked into its exec cache
 *   folder. Without the link (an inherited `bin-links=false`) npm would look
 *   the command up on PATH and could run the workspace's
 *   node_modules/.bin/<command> instead of the package.
 * - --install-strategy=hoisted: an inherited `linked` strategy writes a
 *   hidden lockfile without the package's version, so no install would ever
 *   count as complete.
 */
export const FORCED_NPM_FLAGS = Object.freeze([
  '--yes',
  '--scope=',
  '--strict-ssl=true',
  '--foreground-scripts=false',
  '--json=false',
  '--update-notifier=false',
  '--audit=false',
  '--fund=false',
  '--replace-registry-host=registry.npmjs.org',
  '--bin-links=true',
  '--install-strategy=hoisted',
]);

/**
 * The shell npm runs scripts and commands with, by absolute path: npm finds
 * a bare `sh` through PATH, and npm itself puts the `node_modules/.bin`
 * folders of the current folder and its parents first. A shell you set
 * yourself (`script-shell`) is kept when its path is absolute. On Windows
 * npm uses %ComSpec%, which is absolute.
 *
 * @param {NodeJS.ProcessEnv} innerEnv  the environment the inner npm gets
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
export function scriptShellFlags(innerEnv, platform = process.platform) {
  const configured = getEnv(innerEnv, 'npm_config_script_shell');
  if (platform === 'win32') {
    if (!configured || /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(configured)) return [];
    const root = getEnv(innerEnv, 'SystemRoot') || 'C:\\Windows';
    return [`--script-shell=${root}\\System32\\cmd.exe`];
  }
  return configured?.startsWith('/') ? [] : ['--script-shell=/bin/sh'];
}

/**
 * npm's default fetch timeout (300 s) also bounds a connection that sends
 * nothing at all, so a stalled request is retried only after five minutes
 * while an MCP client waits for the server. Two minutes of silence is still
 * far more than a feed needs to answer, also over a slow VPN.
 */
const NPM_FETCH_TIMEOUT_MS = 120_000;

const FETCH_TUNING_ENV_KEY = /^npm_config_fetch[-_](?:timeout|retries|retry[-_](?:mintimeout|maxtimeout|factor))$/i;
const FETCH_TUNING_NPMRC_LINE = /^[ \t]*fetch[-_](?:timeout|retries|retry[-_](?:mintimeout|maxtimeout|factor))[ \t]*=/im;

/**
 * `--fetch-timeout` for the inner npm, unless the user tuned npm's fetch
 * timing: in the environment (the outer `npm exec` exports user `.npmrc`
 * values there) or in the global npmrc the inner npm reads. A global npmrc
 * that cannot be read counts as tuned: what it says is unknown.
 *
 * @param {NodeJS.ProcessEnv} innerEnv  the environment the inner npm gets
 * @param {(p: string) => string} [readFile]
 * @returns {string[]}
 */
export function npmFetchFlags(innerEnv, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  for (const [key, value] of Object.entries(innerEnv)) {
    if (value && FETCH_TUNING_ENV_KEY.test(key)) return [];
  }
  const globalconfig = getEnv(innerEnv, 'npm_config_globalconfig');
  if (globalconfig) {
    try {
      if (FETCH_TUNING_NPMRC_LINE.test(readFile(globalconfig))) return [];
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return [];
    }
  }
  return [`--fetch-timeout=${NPM_FETCH_TIMEOUT_MS}`];
}

/**
 * How the inner npm may use the network:
 * - 'online': npm's default (it revalidates registry metadata);
 * - 'offline': cache only, no request at all (a start from npm's cache);
 * - 'prefer-offline': cached data without revalidation, the network for
 *   anything missing.
 *
 * @typedef {'online' | 'offline' | 'prefer-offline'} CacheMode
 */

/** @param {CacheMode | undefined} mode @returns {string[]} */
function cacheFlags(mode) {
  if (mode === 'offline') return ['--offline'];
  if (mode === 'prefer-offline') return ['--prefer-offline'];
  return [];
}

/**
 * The settings every inner npm gets. `--prefix=<private temp dir>` gives npm
 * an empty project: a `.npmrc` in the current folder cannot override the
 * token, and a same-name package in a local `node_modules` (or installed
 * globally) cannot run instead of the one from the feed. npm still runs the
 * command in the current folder. `--cache`: the folder ado-npm-exec checked
 * (see npmCacheDir).
 *
 * @param {{ prefixDir: string, registryHref: string, cacheDir: string }} input
 * @returns {string[]}
 */
export function npmBaseArgs({ prefixDir, registryHref, cacheDir }) {
  return [`--prefix=${prefixDir}`, `--registry=${registryHref}`, `--cache=${cacheDir}`, ...FORCED_NPM_FLAGS];
}

/**
 * `npm exec -- <spec> [args...]`: runs the package.
 *
 * @param {{ cli: string, prefixDir: string, registryHref: string, cacheDir: string, spec: string, args: readonly string[],
 *   cacheMode?: CacheMode, extraFlags?: readonly string[] }} input
 * @returns {string[]}
 */
export function buildNpmArgv({ cli, spec, args, cacheMode, extraFlags = [], ...base }) {
  return [cli, 'exec', ...npmBaseArgs(base), ...extraFlags, ...cacheFlags(cacheMode), '--', spec, ...args];
}

/**
 * Install `spec` into npm's exec cache without running it: the same
 * `_npx/<hash>` folder a later `npm exec -- <spec>` uses (npm hashes the
 * package list, and `--package=<spec>` and `-- <spec>` give the same list).
 * `exit 0` runs in the shell npm uses for scripts, which exists everywhere.
 * Its output is captured: no colors.
 *
 * @param {{ cli: string, prefixDir: string, registryHref: string, cacheDir: string, spec: string,
 *   cacheMode?: CacheMode, extraFlags?: readonly string[] }} input
 * @returns {string[]}
 */
export function buildPreinstallArgv({ cli, spec, cacheMode, extraFlags = [], ...base }) {
  return [cli, 'exec', ...npmBaseArgs(base), '--color=false', ...extraFlags, ...cacheFlags(cacheMode), `--package=${spec}`, '--call=exit 0'];
}

/**
 * @param {{ node: string, argv: readonly string[], env: NodeJS.ProcessEnv }} input
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnNpm({ node, argv, env }) {
  return spawn(node, argv, { stdio: 'inherit', env, windowsHide: true });
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null }>}
 */
export function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
