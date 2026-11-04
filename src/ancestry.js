/**
 * A Windows MCP client stops a server by killing only the process it started:
 * the top cmd.exe shim of the `npm exec` chain. Our parent stays alive, so we
 * find that shim here and watch it too.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { getEnv, safeWorkingDir } from './proc.js';

/** @typedef {{ ppid: number, name: string, cmd: string }} ProcInfo */

/** Command-line fragments of the processes between the client and us (matched case-insensitively). */
export const MACHINERY_MARKERS = Object.freeze(['ado-npm-exec', 'npm-cli.js', 'npx-cli.js']);

// Line breaks in a command line become spaces, so each process is one line.
const POWERSHELL_SCRIPT =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { ' +
  `"$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine -replace '[\\r\\n]+', ' ')" }`;

const POWERSHELL_ARGS = Object.freeze(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_SCRIPT]);

// execFile calls back only after the pipes close, which can be later than its timeout.
const SETTLE_GRACE_MS = 1000;

/** Launchers whose whole command line names what they run (image names without '.exe'). */
const LAUNCHERS = new Set(['npm', 'npx', 'ado-npm-exec', 'powershell', 'pwsh', 'bash', 'sh']);

/** @param {string | undefined} text */
function hasMarker(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return MACHINERY_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Where the program name of a Windows command line ends: at the first space
 * or tab outside double quotes.
 *
 * @param {string} cmd
 * @returns {number}
 */
function programEnd(cmd) {
  return /^[ \t]*(?:"[^"]*"?|[^ \t"])*/.exec(cmd)?.[0].length ?? 0;
}

/**
 * The command cmd.exe runs: the text after its first /c or /k switch. Only
 * switches right after the program name count ('/d /s /c', '/d/s/c' and
 * '/cnpx' alike), so a '/c' in a path or in other text is not a switch.
 *
 * @param {string} cmd
 * @returns {string | undefined}
 */
function cmdCommand(cmd) {
  const rest = cmd.slice(programEnd(cmd));
  const switches = /^(?:[ \t]|\/(?![ck])[^ \t/]*)*\/[ck]/i.exec(rest);
  return switches ? rest.slice(switches[0].length) : undefined;
}

/**
 * The arguments after the program name, split by the rules of the Microsoft
 * C runtime. Double quotes group, and "" inside quotes is a literal quote.
 * Before a quote, 2n backslashes give n backslashes and the quote groups;
 * 2n + 1 backslashes give n backslashes and a literal quote. Other
 * backslashes are literal.
 *
 * @param {string} cmd
 * @returns {Generator<string>}
 */
function* windowsArgs(cmd) {
  let i = programEnd(cmd);
  while (i < cmd.length) {
    if (cmd[i] === ' ' || cmd[i] === '\t') {
      i++;
      continue;
    }
    let arg = '';
    let quoted = false;
    while (i < cmd.length && (quoted || (cmd[i] !== ' ' && cmd[i] !== '\t'))) {
      let slashes = 0;
      while (cmd[i + slashes] === '\\') slashes++;
      if (cmd[i + slashes] !== '"') {
        arg += slashes ? cmd.slice(i, i + slashes) : cmd[i];
        i += slashes || 1;
        continue;
      }
      arg += '\\'.repeat(slashes >> 1);
      i += slashes + 1;
      if (slashes % 2) {
        arg += '"';
      } else if (quoted && cmd[i] === '"') {
        arg += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    }
    yield arg;
  }
}

/** Node options that take the next argument as their value when written without '='. */
const NODE_VALUE_OPTIONS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--title',
  '--inspect-port', '--debug-port', '--env-file', '--env-file-if-exists', '--watch-path', '--disable-warning',
  '--redirect-warnings', '--icu-data-dir', '--openssl-config', '--diagnostic-dir', '--report-dir', '--report-directory',
  '--report-filename', '--report-signal', '--heapsnapshot-signal', '--secure-heap', '--secure-heap-min',
  '--max-http-header-size', '--unhandled-rejections', '--dns-result-order', '--experimental-config-file',
  '--localstorage-file',
]);

