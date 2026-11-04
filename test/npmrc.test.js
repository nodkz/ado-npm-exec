import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderNpmrc, createTempNpmrc, isTrustedDir, chooseBaseDir, findShadowingBin, sweepStaleTempDirs, UnsafeTempError } from '../src/npmrc.js';
import { validateRegistryUrl } from '../src/registry.js';
import { validJwt } from '../fixtures/jwt.js';

const registry = validateRegistryUrl('https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/');

test('renders registry, scope registry and a path-scoped token', () => {
  const token = validJwt();
  assert.equal(
    renderNpmrc({ registry, token, scope: 'contoso' }),
    'registry=https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/\n' +
      '@contoso:registry=https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/\n' +
      `//pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/:_authToken=${token}\n`,
  );
  assert.doesNotMatch(renderNpmrc({ registry, token }), /@/);
});

test('refuses anything that could inject ini lines', () => {
  const token = validJwt();
  assert.throws(() => renderNpmrc({ registry, token: `${token}\n_auth=x` }), /not a JWT/);
  assert.throws(() => renderNpmrc({ registry, token: 'not-a-jwt' }), /not a JWT/);
  assert.throws(() => renderNpmrc({ registry: { ...registry, href: `${registry.href}\nx=y/` }, token }), /unsafe registry/);
  assert.throws(() => renderNpmrc({ registry: { ...registry, nerfDart: '//h/p;x/' }, token }), /unsafe registry/);
  assert.throws(() => renderNpmrc({ registry, token, scope: 'a\nb' }), /unsafe scope/);
});

test('creates a private temp dir and an exclusive 0600 file, and cleans up idempotently', () => {
  const t = createTempNpmrc('registry=x\n');
  try {
    assert.equal(path.basename(t.file), '.npmrc');
    assert.equal(path.dirname(t.file), t.dir);
    assert.ok(path.basename(t.dir).startsWith('ado-npm-exec-'));
    assert.equal(path.dirname(t.dir), os.tmpdir());
    assert.equal(fs.readFileSync(t.file, 'utf8'), 'registry=x\n');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(t.dir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(t.file).mode & 0o777, 0o600);
    }
  } finally {
    assert.equal(t.cleanup(), true);
  }
  assert.equal(fs.existsSync(t.dir), false);
  assert.equal(t.cleanup(), true);
});

