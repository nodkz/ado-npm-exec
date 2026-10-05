/**
 * Minimal, dependency-free process helpers: PATH lookup that cannot be
 * hijacked through the working directory, and output capture with a hard
 * timeout that tears down the whole process tree.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Environment lookup that matches Windows' case-insensitive semantics.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @returns {string | undefined}
 */
export function getEnv(env, name) {
  if (env[name] !== undefined) return env[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) return env[key];
  }
  return undefined;
}

/** @param {string} p */
function defaultIsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** @param {string} p */
function defaultIsExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an executable on PATH. Empty and relative PATH entries are
 * skipped: they resolve against the current directory, which an MCP client
 * typically sets to an arbitrary workspace that could plant an `az`.
 *
 * @param {string} cmd
 * @param {{ env: NodeJS.ProcessEnv, platform?: NodeJS.Platform,
 *   isFile?: (p: string) => boolean, isExecutable?: (p: string) => boolean }} opts
 * @returns {string | undefined}
 */
export function findOnPath(cmd, { env, platform = process.platform, isFile = defaultIsFile, isExecutable = defaultIsExecutable }) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const exts = win ? (getEnv(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (let dir of (getEnv(env, 'PATH') || '').split(p.delimiter)) {
    if (win) dir = dir.replace(/^"(.*)"$/, '$1');
    const absolute = win ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(dir) : p.isAbsolute(dir);
    if (!dir || !absolute) continue;
    for (const ext of exts) {
      const candidate = p.join(dir, cmd + ext);
      if (isFile(candidate) && (win || isExecutable(candidate))) return candidate;
    }
  }
  return undefined;
}

/**
 * How to spawn `file` without a shell where possible. Windows batch files
 * (`az.cmd`) cannot run without cmd.exe; Node then joins command and
 * arguments unquoted, so the path is quoted here and anything cmd.exe could
 * reinterpret is refused.
 *
 * @param {string} file absolute path
 * @param {readonly string[]} args
 * @param {NodeJS.Platform} platform
 * @returns {{ command: string, args: string[], shell: boolean }}
 */
export function buildCommand(file, args, platform) {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(file)) return { command: file, args: [...args], shell: false };
  if (/["%!^\r\n\0]/.test(file)) throw new Error(`refusing to run ${file} through cmd.exe: unsafe characters in path`);
  for (const a of args) {
    if (!/^[A-Za-z0-9._:/=-]+$/.test(a)) throw new Error(`refusing to pass ${JSON.stringify(a)} through cmd.exe`);
  }
  return { command: `"${file}"`, args: [...args], shell: true };
}

/**
 * Kill a child and everything it started. POSIX children are spawned as
 * process-group leaders, so the group is killed; Windows uses taskkill /T
 * from System32 (never from PATH).
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function killProcessTree(child, platform = process.platform, env = process.env) {
  if (child.pid === undefined) return;
  if (platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const root = getEnv(env, 'SystemRoot') || 'C:\\Windows';
    try {
      spawn(path.win32.join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
        .on('error', () => child.kill())
        .unref();
      return;
    } catch {
      // fall through
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // not a group leader; fall through
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
}

/**
 * @typedef {object} CaptureResult
 * @property {number | null} code
 * @property {NodeJS.Signals | null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 * @property {boolean} aborted
 * @property {Error} [error]
 */

/**
 * @typedef {object} CaptureOptions
 * @property {NodeJS.ProcessEnv} env
 * @property {number} timeoutMs
 * @property {AbortSignal} [signal]
 * @property {number} [maxBytes]
 */

/**
 * Run a command with stdin closed and stdout/stderr captured (never
 * inherited: our stdout is the MCP channel). The promise settles on the
 * timer, on abort, or shortly after the process exits, even if a
 * grandchild still holds the pipes open.
 *
 * @param {string} file
 * @param {readonly string[]} args
 * @param {CaptureOptions} opts
 * @returns {Promise<CaptureResult>}
 */
export function runCapture(file, args, { env, timeoutMs, signal, maxBytes = 64 * 1024 }) {
  return new Promise((resolve) => {
    const base = { code: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false };
    /** @type {{ command: string, args: string[], shell: boolean }} */
    let cmd;
    /** @type {import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, import('node:stream').Readable>} */
    let child;
    try {
      cmd = buildCommand(file, args, process.platform);
      child = spawn(cmd.command, cmd.args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        shell: cmd.shell,
      });
    } catch (error) {
      resolve({ ...base, error: /** @type {Error} */ (error) });
      return;
    }

    /** @type {Buffer[]} */ const out = [];
    /** @type {Buffer[]} */ const err = [];
    let outLen = 0;
    let errLen = 0;
    child.stdout.on('data', (/** @type {Buffer} */ d) => {
      if (outLen < maxBytes) out.push(d);
      outLen += d.length;
    });
    child.stderr.on('data', (/** @type {Buffer} */ d) => {
      if (errLen < maxBytes) err.push(d);
      errLen += d.length;
    });

    let settled = false;
    let timedOut = false;
    let aborted = false;
    /** @type {NodeJS.Timeout | undefined} */
    let grace;
    const finish = (/** @type {Error | undefined} */ error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        code: child.exitCode,
        signal: child.signalCode,
        stdout: Buffer.concat(out).toString('utf8').slice(0, maxBytes),
        stderr: Buffer.concat(err).toString('utf8').slice(0, maxBytes),
        timedOut,
        aborted,
        ...(error ? { error } : {}),
      });
    };
    const stop = () => {
      killProcessTree(child);
      child.unref();
      finish(undefined);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => finish(error));
    child.on('exit', () => {
      // 'close' waits for every holder of the pipes; do not wait forever.
      grace = setTimeout(() => finish(undefined), 250);
    });
    child.on('close', () => finish(undefined));
  });
}