/** Node options that run inline code instead of a script file. */
const NODE_EVAL_OPTIONS = new Set(['-e', '--eval', '-p', '--print', '-pe']);

/**
 * The script file node.exe runs: its first argument that is not a Node option
 * or the value of one. After '--', the next argument is the script. Undefined
 * for inline code (-e, -p) and for a script from stdin ('-').
 *
 * @param {string} cmd
 * @returns {string | undefined}
 */
function nodeScript(cmd) {
  const args = [...windowsArgs(cmd)];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return args[i + 1];
    if (!arg.startsWith('-')) return arg;
    // Node also accepts '_' for '-' in option names.
    const option = arg.split('=')[0].replaceAll('_', '-');
    if (arg === '-' || NODE_EVAL_OPTIONS.has(option)) return undefined;
    if (NODE_VALUE_OPTIONS.has(option) && !arg.includes('=')) i++;
  }
  return undefined;
}

/**
 * Whether a process is launch machinery, judged by its image name
 * (case-insensitive, '.exe' optional) and the command that program runs:
 * - cmd: the command after its first /c or /k switch has a marker.
 * - node: its script file has a marker.
 * - a launcher (npm, npx, a shell; see LAUNCHERS): its command line has a marker.
 * - any other program, and an empty name: never.
 * So a client is not machinery when only its arguments mention a marker (an
 * inline MCP config, a config file path).
 *
 * @param {string} cmd the command line
 * @param {string} name the image name, e.g. 'cmd.exe' or 'node.exe'
 * @returns {boolean}
 */
export function isLaunchMachinery(cmd, name) {
  if (typeof cmd !== 'string' || typeof name !== 'string') return false;
  const program = name.trim().toLowerCase().replace(/\.exe$/, '');
  if (program === 'cmd') return hasMarker(cmdCommand(cmd));
  if (program === 'node') return hasMarker(nodeScript(cmd));
  return LAUNCHERS.has(program) && hasMarker(cmd);
}

/** @param {string} s */
function toPid(s) {
  const t = s.trim();
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * @param {string} line
 * @returns {[number, ProcInfo] | undefined}
 */
function parseLine(line) {
  const row = /^([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/s.exec(line);
  if (!row) return undefined;
  const pid = toPid(row[1]);
  const ppid = toPid(row[2]);
  if (pid === undefined || ppid === undefined) return undefined;
  return [pid, { ppid, name: row[3].trim(), cmd: row[4] }];
}

/**
 * Parse `pid|ppid|name|command line` rows, one per line (CRLF or LF). Image
 * names cannot contain '|', so only the first three '|' split a row.
 * Whitespace around pid, ppid and name is trimmed. Other lines and rows
 * without a non-negative integer pid and ppid are ignored. A pid listed twice
 * is dropped as ambiguous.
 *
 * @param {string} text
 * @returns {Map<number, ProcInfo>}
 */
export function parseProcessTable(text) {
  /** @type {Map<number, ProcInfo>} */
  const table = new Map();
  /** @type {Set<number>} */
  const duplicates = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const row = parseLine(line);
    if (!row || duplicates.has(row[0])) continue;
    if (table.has(row[0])) {
      table.delete(row[0]);
      duplicates.add(row[0]);
    } else {
      table.set(row[0], row[1]);
    }
  }
  return table;
}

/**
 * Windows PowerShell by absolute path (never through PATH, which may contain
 * workspace directories). A relative SystemRoot would resolve against the
 * current directory, so only a drive-absolute one is used.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function powershellPath(env = process.env) {
  const root = getEnv(env, 'SystemRoot');
  const systemRoot = root && /^[A-Za-z]:[\\/]/.test(root) ? root : 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Every process with its parent, image name and command line, from one
 * PowerShell run. Never rejects or throws: a failure, a timeout or empty
 * output gives an empty table. So does an abort of `signal`, at once: the
 * timer is cleared and execFile stops PowerShell.
 *
 * @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number, signal?: AbortSignal,
 *   execFileImpl?: (file: string, args: string[],
 *     options: import('node:child_process').ExecFileOptionsWithStringEncoding & { signal?: AbortSignal },
 *     callback: (error: Error | null, stdout: string) => void) => { stdin?: import('node:stream').Writable | null } | void }} [opts]
 * @returns {Promise<Map<number, ProcInfo>>}
 */
export function readWindowsProcessTable({ env = process.env, timeoutMs = 8000, execFileImpl = execFile, signal } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    /** @param {Map<number, ProcInfo>} table */
    const finish = (table) => {
      if (settled) return;
      settled = true;
      resolve(table);
      clearTimeout(timer);
      signal?.removeEventListener('abort', giveUp);
    };
    const giveUp = () => finish(new Map());
    try {
      if (signal?.aborted) return giveUp();
      signal?.addEventListener('abort', giveUp, { once: true });
      timer = setTimeout(giveUp, timeoutMs + SETTLE_GRACE_MS);
      const child = execFileImpl(
        powershellPath(env),
        [...POWERSHELL_ARGS],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', cwd: safeWorkingDir('win32', env), signal },
        (error, stdout) => finish(error ? new Map() : parseProcessTable(String(stdout))),
      );
      // Windows PowerShell may wait for the end of a redirected stdin before it exits.
      child?.stdin?.on('error', () => {}).end();
    } catch {
      giveUp();
    }
  });
}

