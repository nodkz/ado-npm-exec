/**
 * Process helpers: a PATH lookup that the working directory cannot hijack,
 * and output capture with a timeout that stops the whole process tree.
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
 * True for a `node_modules/.bin` directory. `npm exec` puts the workspace's
 * (and every ancestor's) `node_modules/.bin` at the front of PATH, so any
 * dependency installed there could shadow `az`, `azureauth` or `npm`.
 *
 * @param {string} dir
 * @param {boolean} win
 */
export function isNodeModulesBin(dir, win) {
  const parts = dir.split(win ? /[\\/]+/ : /\/+/).filter(Boolean);
  const [a, b] = parts.slice(-2).map((s) => (win ? s.toLowerCase() : s));
  return a === 'node_modules' && b === '.bin';
}

/**
 * PATH without the entries a workspace may control: `node_modules/.bin`
 * folders (`npm exec` puts the workspace's first), and empty or relative
 * ones (they resolve against the current folder). For the sign-in tools and
 * every npm step that has the token: they and the programs they start
 * (`sh`, `git`) must not come from a workspace. All case variants of the key.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} [platform]
 * @returns {NodeJS.ProcessEnv}
 */
export function withTrustedPath(env, platform = process.platform) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  /** @type {NodeJS.ProcessEnv} */
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() !== 'path' || out[key] === undefined) continue;
    out[key] = /** @type {string} */ (out[key])
      .split(p.delimiter)
      .filter((entry) => {
        const d = win ? entry.replace(/^"(.*)"$/, '$1') : entry;
        const absolute = win ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(d) : p.isAbsolute(d);
        return absolute && !isNodeModulesBin(d, win);
      })
      .join(p.delimiter);
  }
  return out;
}

/**
 * Resolve an executable on PATH. Skipped entries:
 * - empty and relative ones: they resolve against the current directory,
 *   which an MCP client typically sets to an arbitrary workspace;
 * - `node_modules/.bin` ones: `npm exec` adds the workspace's there.
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
    if (!dir || !absolute || isNodeModulesBin(dir, win)) continue;
    for (const ext of exts) {
      const candidate = p.join(dir, cmd + ext);
      if (isFile(candidate) && (win || isExecutable(candidate))) return candidate;
    }
  }
  return undefined;
}

/**
 * How to spawn `file` without a shell where possible. Windows batch files
 * (`az.cmd`) cannot run without cmd.exe. The command line is built here (the
 * path quoted, arguments limited to characters cmd.exe treats literally) and
 * passed as a single string: Node 24+ deprecates `shell: true` with an
 * argument array (DEP0190).
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
  return { command: [`"${file}"`, ...args].join(' '), args: [], shell: true };
}

/**
 * Kill a process and everything it started, on Windows: taskkill /T /F from
 * System32 (never from PATH).
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.ProcessEnv} [env]
 */
export function killProcessTree(child, env = process.env) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const root = getEnv(env, 'SystemRoot') || 'C:\\Windows';
  try {
    spawn(path.win32.join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      .on('error', () => child.kill())
      .unref();
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
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
 * A working directory for the authentication helpers that no workspace
 * controls: an MCP client starts us in an arbitrary project, and az, azd and
 * azureauth read configuration from their current directory (azd, for
 * example, looks for an `azure.yaml` project there and in its parents). Same
 * choice as @azure/identity: %SystemRoot% on Windows, /bin elsewhere.
 *
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(p: string) => boolean} [isDir]
 * @returns {string}
 */
export function safeWorkingDir(platform = process.platform, env = process.env, isDir = defaultIsDir) {
  if (platform === 'win32') {
    const root = getEnv(env, 'SystemRoot') || 'C:\\Windows';
    return path.win32.isAbsolute(root) ? root : 'C:\\Windows';
  }
  return isDir('/bin') ? '/bin' : '/';
}

/** @param {string} p */
function defaultIsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @typedef {object} CaptureOptions
 * @property {NodeJS.ProcessEnv} env
 * @property {number} timeoutMs
 * @property {AbortSignal} [signal]
 * @property {number} [maxBytes]  stdout keeps its first, stderr its last maxBytes (errors come last)
 * @property {string} [cwd]  working directory (default: ours)
 * @property {(pid: number) => void} [onSpawn]  told the pid of the started process
 */

/** After a stop, how long the process tree gets for SIGTERM before SIGKILL. */
export const STOP_GRACE_MS = 1500;

/**
 * Signal the process group a captured child leads (POSIX), or the tree
 * (Windows: SIGTERM is taskkill /T /F, SIGKILL kills the child).
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {'SIGTERM' | 'SIGKILL'} sig
 */
function signalTree(child, sig) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    if (sig === 'SIGTERM') killProcessTree(child);
    else {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    return;
  }
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // already gone
    }
  }
}

