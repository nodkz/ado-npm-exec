import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { descendantsOf, isAlive, npmForwardsSignals, readProcessTable } from '../src/tree.js';
import { resolveNpm } from '../src/npm-cli.js';

const holdPipes = fileURLToPath(new URL('../fixtures/hold-pipes.js', import.meta.url));

test('descendantsOf returns direct children and the whole subtree', () => {
  const table = new Map([
    [10, 1],
    [11, 10],
    [12, 10],
    [13, 11],
    [14, 13],
    [20, 1],
    [21, 20],
    [30, 30],
  ]);
  const tree = descendantsOf(10, table);
  assert.deepEqual(tree.direct.sort(), [11, 12]);
  assert.deepEqual(tree.all.sort(), [11, 12, 13, 14]);
  assert.deepEqual(descendantsOf(99, table), { direct: [], all: [] });
});

test('readProcessTable sees a real child and grandchild', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-npm-exec-test-'));
  const pidFile = path.join(dir, 'pid');
  const child = spawn(process.execPath, [holdPipes, pidFile], { stdio: 'ignore' });
  try {
    const end = Date.now() + 10_000;
    while (!(fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8')) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    const table = readProcessTable();
    assert.equal(table.get(/** @type {number} */ (child.pid)), process.pid);
    const tree = descendantsOf(/** @type {number} */ (child.pid), table);
    assert.deepEqual(tree.direct, [grandchild]);
    assert.ok(isAlive(grandchild));
    process.kill(grandchild, 'SIGKILL');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readProcessTable is empty on Windows', () => {
  assert.equal(readProcessTable('win32').size, 0);
});

test('isAlive', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(2 ** 22 + 12345), false);
});

test('npmForwardsSignals reads npm run-script signal handling', () => {
  const cli = path.join('/n', 'bin', 'npm-cli.js');
  const file = path.join('/n', 'node_modules', '@npmcli', 'run-script', 'lib', 'signal-manager.js');
  const read = (/** @type {string} */ p) => {
    if (p !== file) throw new Error('ENOENT');
    return 'const handleSignal = signal => {\n  for (const proc of runningProcs) {\n    proc.kill(signal)\n  }\n}';
  };
  assert.equal(npmForwardsSignals(cli, read), true);
  assert.equal(npmForwardsSignals(cli, () => 'const handleSignal = () => {}'), false, 'npm 10.2 traps and ignores');
  assert.equal(npmForwardsSignals(cli, () => { throw new Error('ENOENT'); }), false);
});

const npm = resolveNpm({ env: process.env });
test('npmForwardsSignals works on the installed npm', { skip: npm ? false : 'npm not found' }, () => {
  assert.ok(npm);
  assert.equal(typeof npmForwardsSignals(npm.cli), 'boolean');
});
