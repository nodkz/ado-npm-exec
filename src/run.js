/**
 * Spawning the inner `npm exec`.
 */

import { spawn } from 'node:child_process';

/**
 * Settings forced on the inner npm, at command-line precedence so neither
 * the inherited environment nor any config file can override them:
 * - --yes: never prompt (stdin belongs to the MCP client)
 * - --scope=: no default scope, so unscoped packages use --registry
 * - --strict-ssl=true: the token only travels over verified TLS
 * - --foreground-scripts=false: install scripts must not inherit our
 *   stdin/stdout, which carry MCP JSON-RPC
 * - --json=false: npm errors must not be printed to stdout as JSON
 * - --update-notifier/--audit/--fund=false: no extra requests or output
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
]);

/**
 * `--prefix=<private temp dir>` gives npm an empty project: a `.npmrc` in the
 * current directory cannot override the token, and a same-name package in a
 * local `node_modules` (or installed globally) cannot be picked instead of
 * the one from the feed. npm still runs the command in the current directory.
 *
 * @param {{ cli: string, prefixDir: string, registryHref: string, spec: string, args: readonly string[] }} input
 * @returns {string[]}
 */
export function buildNpmArgv({ cli, prefixDir, registryHref, spec, args }) {
  return [cli, 'exec', `--prefix=${prefixDir}`, `--registry=${registryHref}`, ...FORCED_NPM_FLAGS, '--', spec, ...args];
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