/**
 * The launch processes above `pid`, nearest first, up to the first ancestor
 * that is not launch machinery (normally the MCP client, never included).
 * `boundaryReached` is true only when the walk stopped there: a missing row
 * (an ancestor already exited), a cycle, `maxDepth` or pid 0/1 leave the
 * chain incomplete.
 *
 * @param {number} pid
 * @param {Map<number, ProcInfo>} table
 * @param {{ maxDepth?: number }} [opts]
 * @returns {{ pids: number[], boundaryReached: boolean }}
 */
export function collectLaunchAncestry(pid, table, { maxDepth = 10 } = {}) {
  /** @type {number[]} */
  const pids = [];
  const seen = new Set([pid]);
  let current = table.get(pid)?.ppid;
  for (let depth = 0; current !== undefined && current > 1 && !seen.has(current) && depth < maxDepth; depth++) {
    seen.add(current);
    const row = table.get(current);
    if (!row) break;
    if (!isLaunchMachinery(row.cmd, row.name)) return { pids, boundaryReached: true };
    pids.push(current);
    current = row.ppid;
  }
  return { pids, boundaryReached: false };
}

/**
 * The topmost launch process above `pid`: on Windows, normally the cmd.exe
 * shim the client started, to watch in addition to our parent. Undefined off
 * Windows, when the table cannot be read, when `signal` aborts (the table
 * read gets it too) and when the walk did not reach the client: an incomplete
 * chain is never trusted. Never rejects.
 *
 * @param {number} pid
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, maxDepth?: number, signal?: AbortSignal,
 *   readTable?: (opts: { env: NodeJS.ProcessEnv, signal?: AbortSignal }) => Promise<Map<number, ProcInfo>> }} [opts]
 * @returns {Promise<number | undefined>}
 */
export async function resolveTopLaunchShim(
  pid,
  { platform = process.platform, readTable = readWindowsProcessTable, env = process.env, maxDepth, signal } = {},
) {
  if (platform !== 'win32') return undefined;
  try {
    if (signal?.aborted) return undefined;
    const table = await readTable({ env, signal });
    if (signal?.aborted) return undefined;
    const { pids, boundaryReached } = collectLaunchAncestry(pid, table, { maxDepth });
    return boundaryReached ? pids.at(-1) : undefined;
  } catch {
    return undefined;
  }
}
