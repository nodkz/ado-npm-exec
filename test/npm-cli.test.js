import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNpm } from '../src/npm-cli.js';
import { buildNpmArgv, FORCED_NPM_FLAGS } from '../src/run.js';

/** @param {string[]} files */
const fsOf = (files) => {
  const set = new Set(files);
  return { exists: (/** @type {string} */ p) => set.has(p) };
};
const noPath = () => undefined;

test('prefers the outer npm (npm_execpath) on the node it ran on', () => {
  const r = resolveNpm({
    env: { npm_execpath: '/n/lib/node_modules/npm/bin/npm-cli.js', npm_node_execpath: '/n/bin/node' },
    execPath: '/other/bin/node',
    platform: 'linux',
    find: noPath,
    ...fsOf(['/n/lib/node_modules/npm/bin/npm-cli.js', '/n/bin/node']),
  });
  assert.deepEqual(r, { node: '/n/bin/node', cli: '/n/lib/node_modules/npm/bin/npm-cli.js' });
});

test('falls back to process.execPath when npm_node_execpath is missing', () => {
  const r = resolveNpm({
    env: { npm_execpath: '/n/npm-cli.js' },
    execPath: '/x/bin/node',
    platform: 'linux',
    find: noPath,
    ...fsOf(['/n/npm-cli.js']),
  });
  assert.deepEqual(r, { node: '/x/bin/node', cli: '/n/npm-cli.js' });
});

test('ignores npm_execpath from other package managers', () => {
  const r = resolveNpm({
    env: { npm_execpath: '/p/pnpm.cjs' },
    execPath: '/opt/node/bin/node',
    platform: 'linux',
    find: noPath,
    ...fsOf(['/p/pnpm.cjs', '/opt/node/lib/node_modules/npm/bin/npm-cli.js']),
  });
  assert.deepEqual(r, { node: '/opt/node/bin/node', cli: '/opt/node/lib/node_modules/npm/bin/npm-cli.js' });
});

test('finds the npm bundled next to node.exe on Windows', () => {
  const r = resolveNpm({
    env: {},
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32',
    find: noPath,
    ...fsOf(['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js']),
  });
  assert.deepEqual(r, { node: 'C:\\Program Files\\nodejs\\node.exe', cli: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js' });
});

test('falls back to npm on PATH (POSIX symlink and Windows npm.cmd)', () => {
  const posix = resolveNpm({
    env: {},
    execPath: '/usr/bin/node',
    platform: 'linux',
    find: () => '/usr/local/bin/npm',
    realpath: () => '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    ...fsOf(['/usr/local/lib/node_modules/npm/bin/npm-cli.js']),
  });
  assert.deepEqual(posix, { node: '/usr/bin/node', cli: '/usr/local/lib/node_modules/npm/bin/npm-cli.js' });
  const win = resolveNpm({
    env: {},
    execPath: 'C:\\n\\node.exe',
    platform: 'win32',
    find: () => 'C:\\Users\\u\\AppData\\Roaming\\npm\\npm.cmd',
    realpath: (p) => p,
    ...fsOf(['C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js']),
  });
  assert.deepEqual(win, { node: 'C:\\n\\node.exe', cli: 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js' });
});

test('returns undefined when npm cannot be found', () => {
  assert.equal(resolveNpm({ env: {}, execPath: '/x/bin/node', platform: 'linux', find: noPath, exists: () => false }), undefined);
});

test('finds the real npm in this environment', () => {
  const r = resolveNpm({ env: process.env });
  assert.ok(r, 'npm is resolvable where tests run');
});

test('npm argv forces safe settings before the spec and keeps passthrough args last', () => {
  assert.deepEqual(
    buildNpmArgv({ cli: '/n/npm-cli.js', prefixDir: '/t/d', registryHref: 'https://h/r/', spec: 'pkg@1', args: ['--x', '--'] }),
    ['/n/npm-cli.js', 'exec', '--prefix=/t/d', '--registry=https://h/r/', ...FORCED_NPM_FLAGS, '--', 'pkg@1', '--x', '--'],
  );
  for (const f of ['--yes', '--strict-ssl=true', '--foreground-scripts=false', '--json=false']) {
    assert.ok(FORCED_NPM_FLAGS.includes(f), f);
  }
});
