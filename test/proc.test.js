import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOnPath, buildCommand, runCapture, getEnv } from '../src/proc.js';

const node = process.execPath;
const holdPipes = fileURLToPath(new URL('../fixtures/hold-pipes.js', import.meta.url));
const isWin = process.platform === 'win32';

/** @param {string} prefix */
function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** @param {() => boolean} cond @param {number} ms */
async function waitFor(cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

test('getEnv is case-insensitive', () => {
  assert.equal(getEnv({ Path: 'x' }, 'PATH'), 'x');
  assert.equal(getEnv({ PATH: 'y' }, 'PATH'), 'y');
  assert.equal(getEnv({}, 'PATH'), undefined);
});

test('findOnPath (POSIX) skips empty and relative entries', { skip: isWin }, () => {
  const dir = tmp('ado-npm-exec-test-');
  try {
    const exe = path.join(dir, 'fake-tool');
    fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'not-exec'), '', { mode: 0o644 });
    assert.equal(findOnPath('fake-tool', { env: { PATH: `:relative:${dir}` } }), exe);
    assert.equal(findOnPath('not-exec', { env: { PATH: dir } }), undefined);
    const rel = path.relative(process.cwd(), dir) || '.';
    assert.equal(findOnPath('fake-tool', { env: { PATH: `${rel}::.` } }), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findOnPath (Windows rules) uses PATHEXT, unquotes entries and skips relative ones', () => {
  const files = new Set(['C:\\Tools\\az.CMD', 'D:\\Rel\\az.cmd']);
  const isFile = (/** @type {string} */ p) => files.has(p);
  const env = { Path: '.;;relative\\dir;C:relative;"C:\\Tools"' };
  assert.equal(findOnPath('az', { env, platform: 'win32', isFile }), 'C:\\Tools\\az.CMD');
  assert.equal(findOnPath('az', { env: { PATH: 'D:Rel;relative' }, platform: 'win32', isFile }), undefined);
  assert.equal(
    findOnPath('az', { env: { PATH: 'D:\\Rel', PATHEXT: '.CMD' }, platform: 'win32', isFile: (p) => p === 'D:\\Rel\\az.CMD' }),
    'D:\\Rel\\az.CMD',
  );
});

test('buildCommand quotes Windows batch files and refuses unsafe input', () => {
  assert.deepEqual(buildCommand('/usr/bin/az', ['a b'], 'linux'), { command: '/usr/bin/az', args: ['a b'], shell: false });
  assert.deepEqual(buildCommand('C:\\x\\azureauth.exe', ['--tenant', 't'], 'win32'), {
    command: 'C:\\x\\azureauth.exe',
    args: ['--tenant', 't'],
    shell: false,
  });
  assert.deepEqual(buildCommand('C:\\Program Files (x86)\\CLI2\\wbin\\az.cmd', ['account', '--tenant', 'abc-1'], 'win32'), {
    command: '"C:\\Program Files (x86)\\CLI2\\wbin\\az.cmd"',
    args: ['account', '--tenant', 'abc-1'],
    shell: true,
  });
  assert.throws(() => buildCommand('C:\\%TEMP%\\az.cmd', [], 'win32'), /unsafe/);
  assert.throws(() => buildCommand('C:\\a"b\\az.bat', [], 'win32'), /unsafe/);
  assert.throws(() => buildCommand('C:\\ok\\az.cmd', ['a&b'], 'win32'), /refusing/);
  assert.throws(() => buildCommand('C:\\ok\\az.cmd', ['a b'], 'win32'), /refusing/);
});

test('runCapture captures output and exit code with stdin closed', async () => {
  const r = await runCapture(
    node,
    ['-e', "process.stdin.on('data',()=>{}).on('end',()=>{process.stdout.write('eof:'+process.env.FOO);process.stderr.write('err');process.exit(3)})"],
    { env: { ...process.env, FOO: 'bar' }, timeoutMs: 10_000 },
  );
  assert.equal(r.code, 3);
  assert.equal(r.stdout, 'eof:bar');
  assert.equal(r.stderr, 'err');
  assert.equal(r.timedOut, false);
});

test('runCapture caps captured output', async () => {
  const r = await runCapture(node, ['-e', "process.stdout.write('x'.repeat(200000))"], {
    env: process.env,
    timeoutMs: 10_000,
    maxBytes: 1000,
  });
  assert.equal(r.stdout.length, 1000);
});

test('runCapture reports spawn errors', async () => {
  const r = await runCapture(path.join(os.tmpdir(), 'definitely-missing-binary-xyz'), [], { env: process.env, timeoutMs: 5000 });
  assert.ok(r.error);
});

test('runCapture times out and kills the whole tree even when a grandchild holds the pipes', async () => {
  const dir = tmp('ado-npm-exec-test-');
  const pidFile = path.join(dir, 'pid');
  try {
    const started = Date.now();
    const r = await runCapture(node, [holdPipes, pidFile], { env: process.env, timeoutMs: 1500 });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 5000, 'settles from the timer');
    const gpid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(await waitFor(() => !alive(gpid), 5000), 'grandchild is killed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCapture settles soon after exit even if a grandchild keeps the pipes open', async () => {
  const dir = tmp('ado-npm-exec-test-');
  const pidFile = path.join(dir, 'pid');
  let gpid = 0;
  try {
    const started = Date.now();
    const r = await runCapture(node, [holdPipes, pidFile, 'exit'], { env: process.env, timeoutMs: 20_000 });
    gpid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(r.timedOut, false);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'started\n');
    assert.ok(Date.now() - started < 10_000);
  } finally {
    if (gpid) {
      try {
        process.kill(gpid);
      } catch {
        // already gone
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCapture stops on abort', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const r = await runCapture(node, ['-e', 'setInterval(()=>{},1000)'], { env: process.env, timeoutMs: 20_000, signal: ac.signal });
  assert.equal(r.aborted, true);
  const pre = new AbortController();
  pre.abort();
  const r2 = await runCapture(node, ['-e', 'setInterval(()=>{},1000)'], { env: process.env, timeoutMs: 20_000, signal: pre.signal });
  assert.equal(r2.aborted, true);
});

test('runCapture runs a tool from a directory with spaces and parentheses', async () => {
  const dir = tmp('ado-npm-exec-test-');
  const bin = path.join(dir, 'Program Files (x86)', 'CLI');
  fs.mkdirSync(bin, { recursive: true });
  try {
    let file;
    if (isWin) {
      file = path.join(bin, 'az.cmd');
      fs.writeFileSync(file, '@echo off\r\necho args:%*\r\n');
    } else {
      file = path.join(bin, 'az');
      fs.writeFileSync(file, '#!/bin/sh\necho "args:$*"\n', { mode: 0o755 });
    }
    assert.equal(findOnPath('az', { env: { PATH: bin, PATHEXT: '.CMD' } }), file);
    const r = await runCapture(file, ['account', 'get-access-token', '--tenant', 'abc-1'], { env: process.env, timeoutMs: 20_000 });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'args:account get-access-token --tenant abc-1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
