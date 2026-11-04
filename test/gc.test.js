import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collectGarbage } from '../src/gc.js';
import { npxInstallDir } from '../src/npm-cache.js';
import { installLockName, readState, stateDir, stateKey, STATE_UNUSED_MS, tryLock, writeLease, writeState } from '../src/state.js';
import { seedNpxInstall } from '../fixtures/npm-cache.js';
import { makeTestRoot } from '../fixtures/sandbox.js';

const FEED = 'https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/';
const name = '@contoso/tool';
const at = (/** @type {string} */ v) => `${name}@${v}`;

test("removes versions nothing uses and keeps current, previous, leased and other specs' versions", async () => {
  const root = makeTestRoot('gc-');
  try {
    const dir = stateDir(root);
    const now = Date.now();
    for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0']) seedNpxInstall(root, { spec: at(v), name, version: v });
    seedNpxInstall(root, { spec: 'other@1.0.0', name: 'other', version: '1.0.0' });
    const latest = stateKey(FEED, at('latest'));
    writeState(dir, latest, {
      v: 1, registry: FEED, spec: at('latest'), name, version: '1.5.0', previous: '1.4.0', usedAt: now,
      installed: ['1.0.0', '1.1.0', '1.2.0', '1.4.0', '1.5.0'],
    });
    const range = stateKey(FEED, at('~1.2.0'));
    writeState(dir, range, { v: 1, registry: FEED, spec: at('~1.2.0'), name, version: '1.2.0', usedAt: now, installed: ['1.2.0'] });
    const old = stateKey(FEED, at('1.3.0'));
    writeState(dir, old, { v: 1, registry: FEED, spec: at('1.3.0'), name, version: '1.3.0', usedAt: now - STATE_UNUSED_MS - 1, installed: ['1.3.0'] });
    const session = writeLease(dir, { name, version: '1.0.0' });
    const otherSession = writeLease(dir, { name: 'other', version: '1.1.0' });

    const removed = await collectGarbage({ cacheDir: root, dir, names: [name], now });
    assert.deepEqual(removed.sort(), [at('1.1.0'), at('1.3.0')]);
    for (const v of ['1.0.0', '1.2.0', '1.4.0', '1.5.0']) assert.ok(fs.existsSync(npxInstallDir(root, [at(v)])), `kept ${v}`);
    for (const v of ['1.1.0', '1.3.0']) assert.equal(fs.existsSync(npxInstallDir(root, [at(v)])), false, `removed ${v}`);
    assert.ok(fs.existsSync(npxInstallDir(root, ['other@1.0.0'])), 'other packages are untouched');
    assert.deepEqual(readState(dir, latest)?.installed, ['1.0.0', '1.2.0', '1.4.0', '1.5.0']);
    assert.equal(readState(dir, old), undefined, 'a spec unused for a month is forgotten once its folders are gone');
    session?.release();
    otherSession?.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('never removes a folder that holds more than the package', async () => {
  const root = makeTestRoot('gc-');
  try {
    const dir = stateDir(root);
    const now = Date.now();
    seedNpxInstall(root, { spec: at('1.0.0'), name, version: '1.0.0', extraDeps: { left: '1' } });
    writeState(dir, stateKey(FEED, name), { v: 1, registry: FEED, spec: name, name, version: '2.0.0', usedAt: now, installed: ['1.0.0'] });
    assert.deepEqual(await collectGarbage({ cacheDir: root, dir, names: [name], now }), []);
    assert.ok(fs.existsSync(npxInstallDir(root, [at('1.0.0')])));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a record is active while it is started or checked; one without either is kept', async () => {
  const root = makeTestRoot('gc-');
  try {
    const dir = stateDir(root);
    const now = Date.now();
    const old = now - STATE_UNUSED_MS - 1;
    for (const v of ['1.0.0', '2.0.0', '3.0.0']) seedNpxInstall(root, { spec: at(v), name, version: v });
    const checked = stateKey(FEED, at('^1'));
    writeState(dir, checked, { v: 1, registry: FEED, spec: at('^1'), name, version: '1.0.0', usedAt: old, checkedAt: now, installed: ['1.0.0'] });
    const unknown = stateKey(FEED, at('^2'));
    writeState(dir, unknown, { v: 1, registry: FEED, spec: at('^2'), name, version: '2.0.0', installed: ['2.0.0'] });
    const stale = stateKey(FEED, at('^3'));
    writeState(dir, stale, { v: 1, registry: FEED, spec: at('^3'), name, version: '3.0.0', usedAt: old, checkedAt: old, installed: ['3.0.0'] });
    assert.deepEqual(await collectGarbage({ cacheDir: root, dir, names: [name], now }), [at('3.0.0')]);
    assert.ok(readState(dir, checked));
    assert.ok(readState(dir, unknown));
    assert.equal(readState(dir, stale), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unused record stays until all its folders are gone, so that none is forgotten', async () => {
  const root = makeTestRoot('gc-');
  try {
    const dir = stateDir(root);
    const now = Date.now();
    for (const v of ['1.0.0', '2.0.0']) seedNpxInstall(root, { spec: at(v), name, version: v });
    const stale = stateKey(FEED, at('^1'));
    writeState(dir, stale, { v: 1, registry: FEED, spec: at('^1'), name, version: '1.0.0', usedAt: now - STATE_UNUSED_MS - 1, installed: ['1.0.0', '2.0.0'] });
    const busy = tryLock(dir, installLockName(at('2.0.0')));
    assert.deepEqual(await collectGarbage({ cacheDir: root, dir, names: [name], now }), [at('1.0.0')]);
    assert.deepEqual(readState(dir, stale)?.installed, ['2.0.0'], 'kept: 2.0.0 is still there');
    busy?.release();
    assert.deepEqual(await collectGarbage({ cacheDir: root, dir, names: [name], now }), [at('2.0.0')]);
    assert.equal(readState(dir, stale), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('one run cleans several packages from one snapshot', async () => {
  const root = makeTestRoot('gc-');
  try {
    const dir = stateDir(root);
    const now = Date.now();
    for (const n of [name, 'other']) {
      for (const v of ['1.0.0', '2.0.0']) seedNpxInstall(root, { spec: `${n}@${v}`, name: n, version: v });
      writeState(dir, stateKey(FEED, n), { v: 1, registry: FEED, spec: n, name: n, version: '2.0.0', usedAt: now, installed: ['1.0.0', '2.0.0'] });
    }
    assert.deepEqual((await collectGarbage({ cacheDir: root, dir, names: [name, 'other'], now })).sort(), [at('1.0.0'), 'other@1.0.0']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup skips a version another process installs or uses, and removes nothing when a lease cannot be written or read', async () => {
  const root = makeTestRoot('gc-');
  try {
    const dir = stateDir(root);
    const now = Date.now();
    for (const v of ['1.0.0', '1.1.0', '1.2.0']) seedNpxInstall(root, { spec: at(v), name, version: v });
    const key = stateKey(FEED, at('latest'));
    writeState(dir, key, { v: 1, registry: FEED, spec: at('latest'), name, version: '1.2.0', usedAt: now, installed: ['1.0.0', '1.1.0', '1.2.0'] });

    const installing = tryLock(dir, installLockName(at('1.0.0')));
    const running = writeLease(dir, { name, version: '1.1.0' });
    assert.deepEqual(await collectGarbage({ cacheDir: root, dir, names: [name], now }), [], 'locked and leased');
    assert.ok(fs.existsSync(npxInstallDir(root, [at('1.0.0')])));
    installing?.release();
    running?.release();

    const sessions = path.join(dir, 'sessions');
    fs.rmSync(sessions, { recursive: true, force: true });
    fs.writeFileSync(sessions, '');
    assert.deepEqual(await collectGarbage({ cacheDir: root, dir, names: [name], now }), [], 'a running session could not have written its lease either');
    fs.rmSync(sessions);

    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const hidden = writeLease(dir, { name: 'something', version: '9.0.0' });
      fs.chmodSync(/** @type {string} */ (hidden?.file), 0o000);
      assert.deepEqual(await collectGarbage({ cacheDir: root, dir, names: [name], now }), [], 'a lease that cannot be read could claim any version');
      hidden?.release();
    }

    assert.deepEqual((await collectGarbage({ cacheDir: root, dir, names: [name], now })).sort(), [at('1.0.0'), at('1.1.0')]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a removal goes through the trash under the lock: a lock lost meanwhile (a sleep) removes nothing', async () => {
  const root = makeTestRoot('gc-');
  try {
    const dir = stateDir(root);
    const now = Date.now();
    for (const v of ['1.0.0', '2.0.0']) seedNpxInstall(root, { spec: at(v), name, version: v });
    writeState(dir, stateKey(FEED, name), { v: 1, registry: FEED, spec: name, name, version: '2.0.0', usedAt: now, installed: ['1.0.0', '2.0.0'] });
    const owner = path.join(dir, 'locks', `${installLockName(at('1.0.0'))}.lock`, 'owner.json');
    const realRename = fs.renameSync;
    let sawLock = false;
    // The first sign that cleanup is about to remove 1.0.0: another process takes its lock over.
    fs.renameSync = (/** @type {any} */ from, /** @type {any} */ to) => {
      if (String(to).includes(`${path.sep}trash${path.sep}`)) sawLock = fs.existsSync(owner);
      return realRename(from, to);
    };
    try {
      assert.deepEqual(await collectGarbage({ cacheDir: root, dir, names: [name], now }), [at('1.0.0')]);
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(sawLock, true, 'renamed into the trash while the lock was held');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'trash')), [], 'the trash is emptied');

    seedNpxInstall(root, { spec: at('1.0.0'), name, version: '1.0.0' });
    writeState(dir, stateKey(FEED, name), { v: 1, registry: FEED, spec: name, name, version: '2.0.0', usedAt: now, installed: ['1.0.0', '2.0.0'] });
    const realRefresh = Object.getOwnPropertyDescriptor(fs, 'utimesSync');
    // A sleep: the lock was taken over before the last check.
    fs.utimesSync = () => {
      fs.writeFileSync(owner, JSON.stringify({ v: 1, nonce: 'another-process', pid: 1_999_999_999, host: 'elsewhere' }));
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    };
    try {
      assert.deepEqual(await collectGarbage({ cacheDir: root, dir, names: [name], now }), []);
    } finally {
      Object.defineProperty(fs, 'utimesSync', /** @type {PropertyDescriptor} */ (realRefresh));
    }
    assert.ok(fs.existsSync(npxInstallDir(root, [at('1.0.0')])), 'kept: another process may have claimed it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup keeps a record that another process used while cleanup ran', async () => {
  const root = makeTestRoot('gc-');
  try {
    const dir = stateDir(root);
    const now = Date.now();
    seedNpxInstall(root, { spec: at('1.0.0'), name, version: '1.0.0' });
    const key = stateKey(FEED, at('^1'));
    writeState(dir, key, { v: 1, registry: FEED, spec: at('^1'), name, version: '1.0.0', usedAt: now - STATE_UNUSED_MS - 1, installed: ['1.0.0'] });
    const realRename = fs.renameSync;
    // While the folder goes, a start records a newer version for the same spec.
    fs.renameSync = (/** @type {any} */ from, /** @type {any} */ to) => {
      const r = realRename(from, to);
      if (String(to).includes(`${path.sep}trash${path.sep}`)) {
        fs.renameSync = realRename;
        writeState(dir, key, { v: 1, registry: FEED, spec: at('^1'), name, version: '1.5.0', usedAt: now, installed: ['1.0.0', '1.5.0'] });
      }
      return r;
    };
    try {
      assert.deepEqual(await collectGarbage({ cacheDir: root, dir, names: [name], now }), [at('1.0.0')]);
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(readState(dir, key)?.version, '1.5.0', 'not deleted: it changed meanwhile');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
