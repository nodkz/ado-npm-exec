import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  backUp,
  canWriteLeases,
  emptyTrash,
  hasBackup,
  installLockName,
  LEASE_FRESH_MS,
  LEASE_MAX_MS,
  LOCK_MAX_MS,
  LOCK_STALE_MS,
  listStates,
  moveToTrash,
  normalizeState,
  readLeases,
  readState,
  recordVersion,
  removeState,
  removeStateIf,
  restoreBackup,
  SIGN_IN_MAX_TENANTS,
  signInMemory,
  stateDir,
  stateKey,
  sweepBackups,
  tenantMemory,
  tryLock,
  updateState,
  waitForLock,
  writeLease,
  writeState,
} from '../src/state.js';
import { makeTestRoot } from '../fixtures/sandbox.js';

const FEED = 'https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/';
const base = { registry: FEED, spec: '@contoso/tool@latest', name: '@contoso/tool' };
const isWin = process.platform === 'win32';
const T1 = '11111111-2222-3333-4444-555555555555';
const T2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('records are keyed by feed and spec, written atomically and privately', () => {
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    assert.equal(dir, path.join(root, '_ado-npm-exec'));
    const key = stateKey(FEED, base.spec);
    assert.match(key, /^[0-9a-f]{32}$/);
    assert.notEqual(key, stateKey(FEED, '@contoso/tool'));
    assert.equal(readState(dir, key), undefined);
    assert.equal(writeState(dir, key, { v: 1, ...base, version: '1.2.3', usedAt: 5 }), true);
    assert.deepEqual(readState(dir, key), { v: 1, ...base, version: '1.2.3', usedAt: 5 });
    const after = updateState(dir, key, base, (s) => {
      s.previous = s.version;
      s.version = '1.3.0';
    });
    assert.equal(after.version, '1.3.0');
    assert.deepEqual(readState(dir, key)?.previous, '1.2.3');
    assert.deepEqual(listStates(dir).map((s) => s.key), [key]);
    if (!isWin) {
      assert.equal(fs.statSync(path.join(dir, 'specs', `${key}.json`)).mode & 0o777, 0o600);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    }
    assert.deepEqual(fs.readdirSync(path.join(dir, 'specs')), [`${key}.json`], 'no temp files left');
    removeState(dir, key);
    assert.equal(readState(dir, key), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('malformed records and fields are ignored', () => {
  assert.equal(normalizeState(null), undefined);
  assert.equal(normalizeState({ v: 2, ...base }), undefined);
  assert.equal(normalizeState({ v: 1, registry: FEED }), undefined);
  assert.deepEqual(
    normalizeState({
      v: 1,
      ...base,
      version: '1.2.3; rm -rf /',
      previous: '1.0.0',
      installed: ['1.0.0', 'x', '1.0.0', '2.0.0-beta.1'],
      usedAt: -1,
      checkedAt: 10,
      failures: 2.5,
      extra: 'dropped',
    }),
    { v: 1, ...base, previous: '1.0.0', installed: ['1.0.0', '2.0.0-beta.1'], checkedAt: 10 },
  );
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
    const key = stateKey(FEED, base.spec);
    fs.writeFileSync(path.join(dir, 'specs', `${key}.json`), '{not json');
    assert.equal(readState(dir, key), undefined);
    assert.deepEqual(listStates(dir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session leases: on this machine live while one of their processes runs, from another machine while fresh', () => {
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    const now = Date.now();
    const running = writeLease(dir, { name: 'tool', version: '1.0.0', pid: 111, host: 'h1' });
    const sleeping = writeLease(dir, { name: 'tool', version: '1.1.0', pid: 222, host: 'h1' });
    const dead = writeLease(dir, { name: 'tool', version: '1.2.0', pid: 333, host: 'h1' });
    const ancient = writeLease(dir, { name: 'tool', version: '1.3.0', pid: 222, host: 'h1' });
    const orphan = writeLease(dir, { name: 'tool', version: '1.4.0', pid: 444, host: 'h1', pids: [555] });
    const remote = writeLease(dir, { name: 'tool', version: '1.5.0', pid: 222, host: 'h2' });
    const remoteStale = writeLease(dir, { name: 'tool', version: '1.6.0', pid: 222, host: 'h2' });
    assert.ok(running && sleeping && dead && ancient && orphan && remote && remoteStale);
    const age = (/** @type {string} */ file, /** @type {number} */ ms) => fs.utimesSync(file, new Date(now - ms), new Date(now - ms));
    age(sleeping.file, LEASE_FRESH_MS + 1000);
    age(ancient.file, LEASE_MAX_MS + 1000);
    age(remoteStale.file, LEASE_FRESH_MS + 1000);
    const live = readLeases(dir, { now, host: 'h1', isAlive: (pid) => [111, 222, 555].includes(pid) });
    assert.equal(live.complete, true);
    assert.deepEqual(live.leases.map((l) => l.version).sort(), ['1.0.0', '1.1.0', '1.4.0', '1.5.0']);
    assert.equal(fs.existsSync(dead.file), false, 'its process is gone: no need to wait for it to go stale');
    assert.equal(fs.existsSync(ancient.file), false);
    assert.equal(fs.existsSync(remoteStale.file), false, 'a stale lease from another machine cannot be checked');
    assert.ok(fs.existsSync(orphan.file), 'npm still runs after its parent was killed');
    sleeping.heartbeat();
    assert.ok(now - fs.statSync(sleeping.file).mtimeMs < 60_000);
    running.release();
    assert.equal(fs.existsSync(running.file), false);
    running.heartbeat();
    assert.equal(fs.existsSync(running.file), true, 'a heartbeat writes back a lease cleanup removed');

    const later = writeLease(dir, { name: 'tool', version: '2.0.0', pid: 666, host: 'h1' });
    assert.deepEqual(readLeases(dir, { now, host: 'h1', isAlive: (pid) => pid === 777 }).leases.map((l) => l.version).includes('2.0.0'), false);
    const again = writeLease(dir, { name: 'tool', version: '2.0.0', pid: 666, host: 'h1' });
    again?.addPid(777);
    assert.equal(JSON.parse(fs.readFileSync(/** @type {string} */ (again?.file), 'utf8')).pids[0], 777);
    assert.ok(readLeases(dir, { now, host: 'h1', isAlive: (pid) => pid === 777 }).leases.some((l) => l.version === '2.0.0'), 'live through the added process');
    later?.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install locks never wait, and an abandoned one is taken over', () => {
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    const a = tryLock(dir, 'install-x');
    assert.ok(a);
    assert.equal(tryLock(dir, 'install-x'), undefined, 'held');
    a.refresh();
    a.release();
    const b = tryLock(dir, 'install-x');
    assert.ok(b, 'released');
    const lock = path.join(dir, 'locks', 'install-x.lock');
    const age = (/** @type {number} */ ms) => fs.utimesSync(lock, new Date(Date.now() - ms), new Date(Date.now() - ms));
    age(LOCK_STALE_MS + 1000);
    assert.equal(tryLock(dir, 'install-x'), undefined, 'its process on this machine still runs');
    age(LOCK_MAX_MS + 1000);
    const c = tryLock(dir, 'install-x');
    assert.ok(c, 'not refreshed for too long (a reused pid, or a long sleep)');
    const owner = path.join(lock, 'owner.json');
    fs.writeFileSync(owner, JSON.stringify({ ...JSON.parse(fs.readFileSync(owner, 'utf8')), host: 'another-machine' }));
    age(LOCK_STALE_MS + 1000);
    const d = tryLock(dir, 'install-x');
    assert.ok(d, "another machine's lock goes stale sooner: its processes cannot be checked");
    d.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the sign-in tool that gave the last token is remembered per tenant, never a token', () => {
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    const file = path.join(dir, 'sign-in.json');
    assert.deepEqual(signInMemory(undefined, T1), {}, 'without a state folder nothing is remembered');
    assert.deepEqual(signInMemory(dir, 'contoso.onmicrosoft.com'), {}, 'only tenant GUIDs');

    const first = signInMemory(dir, T1, { now: () => 1 });
    assert.equal(first.prefer, undefined);
    first.remember?.('azd');
    assert.equal(signInMemory(dir, T1).prefer, 'azd');
    assert.equal(signInMemory(dir, T1.toUpperCase()).prefer, 'azd', 'a GUID in any letter case');
    assert.equal(signInMemory(dir, T2).prefer, undefined, 'per tenant');
    assert.equal(signInMemory(dir, undefined).prefer, undefined);
    signInMemory(dir, undefined, { now: () => 2 }).remember?.('az');
    assert.equal(signInMemory(dir, undefined).prefer, 'az', 'an unknown tenant has an entry of its own');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1, tenants: { '*': { source: 'az', at: 2 }, [T1]: { source: 'azd', at: 1 } } });
    if (!isWin) assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const again = signInMemory(dir, T1);
    fs.rmSync(file);
    again.remember?.('azd');
    assert.equal(fs.existsSync(file), false, 'the remembered tool worked again: nothing is written');
    again.remember?.(/** @type {any} */ ('ADO_NPM_EXEC_TOKEN'));
    assert.equal(fs.existsSync(file), false, 'only sign-in tools are remembered');
    again.remember?.('azureauth');
    assert.equal(signInMemory(dir, T1).prefer, 'azureauth', 'the tool that took over is remembered');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed sign-in memory counts as empty, and only the most recent tenants are kept', () => {
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    const file = path.join(dir, 'sign-in.json');
    fs.mkdirSync(dir, { recursive: true });
    for (const bad of [
      'not json',
      '[]',
      JSON.stringify({ v: 2, tenants: { [T1]: { source: 'az', at: 1 } } }),
      JSON.stringify({ v: 1, tenants: { [T1]: { source: 'pwsh', at: 1 } } }),
      JSON.stringify({ v: 1, tenants: { [T1]: { source: 'az' } } }),
      JSON.stringify({ v: 1, tenants: { [T1]: { source: 'az', at: -1 } } }),
      '{"v":1,"tenants":{"__proto__":{"source":"az","at":1}}}',
    ]) {
      fs.writeFileSync(file, bad);
      assert.equal(signInMemory(dir, T1).prefer, undefined, bad);
      assert.equal(signInMemory(dir, undefined).prefer, undefined, bad);
    }
    fs.rmSync(file);
    /** @param {number} i */
    const tenant = (i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
    for (let i = 0; i <= SIGN_IN_MAX_TENANTS; i++) signInMemory(dir, tenant(i), { now: () => 1000 + i }).remember?.('az');
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).tenants).length, SIGN_IN_MAX_TENANTS);
    assert.equal(signInMemory(dir, tenant(0)).prefer, undefined, 'the tenant used longest ago is dropped');
    assert.equal(signInMemory(dir, tenant(SIGN_IN_MAX_TENANTS)).prefer, 'az');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a lock taken over after a sleep stays with its new owner', () => {
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    const lock = path.join(dir, 'locks', 'install-x.lock');
    const a = tryLock(dir, 'install-x');
    assert.ok(a);
    const old = new Date(Date.now() - LOCK_MAX_MS - 1000);
    fs.utimesSync(lock, old, old);
    const b = tryLock(dir, 'install-x');
    assert.ok(b, 'taken over: A slept');
    assert.equal(a.refresh(), false, 'A learns it lost the lock');
    a.release();
    assert.ok(fs.existsSync(lock), 'A cannot remove B\'s lock');
    assert.equal(tryLock(dir, 'install-x'), undefined, 'still held by B');
    assert.equal(b.refresh(), true);
    b.release();
    const c = tryLock(dir, 'install-x');
    assert.ok(c);
    c.release();
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the lock of a process that is gone is taken over at once', () => {
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    const held = tryLock(dir, 'install-y');
    assert.ok(held);
    const owner = path.join(dir, 'locks', 'install-y.lock', 'owner.json');
    const info = JSON.parse(fs.readFileSync(owner, 'utf8'));
    assert.equal(info.pid, process.pid);
    fs.writeFileSync(owner, JSON.stringify({ ...info, pid: 999_999_999 }));
    assert.equal(tryLock(dir, 'install-y', { isAlive: () => true }), undefined, 'a live owner keeps it');
    const taken = tryLock(dir, 'install-y', { isAlive: () => false });
    assert.ok(taken, 'its process is gone');
    fs.writeFileSync(owner, JSON.stringify({ ...info, pid: 999_999_999, host: 'another-machine' }));
    assert.equal(tryLock(dir, 'install-y', { isAlive: () => false }), undefined, 'a process on another machine cannot be checked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('waitForLock waits while another process holds the lock, and gives up after the timeout or a stop', async () => {
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    const held = tryLock(dir, 'install-z');
    assert.ok(held);
    setTimeout(() => held.release(), 150);
    const started = Date.now();
    const got = await waitForLock(dir, 'install-z', { timeoutMs: 5000, pollMs: 20 });
    assert.ok('lock' in got, 'acquired once released');
    assert.ok(Date.now() - started >= 100);
    assert.deepEqual(await waitForLock(dir, 'install-z', { timeoutMs: 60, pollMs: 20 }), { busy: true });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    assert.deepEqual(await waitForLock(dir, 'install-z', { timeoutMs: 5000, pollMs: 20, signal: ac.signal }), { stopped: true });
    if ('lock' in got) got.lock.release();

    const file = path.join(root, 'not-a-folder');
    fs.writeFileSync(file, '');
    assert.deepEqual(await waitForLock(file, 'install-z', { timeoutMs: 5000 }), { unavailable: true }, 'no lock can be created there');
    assert.match(installLockName('@contoso/tool@1.0.0'), /^install-[0-9a-f]{16}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('leases: a probe tells whether they can be written, and lease files of our own can be left out', () => {
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    assert.equal(canWriteLeases(dir), true);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'sessions')), [], 'the probe leaves nothing behind');
    const file = path.join(root, 'not-a-folder');
    fs.writeFileSync(file, '');
    assert.equal(canWriteLeases(file), false);

    const mine = writeLease(dir, { name: 'tool', version: '1.0.0' });
    const other = writeLease(dir, { name: 'tool', version: '2.0.0' });
    assert.deepEqual(readLeases(dir, { exclude: [mine?.file, undefined] }).leases.map((l) => l.version), ['2.0.0']);
    assert.deepEqual(readLeases(dir, { exclude: [other?.file] }).leases.map((l) => l.version), ['1.0.0']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('times outside the Date range are dropped from records', () => {
  const s = normalizeState({ v: 1, ...base, nextCheckAt: 9e15, checkedAt: 8.64e15, usedAt: 5, missingAt: 7 });
  assert.equal(s?.nextCheckAt, undefined);
  assert.equal(s?.checkedAt, 8.64e15);
  assert.equal(s?.missingAt, 7);
});

test('a lease that cannot be read makes the snapshot incomplete and is kept; a missing folder is no lease at all', { skip: isWin || process.getuid?.() === 0 }, () => {
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    assert.deepEqual(readLeases(dir), { leases: [], complete: true }, 'nothing written yet');
    const hidden = writeLease(dir, { name: 'tool', version: '1.0.0' });
    const seen = writeLease(dir, { name: 'tool', version: '2.0.0' });
    fs.chmodSync(/** @type {string} */ (hidden?.file), 0o000);
    const snapshot = readLeases(dir);
    assert.equal(snapshot.complete, false);
    assert.deepEqual(snapshot.leases.map((l) => l.version), ['2.0.0']);
    assert.equal(fs.existsSync(/** @type {string} */ (hidden?.file)), true, 'never deleted');
    fs.chmodSync(path.join(dir, 'sessions'), 0o000);
    try {
      assert.equal(readLeases(dir).complete, false, 'an unreadable folder');
    } finally {
      fs.chmodSync(path.join(dir, 'sessions'), 0o700);
    }
    hidden?.release();
    seen?.release();
    fs.writeFileSync(path.join(dir, 'sessions', '123-0000abcd.json'), 'not json');
    assert.deepEqual(readLeases(dir), { leases: [], complete: true }, 'garbage is no claim');
    assert.equal(fs.existsSync(path.join(dir, 'sessions', '123-0000abcd.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("npm's tag and before settings are part of a record's key", () => {
  const plain = stateKey(FEED, base.spec);
  assert.equal(stateKey(FEED, base.spec, {}), plain);
  assert.equal(stateKey(FEED, base.spec, { defaultTag: 'latest' }), plain, 'the default tag changes nothing');
  const beta = stateKey(FEED, base.spec, { defaultTag: 'beta' });
  const before = stateKey(FEED, base.spec, { before: '2024-01-01' });
  assert.equal(new Set([plain, beta, before, stateKey(FEED, base.spec, { defaultTag: 'beta', before: '2024-01-01' })]).size, 4);
});

test('only one process takes an abandoned lock over: a takeover in progress is not repeated', () => {
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    const now = Date.now();
    const old = tryLock(dir, 'install-t');
    assert.ok(old);
    const lock = path.join(dir, 'locks', 'install-t.lock');
    const past = new Date(now - LOCK_MAX_MS - 1000);
    fs.utimesSync(lock, past, past);
    fs.mkdirSync(`${lock}.guard`);
    assert.equal(tryLock(dir, 'install-t', { now }), undefined, 'another process is taking it over right now');
    const guardAge = new Date(now - 60_000);
    fs.utimesSync(`${lock}.guard`, guardAge, guardAge);
    const mine = tryLock(dir, 'install-t', { now });
    assert.ok(mine, 'a guard left by a process that died during a takeover is removed');
    assert.equal(fs.existsSync(`${lock}.guard`), false);
    assert.equal(old.refresh(), false, 'the old owner notices');
    mine.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an old owner's release cannot remove the lock that another process took over meanwhile", async () => {
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    const lock = path.join(dir, 'locks', 'install-r.lock');
    const a = tryLock(dir, 'install-r');
    assert.ok(a);
    // B is taking A's lock over right now: it holds the guard.
    fs.mkdirSync(`${lock}.guard`);
    a.release();
    assert.ok(fs.existsSync(lock), 'A waits for the guard instead of deleting');
    fs.rmdirSync(`${lock}.guard`);
    const b = tryLock(dir, 'install-r', { now: Date.now() + LOCK_MAX_MS + 1000 });
    assert.ok(b, 'B took it over');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(b.refresh(), true, "A's later attempt saw that the lock is no longer its own");
    assert.equal(tryLock(dir, 'install-r'), undefined, 'no third owner');
    b.release();
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a lock stays held while the npm its owner started runs, also after the owner was killed', () => {
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    const a = tryLock(dir, 'install-w');
    assert.ok(a);
    assert.equal(a.addPid(4242), true);
    const owner = path.join(dir, 'locks', 'install-w.lock', 'owner.json');
    const info = JSON.parse(fs.readFileSync(owner, 'utf8'));
    assert.deepEqual(info.pids, [4242]);
    fs.writeFileSync(owner, JSON.stringify({ ...info, pid: 999_999_999 }));
    assert.equal(tryLock(dir, 'install-w', { isAlive: (pid) => pid === 4242 }), undefined, 'the orphaned npm still writes the folder');
    const b = tryLock(dir, 'install-w', { isAlive: () => false });
    assert.ok(b, 'all of its processes are gone');
    assert.equal(a.addPid(4343), false, 'no longer the owner');
    b.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('trash, backups and a record that is removed only when unchanged', async () => {
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    const npx = path.join(root, '_npx');
    const folder = path.join(npx, '0123456789abcdef');
    const make = (/** @type {string} */ mark) => {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'mark'), mark);
    };
    make('old');
    const first = backUp(dir, folder);
    assert.equal(fs.existsSync(folder), false);
    assert.equal(hasBackup(dir, folder), true);
    make('newer');
    const second = backUp(dir, folder);
    fs.utimesSync(first, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
    assert.equal(restoreBackup(dir, folder, () => fs.readFileSync(path.join(folder, 'mark'), 'utf8') === 'old'), true, 'the newest is tried first, then the next');
    assert.equal(fs.readFileSync(path.join(folder, 'mark'), 'utf8'), 'old');
    assert.equal(fs.existsSync(second), false, 'the rejected one went to the trash');
    assert.equal(restoreBackup(dir, folder, () => true), false, 'the folder is there: nothing to do');

    fs.mkdirSync(path.join(npx, 'fedcba9876543210'));
    const leftover = backUp(dir, path.join(npx, 'fedcba9876543210'));
    fs.mkdirSync(path.join(dir, 'replaced', 'garbage'));
    const done = backUp(dir, folder);
    make('reinstalled');
    sweepBackups(dir, npx, Date.now());
    assert.ok(fs.existsSync(done), 'kept for an hour: the reinstall may still fail');
    assert.ok(fs.existsSync(leftover), 'its folder is missing: a start may put it back');
    assert.equal(fs.existsSync(path.join(dir, 'replaced', 'garbage')), false);
    sweepBackups(dir, npx, Date.now() + 2 * 60 * 60 * 1000);
    assert.equal(fs.existsSync(done), false);
    assert.ok(fs.existsSync(leftover));
    sweepBackups(dir, npx, Date.now() + 8 * 24 * 60 * 60 * 1000);
    assert.equal(fs.existsSync(leftover), false, 'given up after a week');

    moveToTrash(dir, folder);
    assert.ok(fs.readdirSync(path.join(dir, 'trash')).length > 0);
    await emptyTrash(dir);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'trash')), []);

    const key = stateKey(FEED, base.spec);
    writeState(dir, key, { v: 1, ...base, usedAt: 1 });
    const snapshot = /** @type {import('../src/state.js').SpecState} */ (readState(dir, key));
    updateState(dir, key, base, (s) => {
      s.usedAt = 2;
    });
    assert.equal(removeStateIf(dir, key, snapshot), false, 'used again meanwhile');
    assert.ok(readState(dir, key));
    assert.equal(removeStateIf(dir, key, /** @type {import('../src/state.js').SpecState} */ (readState(dir, key))), true);
    assert.equal(readState(dir, key), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('waitForLock leaves no abort listeners behind', async () => {
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    const held = tryLock(dir, 'install-l');
    const ac = new AbortController();
    /** @type {unknown[]} */
    const warnings = [];
    const onWarning = (/** @type {unknown} */ w) => warnings.push(w);
    process.on('warning', onWarning);
    try {
      assert.deepEqual(await waitForLock(dir, 'install-l', { timeoutMs: 400, pollMs: 5, signal: ac.signal }), { busy: true });
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(warnings, [], 'no MaxListenersExceededWarning');
    } finally {
      process.off('warning', onWarning);
      held?.release();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recordVersion: the new version, the one before, installs of this tool, and the mark of a failed start', () => {
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    const key = stateKey(FEED, base.spec);
    writeState(dir, key, { v: 1, ...base, version: '1.0.0', installed: ['1.0.0'], failures: 2, nextCheckAt: 9, missingAt: 3, offlineFailedAt: 4 });
    let s = recordVersion(dir, key, base, '1.0.0', { now: 100, created: false, repaired: false });
    assert.equal(s.offlineFailedAt, 4, 'the same copy, not repaired: still marked');
    assert.deepEqual([s.failures, s.nextCheckAt, s.missingAt, s.checkedAt, s.usedAt], [undefined, undefined, undefined, 100, undefined]);
    s = recordVersion(dir, key, base, '1.0.0', { now: 200, created: true, repaired: true, used: true });
    assert.deepEqual([s.offlineFailedAt, s.usedAt, s.installed], [undefined, 200, ['1.0.0']]);
    writeState(dir, key, { ...s, offlineFailedAt: 5 });
    s = recordVersion(dir, key, base, '2.0.0', { now: 300, created: false, repaired: false });
    assert.deepEqual([s.version, s.previous, s.offlineFailedAt, s.installed], ['2.0.0', '1.0.0', undefined, ['1.0.0']], 'another version starts next: the mark is moot');
    assert.deepEqual(readState(dir, key), s);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an organization's tenant is remembered for a week, can be forgotten, and only GUIDs count", () => {
  const root = makeTestRoot('state-');
  try {
    const dir = stateDir(root);
    let now = 1_000_000;
    const clock = { now: () => now };
    const tenant = '11111111-2222-3333-4444-555555555555';
    assert.equal(tenantMemory(dir, 'Contoso', clock).tenant, undefined);
    tenantMemory(dir, 'Contoso', clock).remember(tenant.toUpperCase());
    assert.equal(tenantMemory(dir, 'contoso', clock).tenant, tenant, 'any case');
    tenantMemory(dir, 'contoso', clock).remember('not-a-guid');
    assert.equal(tenantMemory(dir, 'contoso', clock).tenant, tenant);
    now += 7 * 24 * 60 * 60 * 1000;
    assert.equal(tenantMemory(dir, 'contoso', clock).tenant, undefined, 'after a week it is asked again');
    now = 1_000_000;
    tenantMemory(dir, 'contoso', clock).forget();
    assert.equal(tenantMemory(dir, 'contoso', clock).tenant, undefined);
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'tenants.json'), 'utf8'))).includes('token'), false);
    assert.deepEqual(tenantMemory(undefined, 'contoso').tenant, undefined, 'no state folder: nothing remembered');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
