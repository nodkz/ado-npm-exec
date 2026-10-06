/**
 * Process-tree helpers for shutting down everything the inner npm started.
 *
 * npm 10 (bundled with Node 20) traps SIGINT/SIGTERM without forwarding them,
 * npm 11 forwards them only to its direct child, and a package's bin may be a
 * launcher that starts the real server or install scripts may still be
 * running. Signalling npm's PID alone can therefore leave processes behind.
 * The child stays in our process group, so a client that signals the whole
 * group still reaches everything directly.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * pid -> parent pid for every visible process. Linux reads /proc; macOS and
 * other POSIX systems run ps from an absolute path (PATH may contain
 * workspace `node_modules/.bin` directories). Empty on failure.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {Map<number, number>}
 */
export function readProcessTable(platform = process.platform) {
  /** @type {Map<number, number>} */
  const table = new Map();
  if (platform === 'win32') return table;
  if (platform === 'linux' && fs.existsSync('/proc/self/stat')) {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
        // "pid (comm) state ppid ..."; comm may contain spaces and parentheses.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        table.set(Number(name), Number(fields[1]));
      } catch {
        // the process exited meanwhile
      }
    }
    return table;
  }
  for (const ps of ['/bin/ps', '/usr/bin/ps']) {
    try {
      const out = execFileSync(ps, ['-A', '-o', 'pid=', '-o', 'ppid='], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (m) table.set(Number(m[1]), Number(m[2]));
      }
      if (table.size > 0) return table;
    } catch {
      // try the next location
    }
  }
  return table;
}

/**
 * @param {number} root
 * @param {Map<number, number>} table
 * @returns {{ direct: number[], all: number[] }} children of root, and all descendants
 */
export function descendantsOf(root, table) {
  /** @type {Map<number, number[]>} */
  const children = new Map();
  for (const [pid, ppid] of table) {
    if (pid === ppid) continue;
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const direct = [...(children.get(root) ?? [])];
  /** @type {number[]} */
  const all = [];
  const seen = new Set([root]);
  const queue = [...direct];
  while (queue.length > 0) {
    const pid = /** @type {number} */ (queue.shift());
    if (seen.has(pid)) continue;
    seen.add(pid);
    all.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return { direct, all };
}

/** @param {number} pid */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/**
 * @param {number} pid
 * @param {NodeJS.Signals} signal
 */
export function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

/**
 * Whether this npm forwards SIGINT/SIGTERM to the script it runs (npm 10.9+
 * and 11 do; npm 10.2 traps and ignores them). Read from npm's own
 * @npmcli/run-script; unknown counts as "does not forward".
 *
 * @param {string} npmCli path to npm-cli.js
 * @param {(p: string) => string} [read]
 */
export function npmForwardsSignals(npmCli, read = (p) => fs.readFileSync(p, 'utf8')) {
  try {
    const root = path.dirname(path.dirname(npmCli));
    const source = read(path.join(root, 'node_modules', '@npmcli', 'run-script', 'lib', 'signal-manager.js'));
    return /\.kill\(\s*signal\s*\)/.test(source);
  } catch {
    return false;
  }
}
