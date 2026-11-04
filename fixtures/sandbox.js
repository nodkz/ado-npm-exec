// Test sandboxes and helpers for end-to-end runs. ado-npm-exec refuses a
// temp directory whose parents other users can write to (like /tmp on
// Linux), so sandboxes live inside the repository checkout instead (ignored
// by git).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../src/state.js';

const FAKE_TOOL = fileURLToPath(new URL('./fake-tool.js', import.meta.url));
const FAKE_NPM = fileURLToPath(new URL('./fake-npm/npm-cli.js', import.meta.url));

export const TEST_TMP_BASE = fileURLToPath(new URL('../.tmp-test/', import.meta.url));

/** @param {string} [prefix] */
export function makeTestRoot(prefix = 'run-') {
  fs.mkdirSync(TEST_TMP_BASE, { recursive: true });
  return fs.mkdtempSync(path.join(TEST_TMP_BASE, prefix));
}

/**
 * Put stand-ins for sign-in tools (see fake-tool.js) into `dir`, as the
 * platform runs them: a shell script, or a .cmd file on Windows. `label`
 * shows up in the log, to tell copies apart.
 *
 * @param {string} dir
 * @param {string[]} [tools]
 * @param {{ label?: string }} [opts]
 * @returns {string} dir
 */
export function installFakeTools(dir, tools = ['az', 'azd', 'azureauth'], { label = 'tool' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const tool of tools) {
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(dir, `${tool}.cmd`), `@set FAKE_TOOL_LABEL=${label}\r\n@"${process.execPath}" "${FAKE_TOOL}" ${tool} %*\r\n`);
    } else {
      fs.writeFileSync(path.join(dir, tool), `#!/bin/sh\nFAKE_TOOL_LABEL=${label} exec "${process.execPath}" "${FAKE_TOOL}" ${tool} "$@"\n`, { mode: 0o755 });
    }
  }
  return dir;
}

/**
 * The calls fake-tool.js logged.
 *
 * @param {string} file
 * @returns {{ tool: string, label: string, args: string[], cwd: string, env: Record<string, string>, stdin?: string }[]}
 */
export function readToolLog(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/**
 * A home, a temp folder and an npm cache for one run of the CLI, with the
 * fake npm (fake-npm/npm-cli.js) as the npm it finds.
 *
 * @param {string} [prefix]
 */
export function cliSandbox(prefix = 'cli-') {
  const root = makeTestRoot(prefix);
  const tmp = path.join(root, 'tmp');
  const home = path.join(root, 'home');
  const cache = path.join(root, 'npm-cache');
  for (const d of [tmp, home, cache]) fs.mkdirSync(d);
  const record = path.join(root, 'record.json');
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    PATH: path.dirname(process.execPath),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    npm_config_cache: cache,
    npm_execpath: FAKE_NPM,
    npm_node_execpath: process.execPath,
    FAKE_NPM_RECORD: record,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT, ComSpec: process.env.ComSpec } : {}),
  };
  return {
    root,
    env,
    cache,
    dir: stateDir(cache),
    record,
    /** What the fake npm recorded about the run of the package. @returns {any} */
    read: () => JSON.parse(fs.readFileSync(record, 'utf8')),
    /** npm's install steps (picking a version, installing one), oldest first. @returns {any[]} */
    readSteps: () => {
      try {
        return fs.readFileSync(`${record}.steps`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    /** Token folders left in the temp folder. */
    leftovers: () => fs.readdirSync(tmp).filter((n) => n.startsWith('ado-npm-exec-')),
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Run node with `args`, output captured, `input` on its stdin.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {{ input?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
export function runNode(args, env, { input = '', timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

/**
 * Whether `cond` holds within `ms`, checked every `stepMs`.
 *
 * @param {() => boolean} cond
 * @param {number} ms
 * @param {number} [stepMs]
 */
export async function waitFor(cond, ms, stepMs = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}