test('honours a custom tmpdir and removes the dir if writing fails', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-npm-exec-test-'));
  try {
    const t = createTempNpmrc('a\n', { tmpdir: base });
    assert.equal(path.dirname(t.dir), base);
    t.cleanup();
    assert.throws(() => createTempNpmrc('a\n', { tmpdir: path.join(base, 'missing') }));
    assert.deepEqual(fs.readdirSync(base), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/**
 * Fake file system: path -> [uid, gid, mode]. `links` maps an alias to its real path.
 * @param {Record<string, number[]>} entries
 * @param {Record<string, string>} [links]
 * @returns {import('../src/npmrc.js').FsLike}
 */
function fakeFs(entries, links = {}) {
  return {
    realpath: (p) => links[p] ?? p,
    stat: (p) => {
      const e = entries[p];
      if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { uid: e[0], gid: e[1], mode: e[2], isDirectory: () => true };
    },
  };
}

// macOS-like: the primary group staff (20) has all local users in it.
const ME = { uid: 501, gid: 20 };
const ROOT_DIRS = { '/': [0, 0, 0o40755], '/home': [0, 0, 0o40755], '/var': [0, 0, 0o40755] };

test('isTrustedDir: every ancestor must be owned by root or us and not writable by others', () => {
  const f = fakeFs({ ...ROOT_DIRS, '/tmp': [0, 0, 0o41777], '/home/u': [501, 20, 0o40755], '/home/u/.cache': [501, 20, 0o40700], '/home/other': [502, 20, 0o40755], '/home/u/gw': [501, 20, 0o40775], '/home/u/ow': [501, 99, 0o40775] });
  assert.equal(isTrustedDir('/home/u/.cache', { ...ME, fs: f }), true);
  assert.equal(isTrustedDir('/tmp', { ...ME, fs: f }), false, 'world-writable');
  assert.equal(isTrustedDir('/home/other', { ...ME, fs: f }), false, 'owned by another user');
  assert.equal(isTrustedDir('/home/u/gw', { ...ME, fs: f }), false, 'group-writable by staff, which other users are in');
  assert.equal(isTrustedDir('/home/u/ow', { ...ME, fs: f }), false, 'group-writable by another group');
  assert.equal(isTrustedDir('/missing', { ...ME, fs: f }), false);
});

test('isTrustedDir: group write is trusted only for our primary group when it is a user private group', () => {
  const LINUX = { uid: 1000, gid: 1000 }; // user private group
  const f = fakeFs({
    ...ROOT_DIRS,
    // A macOS-style home: a root-owned parent, and a home that the shared group staff (20) can write.
    '/Homes': [0, 80, 0o40755],
    '/Homes/u': [501, 20, 0o40775],
    '/Homes/u/.cache': [501, 20, 0o40700],
    '/home/l': [1000, 1000, 0o40775],
    '/home/l/.cache': [1000, 1000, 0o40700],
    '/home/s': [1000, 100, 0o40775],
    '/home/s/.cache': [1000, 100, 0o40700],
  });
  assert.equal(isTrustedDir('/Homes/u/.cache', { ...ME, fs: f }), false, 'macOS: an ancestor that staff can write');
  assert.equal(isTrustedDir('/Homes/u', { ...ME, fs: f }), false, 'macOS: a home that staff can write');
  assert.equal(isTrustedDir('/home/l/.cache', { ...LINUX, fs: f }), true, 'Linux: an ancestor that only our private group can write');
  assert.equal(isTrustedDir('/home/l', { ...LINUX, fs: f }), true);
  assert.equal(isTrustedDir('/home/s/.cache', { ...LINUX, fs: f }), false, 'an ancestor that another group can write');
  assert.equal(isTrustedDir('/home/s/.cache', { uid: 1000, gid: 100, fs: f }), false, 'our primary group is not private');
  assert.equal(isTrustedDir('/home/l/.cache', { uid: 1000, gid: 100, fs: f }), false, 'group 1000 is not our primary group');
});

test('chooseBaseDir prefers the temp dir, then XDG_RUNTIME_DIR, then ~/.cache', () => {
  const entries = { ...ROOT_DIRS, '/tmp': [0, 0, 0o41777], '/run': [0, 0, 0o40755], '/run/user': [0, 0, 0o40755], '/run/user/501': [501, 20, 0o40700], '/home/u': [501, 20, 0o40755], '/home/u/.cache': [501, 20, 0o40700], '/var/t': [0, 0, 0o40755] };
  const base = { ...ME, fs: fakeFs(entries), homedir: () => '/home/u', mkdir: () => {}, canWrite: () => true, platform: /** @type {NodeJS.Platform} */ ('linux') };
  assert.equal(chooseBaseDir({ ...base, tmpdir: '/var/t', env: {} }), '/var/t');
  assert.equal(chooseBaseDir({ ...base, tmpdir: '/tmp', env: { XDG_RUNTIME_DIR: '/run/user/501' } }), '/run/user/501');
  assert.equal(chooseBaseDir({ ...base, tmpdir: '/tmp', env: { XDG_RUNTIME_DIR: 'relative' } }), '/home/u/.cache');
  assert.throws(
    () => chooseBaseDir({ ...base, tmpdir: '/tmp', env: {}, homedir: () => '/tmp/h', fs: fakeFs({ ...entries, '/tmp/h': [501, 20, 0o40755], '/tmp/h/.cache': [501, 20, 0o40700] }) }),
    UnsafeTempError,
  );
  assert.equal(chooseBaseDir({ ...base, tmpdir: '/var/t', env: {}, canWrite: (p) => p !== '/var/t' }), '/home/u/.cache', 'a trusted but read-only dir is skipped');
  assert.throws(
    () => chooseBaseDir({ ...base, tmpdir: '/tmp', env: {}, homedir: () => { throw new Error('no home'); } }),
    UnsafeTempError,
    'no home directory is not a crash',
  );
  assert.equal(chooseBaseDir({ ...base, platform: 'win32', tmpdir: 'C:\\Users\\u\\AppData\\Local\\Temp', env: {} }), 'C:\\Users\\u\\AppData\\Local\\Temp');
});

test('chooseBaseDir returns the real path it checked, not an alias of it', () => {
  const entries = {
    ...ROOT_DIRS,
    '/tmp': [0, 0, 0o41777],
    '/tmp/shared': [501, 20, 0o40700],
    '/private': [0, 0, 0o40755],
    '/private/var': [0, 0, 0o40755],
    '/private/var/folders': [0, 0, 0o40755],
    '/private/var/folders/x': [501, 20, 0o40755],
    '/private/var/folders/x/T': [501, 20, 0o40700],
    '/home/u': [501, 20, 0o40755],
    '/home/u/t': [501, 20, 0o40700],
    '/data': [0, 0, 0o40755],
    '/data/cache': [501, 20, 0o40700],
  };
  const links = {
    '/var/folders/x/T': '/private/var/folders/x/T', // macOS: /var is a symlink to /private/var
    '/tmp/link': '/home/u/t',
    '/home/u/tmp': '/tmp/shared',
    '/home/u/.cache': '/data/cache',
  };
  /** @type {string[]} */
  const made = [];
  /** @type {string[]} */
  const writable = [];
  const base = {
    ...ME,
    fs: fakeFs(entries, links),
    env: {},
    homedir: () => '/home/u',
    mkdir: (/** @type {string} */ p) => {
      made.push(p);
    },
    canWrite: (/** @type {string} */ p) => {
      writable.push(p);
      return true;
    },
    platform: /** @type {NodeJS.Platform} */ ('darwin'),
  };
  assert.equal(chooseBaseDir({ ...base, tmpdir: '/var/folders/x/T' }), '/private/var/folders/x/T');
  assert.equal(chooseBaseDir({ ...base, tmpdir: '/tmp/link' }), '/home/u/t', 'not /tmp/link, whose parent other users can write');
  assert.equal(chooseBaseDir({ ...base, tmpdir: '/home/u/tmp' }), '/data/cache', 'an alias of an untrusted dir is skipped');
  assert.deepEqual(made, ['/home/u/.cache'], '~/.cache is created as given');
  assert.deepEqual(writable, ['/private/var/folders/x/T', '/home/u/t', '/data/cache'], 'write access is checked on the real path');
});

test('findShadowingBin walks up to the root', () => {
  const planted = path.resolve('/a/node_modules/.bin/@contoso/tool@1.0.0');
  const exists = (/** @type {string} */ p) => p === planted;
  assert.equal(findShadowingBin(path.resolve('/a/b/c'), '@contoso/tool@1.0.0', exists), planted);
  assert.equal(findShadowingBin(path.resolve('/a/b/c'), 'other', exists), undefined);
});

test('sweepStaleTempDirs removes only our own old directories', { skip: process.platform === 'win32' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-npm-exec-test-'));
  try {
    const old = path.join(base, 'ado-npm-exec-AbC123');
    const fresh = path.join(base, 'ado-npm-exec-Fresh1');
    const other = path.join(base, 'something-else');
    const notOurs = path.join(base, 'ado-npm-exec-too-long-name');
    for (const d of [old, fresh, other, notOurs]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(old, '.npmrc'), 'x');
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-npm-exec-test-target-'));
    fs.symlinkSync(target, path.join(base, 'ado-npm-exec-Link12'));
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000);
    for (const d of [old, other, notOurs]) fs.utimesSync(d, past, past);
    fs.lutimesSync(path.join(base, 'ado-npm-exec-Link12'), past, past);
    assert.equal(sweepStaleTempDirs(base), 1);
    assert.deepEqual(fs.readdirSync(base).sort(), ['ado-npm-exec-Fresh1', 'ado-npm-exec-Link12', 'ado-npm-exec-too-long-name', 'something-else']);
    assert.ok(fs.existsSync(target), 'symlink target untouched');
    fs.rmSync(target, { recursive: true, force: true });
    assert.equal(sweepStaleTempDirs(path.join(base, 'missing')), 0);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
