/**
 * Locate npm's JavaScript entry point so it can be run as
 * `<node> <npm-cli.js> ...` without a shell. That sidesteps Windows'
 * `npm.cmd` (which since Node 18.20.2 / 20.12.2 can only be spawned with
 * `shell: true`) and every quoting problem that comes with it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { findOnPath, getEnv } from './proc.js';

/** @typedef {{ node: string, cli: string }} NpmCommand */

/** @param {string} p */
function defaultExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** @param {string} p */
function defaultRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * @param {{ env: NodeJS.ProcessEnv, execPath?: string, platform?: NodeJS.Platform,
 *   exists?: (p: string) => boolean, realpath?: (p: string) => string, find?: typeof findOnPath }} opts
 * @returns {NpmCommand | undefined}
 */
export function resolveNpm({
  env,
  execPath = process.execPath,
  platform = process.platform,
  exists = defaultExists,
  realpath = defaultRealpath,
  find = findOnPath,
}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const isCli = (/** @type {string | undefined} */ f) => !!f && p.basename(f) === 'npm-cli.js' && exists(f);

  // 1. The npm that launched us (the outer `npm exec`), on the node it ran on.
  const execpath = getEnv(env, 'npm_execpath');
  if (isCli(execpath)) {
    const nodeExec = getEnv(env, 'npm_node_execpath');
    return { node: nodeExec && exists(nodeExec) ? nodeExec : execPath, cli: /** @type {string} */ (execpath) };
  }

  // 2. The npm bundled with the running node.
  const bundled =
    platform === 'win32'
      ? p.join(p.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : p.join(p.dirname(p.dirname(execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (isCli(bundled)) return { node: execPath, cli: bundled };

  // 3. An npm found on (absolute entries of) PATH.
  const onPath = find('npm', { env, platform });
  if (onPath) {
    const real = realpath(onPath);
    const candidates = [
      real,
      p.join(p.dirname(onPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      p.join(p.dirname(p.dirname(real)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];
    for (const c of candidates) if (isCli(c)) return { node: execPath, cli: c };
  }
  return undefined;
}