/**
 * Whether anything of a captured child's tree still runs: its process group
 * (POSIX), or the child itself (Windows).
 *
 * @param {import('node:child_process').ChildProcess} child
 */
function treeAlive(child) {
  if (child.pid === undefined) return false;
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/**
 * Run a command with stdin closed and stdout/stderr captured (never
 * inherited: our stdout is the MCP channel). The promise settles shortly
 * after the process exits, even if a grandchild still holds the pipes open.
 * On the timer or an abort the process tree is stopped (SIGTERM, then
 * SIGKILL after STOP_GRACE_MS), and the promise settles only once the tree is
 * gone (at most a second after SIGKILL): callers release locks and remove
 * token files after the tool has really stopped.
 *
 * @param {string} file
 * @param {readonly string[]} args
 * @param {CaptureOptions} opts
 * @returns {Promise<CaptureResult>}
 */
export function runCapture(file, args, { env, timeoutMs, signal, maxBytes = 64 * 1024, cwd, onSpawn }) {
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
        ...(cwd ? { cwd } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        shell: cmd.shell,
      });
    } catch (error) {
      resolve({ ...base, error: /** @type {Error} */ (error) });
      return;
    }

    if (child.pid !== undefined) {
      try {
        onSpawn?.(child.pid);
      } catch {
        // the caller's bookkeeping must not break the capture
      }
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
      err.push(d);
      errLen += d.length;
      while (err.length > 1 && errLen - err[0].length >= maxBytes) errLen -= /** @type {Buffer} */ (err.shift()).length;
    });

    let settled = false;
    let timedOut = false;
    let aborted = false;
    /** @type {NodeJS.Timeout | undefined} */
    let grace;
    /** @type {NodeJS.Timeout | undefined} */
    let stopping;
    const finish = (/** @type {Error | undefined} */ error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      clearInterval(stopping);
      signal?.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        code: child.exitCode,
        signal: child.signalCode,
        stdout: Buffer.concat(out).toString('utf8').slice(0, maxBytes),
        stderr: Buffer.concat(err).toString('utf8').slice(-maxBytes),
        timedOut,
        aborted,
        ...(error ? { error } : {}),
      });
    };
    const stop = () => {
      if (stopping || settled) return;
      clearTimeout(timer);
      const startedAt = Date.now();
      let killed = false;
      signalTree(child, 'SIGTERM');
      stopping = setInterval(() => {
        if (!treeAlive(child)) return finish(undefined);
        const elapsed = Date.now() - startedAt;
        if (!killed && elapsed >= STOP_GRACE_MS) {
          killed = true;
          signalTree(child, 'SIGKILL');
        }
        if (elapsed >= STOP_GRACE_MS + 1000) finish(undefined);
      }, 50);
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
      // While stopping, the interval waits for the whole tree instead.
      if (stopping) return;
      // 'close' waits for every holder of the pipes; do not wait forever.
      grace = setTimeout(() => finish(undefined), 250);
    });
    child.on('close', () => {
      if (!stopping) finish(undefined);
    });
  });
}
