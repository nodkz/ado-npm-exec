// The online steps every start, update and prewarm shares: the version pick,
// the locked install into npm's exec cache, and what a failure means.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { claimCached, EXIT, feedTenant, npmErrorCode, pickVersion, preinstall, recoverInterrupted, reportFailure, resolveWithNpm } from '../src/install.js';
import { isCached, packumentCacheKey, readNpxInstall } from '../src/npm-cache.js';
import { validateRegistryUrl } from '../src/registry.js';
import { backUp, installLockName, readLeases, stateDir, tryLock, writeLease } from '../src/state.js';
import { validJwt, TENANT } from '../fixtures/jwt.js';
import { FAKE_NPM_PID, fakeNpmRun } from '../fixtures/fake-npm-run.js';
import { seedNpxInstall, seedPackument } from '../fixtures/npm-cache.js';
import { makeTestRoot } from '../fixtures/sandbox.js';

const FEED = 'https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/';
const registry = validateRegistryUrl(FEED);
const name = '@contoso/tool';
const npm = { node: process.execPath, cli: '/fake/npm-cli.js' };
const posixUser = process.platform !== 'win32' && process.getuid?.() !== 0;

/**
 * An install context in a fresh sandbox.
 *
 * @param {{ range?: string, env?: NodeJS.ProcessEnv, run?: import('../src/proc.js').runCapture }} [over]
 */
function setup({ range = '1.2.3', env = {}, run } = {}) {
  const root = makeTestRoot('install-');
  const cacheDir = path.join(root, 'npm-cache');
  const baseDir = path.join(root, 'tmp');
  fs.mkdirSync(baseDir, { recursive: true });
  /** @type {string[]} */
  const log = [];
  /** @type {import('../src/install.js').InstallContext} */
  const ctx = {
    npm,
    registry,
    spec: { raw: `${name}@${range}`, name, scope: 'contoso', range },
    token: validJwt(),
    cacheDir,
    dir: stateDir(cacheDir),
    baseDir,
    env,
    platform: process.platform,
    temps: new Set(),
    run,
    debug: (m) => log.push(m),
  };
  return { root, ctx, log, cacheDir, baseDir, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('preinstall installs with a private token file, removes it, and does nothing once the version is ready', async () => {
  const s = setup();
  try {
    const npmFake = fakeNpmRun(s.cacheDir);
    s.ctx.run = npmFake.run;
    s.ctx.env = { npm_config_cache: s.cacheDir, PATH: '/bin' };
    assert.deepEqual(await preinstall(s.ctx, { version: '1.2.3' }), { ok: true, created: true });
    const [call] = npmFake.calls;
    for (const a of [`--package=${name}@1.2.3`, '--call=exit 0', '--fetch-timeout=120000', '--color=false', '--install-strategy=hoisted', `--cache=${s.cacheDir}`]) {
      assert.ok(call.args.includes(a), a);
    }
    assert.ok(call.npmrc?.includes(`:_authToken=${s.ctx.token}`));
    const rc = /** @type {string} */ (call.env.npm_config_userconfig);
    assert.equal(call.cwd, path.join(fs.realpathSync(s.baseDir), path.basename(path.dirname(rc))), 'npm runs in the private folder');
    assert.equal(fs.existsSync(/** @type {string} */ (call.env.npm_config_userconfig)), false, 'token file removed');
    assert.equal(s.ctx.temps.size, 0);
    assert.deepEqual(fs.readdirSync(s.baseDir), []);

    assert.deepEqual(await preinstall(s.ctx, { version: '1.2.3' }), { ok: true, created: false });
    assert.equal(npmFake.calls.length, 1, 'ready: npm does not run');
    assert.deepEqual(readLeases(s.ctx.dir).leases, [], 'the install lease is released');
  } finally {
    s.dispose();
  }
});

test('preinstall replaces an interrupted install, unless another process may use it (also when a lease cannot be read)', async () => {
  const s = setup();
  try {
    const partial = seedNpxInstall(s.cacheDir, { spec: `${name}@1.2.3`, name, version: '1.2.3', complete: false });
    fs.writeFileSync(path.join(partial, 'marker'), 'old');
    const lease = writeLease(s.ctx.dir, { name, version: '1.2.3' });
    s.ctx.run = fakeNpmRun(s.cacheDir).run;
    const inUse = await preinstall(s.ctx, { version: '1.2.3' });
    assert.equal(!inUse.ok && inUse.kind, 'local');
    assert.match(inUse.ok ? '' : inUse.reason, /incomplete, and another process may use it: stop that process, or delete/);
    lease?.release();

    if (posixUser) {
      const unreadable = writeLease(s.ctx.dir, { name, version: '9.9.9' });
      fs.chmodSync(/** @type {string} */ (unreadable?.file), 0o000);
      const unknown = await preinstall(s.ctx, { version: '1.2.3' });
      assert.equal(!unknown.ok && unknown.kind, 'local', 'an unreadable lease could be the one that uses it');
      assert.equal(fs.existsSync(/** @type {string} */ (unreadable?.file)), true, 'and it is never deleted');
      unreadable?.release();
    }

    assert.deepEqual(await preinstall(s.ctx, { version: '1.2.3' }), { ok: true, created: true });
    assert.equal(fs.existsSync(path.join(partial, 'marker')), false, 'started over');
  } finally {
    s.dispose();
  }
});

test('preinstall failures: a held lock, a lock that cannot be created, npm errors, a wrong result, and a stop', async () => {
  const s = setup({ range: '2.0.0' });
  try {
    const held = tryLock(s.ctx.dir, installLockName(`${name}@2.0.0`));
    s.ctx.run = fakeNpmRun(s.cacheDir).run;
    const busy = await preinstall(s.ctx, { version: '2.0.0', waitMs: 60 });
    assert.equal(!busy.ok && busy.kind, 'busy');
    assert.match(busy.ok ? '' : busy.reason, /another process has been installing @contoso\/tool@2\.0\.0 for over 0 minutes/);
    held?.release();

    s.ctx.run = fakeNpmRun(s.cacheDir, { code: 1, stderr: `\x1b[31mnpm error\x1b[39m code E404\nnpm error 404 Not Found - GET ${FEED}@contoso%2ftool - Not found` }).run;
    const gone = await preinstall(s.ctx, { version: '2.0.0' });
    assert.equal(!gone.ok && gone.kind, 'gone');
    assert.equal(!gone.ok && gone.npmCode, 'E404', 'colors do not hide the code');
    assert.doesNotMatch(gone.ok ? '' : gone.reason, /\x1b/);

    s.ctx.run = fakeNpmRun(s.cacheDir, { complete: false }).run;
    assert.match(String(await preinstall(s.ctx, { version: '2.0.0' }).then((r) => !r.ok && r.reason)), /not completely installed/);
    s.ctx.run = fakeNpmRun(s.cacheDir, { installs: '2.0.1' }).run;
    assert.match(String(await preinstall(s.ctx, { version: '2.0.0' }).then((r) => !r.ok && r.reason)), /not completely installed/, 'another version is no install of this one');
    s.ctx.run = fakeNpmRun(s.cacheDir, { feed: 'https://registry.npmjs.org/' }).run;
    assert.match(String(await preinstall(s.ctx, { version: '2.0.0' }).then((r) => !r.ok && r.reason)), /from registry\.npmjs\.org, not from the feed/);
    fs.rmSync(path.join(s.cacheDir, '_npx'), { recursive: true, force: true });
    fs.rmSync(path.join(s.cacheDir, '_cacache'), { recursive: true, force: true });
    const noMetadata = fakeNpmRun(s.cacheDir, { packument: false });
    s.ctx.run = noMetadata.run;
    assert.match(String(await preinstall(s.ctx, { version: '2.0.0' }).then((r) => !r.ok && r.reason)), /npm's cache has no registry metadata that lists it/);
    assert.equal(noMetadata.calls.length, 2, 'npm ran again first');

    s.ctx.run = fakeNpmRun(s.cacheDir, { aborted: true }).run;
    const stopped = await preinstall(s.ctx, { version: '3.0.0' });
    assert.equal(!stopped.ok && stopped.kind, 'stopped');
    assert.deepEqual(fs.readdirSync(s.baseDir), [], 'no token file left behind');

    fs.rmSync(path.join(s.ctx.dir, 'locks'), { recursive: true, force: true });
    fs.writeFileSync(path.join(s.ctx.dir, 'locks'), '');
    const noLock = await preinstall(s.ctx, { version: '4.0.0' });
    assert.equal(!noLock.ok && noLock.kind, 'local');
    assert.match(noLock.ok ? '' : noLock.reason, /the install lock cannot be created in .*: check the permissions of that folder/);
  } finally {
    s.dispose();
  }
});

test('preinstall stops npm when another process takes its lock over, and leaves that lock alone', async (t) => {
  // The lock refresh timer is unref'd (in use, npm keeps the process alive);
  // here something must, or Node 20/22's test runner cancels the test.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const s = setup();
  try {
    const owner = path.join(s.ctx.dir, 'locks', `${installLockName(`${name}@1.2.3`)}.lock`, 'owner.json');
    const npmFake = fakeNpmRun(s.cacheDir, {
      during: async (_args, signal) => {
        fs.writeFileSync(owner, JSON.stringify({ v: 1, nonce: 'someone-else', pid: 1, host: 'elsewhere' }));
        await new Promise((resolve) => (signal?.aborted ? resolve(undefined) : signal?.addEventListener('abort', resolve, { once: true })));
      },
    });
    s.ctx.run = npmFake.run;
    const r = await preinstall(s.ctx, { version: '1.2.3', refreshMs: 20 });
    assert.equal(!r.ok && r.kind, 'busy');
    assert.match(r.ok ? '' : r.reason, /another process took over the install of @contoso\/tool@1\.2\.3/);
    assert.equal(JSON.parse(fs.readFileSync(owner, 'utf8')).nonce, 'someone-else', "the new owner's lock stays");
  } finally {
    s.dispose();
  }
});

test('a reinstall moves the old copy aside, puts it back when npm fails, and drops it once the new one is complete', async () => {
  const s = setup();
  try {
    const old = seedNpxInstall(s.cacheDir, { spec: `${name}@1.2.3`, name, version: '1.2.3' });
    seedPackument(s.cacheDir, FEED, name, { versions: ['1.2.3'] });
    fs.writeFileSync(path.join(old, 'marker'), 'the copy that failed at start');

    s.ctx.run = fakeNpmRun(s.cacheDir, {
      code: 1,
      stderr: 'npm error code ECONNRESET\nnpm error network aborted',
      during: () => assert.equal(fs.existsSync(old), false, 'moved aside while npm runs'),
    }).run;
    const offline = await preinstall(s.ctx, { version: '1.2.3', reinstall: true });
    assert.equal(!offline.ok && offline.kind, 'network');
    assert.equal(fs.readFileSync(path.join(old, 'marker'), 'utf8'), 'the copy that failed at start', 'put back: the offline fallback still has it');
    assert.equal(readNpxInstall(s.cacheDir, `${name}@1.2.3`, name).complete, true);

    s.ctx.run = fakeNpmRun(s.cacheDir).run;
    assert.deepEqual(await preinstall(s.ctx, { version: '1.2.3', reinstall: true }), { ok: true, created: true });
    assert.equal(fs.existsSync(path.join(old, 'marker')), false, 'a fresh install');
    const end = Date.now() + 5000;
    while (fs.readdirSync(path.join(s.ctx.dir, 'replaced')).length > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(fs.readdirSync(path.join(s.ctx.dir, 'replaced')), [], 'the old copy is removed');
  } finally {
    s.dispose();
  }
});

test('preinstall: waits for another process installing the same version and uses its install; our own lease does not block a reinstall', async () => {
  const s = setup();
  try {
    const other = tryLock(s.ctx.dir, installLockName(`${name}@1.2.3`));
    setTimeout(() => {
      seedNpxInstall(s.cacheDir, { spec: `${name}@1.2.3`, name, version: '1.2.3' });
      seedPackument(s.cacheDir, FEED, name, { versions: ['1.2.3'] });
      other?.release();
    }, 150);
    const npmFake = fakeNpmRun(s.cacheDir);
    s.ctx.run = npmFake.run;
    assert.deepEqual(await preinstall(s.ctx, { version: '1.2.3', waitMs: 10_000 }), { ok: true, created: false });
    assert.equal(npmFake.calls.length, 0, 'npm never ran');

    const mine = writeLease(s.ctx.dir, { name, version: '1.2.3' });
    assert.deepEqual(await preinstall(s.ctx, { version: '1.2.3', reinstall: true }), { ok: true, created: false }, 'in use: kept as it is');
    assert.equal(npmFake.calls.length, 0);
    assert.deepEqual(await preinstall(s.ctx, { version: '1.2.3', reinstall: true, ownLeases: [mine?.file] }), { ok: true, created: true }, 'our own lease');
    assert.equal(npmFake.calls.length, 1);
    mine?.release();
  } finally {
    s.dispose();
  }
});

test('preinstall: an install without registry metadata is completed, and one from another registry is replaced while leased', async () => {
  const s = setup();
  try {
    seedNpxInstall(s.cacheDir, { spec: `${name}@1.2.3`, name, version: '1.2.3' });
    const npmFake = fakeNpmRun(s.cacheDir);
    s.ctx.run = npmFake.run;
    assert.deepEqual(await preinstall(s.ctx, { version: '1.2.3' }), { ok: true, created: false }, 'the folder was there: not ours');
    assert.equal(npmFake.calls.length, 1, 'npm ran for the missing registry metadata');

    seedNpxInstall(s.cacheDir, { spec: `${name}@1.2.4`, name, version: '1.2.4', registry: 'https://registry.npmjs.org/' });
    /** @type {string[]} */
    let leasedDuring = [];
    s.ctx.run = fakeNpmRun(s.cacheDir, { during: () => (leasedDuring = readLeases(s.ctx.dir).leases.map((l) => l.version)) }).run;
    assert.deepEqual(await preinstall(s.ctx, { version: '1.2.4' }), { ok: true, created: true });
    assert.equal(readNpxInstall(s.cacheDir, `${name}@1.2.4`, name).resolved?.startsWith(FEED), true, 'now from the feed');
    assert.deepEqual(leasedDuring, ['1.2.4']);
  } finally {
    s.dispose();
  }
});

test("preinstall: npm runs again when the registry metadata it cached was lost (another npm rewrote npm's cache index meanwhile)", async () => {
  const s = setup();
  try {
    // What is left: the older metadata, without the version npm just installed.
    seedPackument(s.cacheDir, FEED, name, { versions: ['1.2.2'] });
    const lost = fakeNpmRun(s.cacheDir, { packument: false });
    const fetched = fakeNpmRun(s.cacheDir);
    /** @type {(readonly string[])[]} */
    const calls = [];
    s.ctx.run = (file, args, opts) => {
      calls.push(args);
      return (calls.length === 1 ? lost : fetched).run(file, args, opts);
    };
    assert.deepEqual(await preinstall(s.ctx, { version: '1.2.3', cacheMode: 'prefer-offline' }), { ok: true, created: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].includes('--prefer-offline'), true);
    assert.equal(calls[1].includes('--prefer-offline'), false, 'npm fetches the metadata again');
    assert.equal(isCached(s.cacheDir, packumentCacheKey(FEED, name), { version: '1.2.3' }), true);
  } finally {
    s.dispose();
  }
});

test("a token file that cannot be removed stays for the shutdown; npm's error codes are read with or without colors", { skip: !posixUser }, async () => {
  assert.equal(npmErrorCode('npm error code E404\nnpm error 404 Not Found - GET https://x'), 'E404');
  assert.equal(npmErrorCode('npm ERR! code ETARGET'), 'ETARGET');
  assert.equal(npmErrorCode('\x1b[31mnpm\x1b[39m \x1b[31merror\x1b[39m \x1b[35mcode\x1b[39m E401'), 'E401');
  assert.equal(npmErrorCode('something else'), undefined);
  const s = setup({ range: '1.2.4' });
  try {
    s.ctx.run = fakeNpmRun(s.cacheDir, { during: () => fs.chmodSync(s.baseDir, 0o500) }).run;
    try {
      assert.equal((await preinstall(s.ctx, { version: '1.2.4' })).ok, true);
      assert.equal(s.ctx.temps.size, 1, 'kept for another try');
    } finally {
      fs.chmodSync(s.baseDir, 0o700);
    }
    assert.equal([...s.ctx.temps][0].cleanup(), true);
  } finally {
    s.dispose();
  }
});

test("npm's failures keep their meaning: refused, gone, the network, or something else", async () => {
  const notHere = `npm error code E404\nnpm error 404 Not Found - GET ${FEED}@contoso%2ftool - Not found\nnpm error 404\nnpm error 404  '@contoso/tool@^1' is not in this registry.`;
  const cases = /** @type {const} */ ([
    ['npm error code E401\nnpm error Unable to authenticate, your authentication token seems to be invalid.', 'auth', 401],
    [`npm error code E403\nnpm error 403 Forbidden - GET ${FEED}@contoso%2ftool`, 'auth', 403],
    ['npm error code E401\nnpm error 401 Unauthorized - GET https://other.example/@fabrikam%2fdep - no credentials', 'other'],
    [notHere, 'gone'],
    ['npm error code E404\nnpm error 404 Not Found - GET https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/@contoso%2ftool-utils - Not found', 'other'],
    ['npm error code ETARGET\nnpm error notarget No matching version found for @contoso/tool@^1.', 'gone'],
    ['npm error code ETARGET\nnpm error notarget No matching version found for depx@^2.0.0.', 'other'],
    ['npm error code ETARGET\nnpm error notarget No matching version found for @contoso/tool-utils@^2.0.0.', 'other'],
    ['npm error code ECONNRESET', 'network'],
    ['npm error code ETIMEDOUT', 'network'],
    ['npm error code EAI_AGAIN', 'network'],
    ['npm error code ENOTFOUND', 'network'],
    ['npm error code E503', 'network'],
    ['npm error code SELF_SIGNED_CERT_IN_CHAIN', 'network'],
    ['npm ERR! network request to https://x failed', 'network'],
    ['npm error code EACCES', 'other'],
  ]);
  for (const [stderr, kind, status] of cases) {
    const s = setup({ range: '^1' });
    try {
      s.ctx.run = fakeNpmRun(s.cacheDir, { code: 1, stderr }).run;
      const r = await resolveWithNpm(s.ctx);
      assert.equal(!r.ok && r.kind, kind, stderr);
      if (status) assert.equal(!r.ok && r.status, status);
    } finally {
      s.dispose();
    }
  }
  const s = setup({ range: '^1' });
  try {
    s.ctx.run = fakeNpmRun(s.cacheDir, { timedOut: true }).run;
    const r = await resolveWithNpm(s.ctx, { timeoutMs: 120_000 });
    assert.equal(!r.ok && r.kind, 'network');
    assert.match(r.ok ? '' : r.reason, /did not finish within 2 minutes/);
  } finally {
    s.dispose();
  }
});

test('npm picks a dist-tag with one npm view, and anything else in a private lockfile; nothing is downloaded or run', async () => {
  const s = setup({ range: 'beta' });
  try {
    const npmFake = fakeNpmRun(s.cacheDir, { resolvesTo: '1.5.0' });
    s.ctx.run = npmFake.run;
    assert.deepEqual(await resolveWithNpm(s.ctx), { ok: true, version: '1.5.0' });
    const [view] = npmFake.calls;
    assert.equal(view.args[1], 'view');
    assert.deepEqual(view.args.slice(-2), [`${name}@beta`, 'version']);
    for (const a of ['--prefer-online', '--color=false', '--json=false']) assert.ok(view.args.includes(a), a);

    s.ctx.spec = { raw: `${name}@^1.2`, name, scope: 'contoso', range: '^1.2' };
    assert.deepEqual(await resolveWithNpm(s.ctx), { ok: true, version: '1.5.0' });
    const install = npmFake.calls[1];
    assert.equal(install.args[1], 'install');
    for (const a of ['--package-lock-only', '--ignore-scripts', '--save=true', '--package-lock=true', '--save-exact', '--install-strategy=hoisted']) assert.ok(install.args.includes(a), a);
    assert.equal(install.args.at(-1), `${name}@^1.2`);
    assert.deepEqual(fs.readdirSync(s.baseDir), [], 'the private folder is gone');

    s.ctx.spec = { raw: `${name}@beta`, name, scope: 'contoso', range: 'beta' };
    s.ctx.env = { npm_config_before: '2020-01-01' };
    await resolveWithNpm(s.ctx);
    assert.equal(npmFake.calls[2].args[1], 'install', "npm's before setting: the lockfile route, which honors it");
  } finally {
    s.dispose();
  }
});

test('pickVersion asks the feed first, and goes to npm at once where only npm can decide or reach the feed', async () => {
  const s = setup({ range: 'latest' });
  try {
    const npmFake = fakeNpmRun(s.cacheDir, { resolvesTo: '2.0.0' });
    s.ctx.run = npmFake.run;
    /** @type {string[]} */
    const asked = [];
    /** @type {import('../src/resolve.js').Resolution} */
    let answer = { kind: 'resolved', version: '1.2.3', via: 'dist-tags' };
    const resolve = async (/** @type {import('../src/resolve.js').ResolveOptions} */ o) => {
      asked.push(o.spec.raw);
      return answer;
    };
    assert.deepEqual(await pickVersion(s.ctx, { resolve }), { ok: true, version: '1.2.3', metadataCached: false });
    assert.equal(npmFake.calls.length, 0);

    answer = { kind: 'unsupported', detail: 'odd range' };
    assert.deepEqual(await pickVersion(s.ctx, { resolve }), { ok: true, version: '2.0.0', metadataCached: true });
    assert.equal(npmFake.calls.length, 1);

    // A proxy this process's fetch does not use: no direct request at all.
    s.ctx.env = { HTTPS_PROXY: 'http://proxy.example:8080' };
    asked.length = 0;
    assert.deepEqual(await pickVersion(s.ctx, { resolve }), { ok: true, version: '2.0.0', metadataCached: true });
    assert.deepEqual(asked, []);
    s.ctx.spec = { raw: `${name}@1.0.0`, name, scope: 'contoso', range: '1.0.0' };
    answer = { kind: 'resolved', version: '1.0.0', via: 'exact' };
    assert.deepEqual(await pickVersion(s.ctx, { resolve }), { ok: true, version: '1.0.0', metadataCached: false }, 'an exact version needs no request');
    s.ctx.env = { NODE_TLS_REJECT_UNAUTHORIZED: '0' };
    s.ctx.spec = { raw: `${name}@latest`, name, scope: 'contoso', range: 'latest' };
    asked.length = 0;
    await pickVersion(s.ctx, { resolve });
    assert.deepEqual(asked, [], 'certificate checks off: npm asks');

    s.ctx.env = {};
    for (const [res, kind] of /** @type {const} */ ([
      [{ kind: 'refused', status: 403, detail: 'HTTP 403' }, 'auth'],
      [{ kind: 'not-found', status: 404, detail: 'HTTP 404' }, 'gone'],
      [{ kind: 'no-match', detail: 'no dist-tag "x"', latest: '1.0.0' }, 'gone'],
      [{ kind: 'unavailable', detail: 'fetch failed' }, 'network'],
    ])) {
      answer = res;
      const r = await pickVersion(s.ctx, { resolve });
      assert.equal(!r.ok && r.kind, kind, res.kind);
    }
    answer = { kind: 'no-match', detail: 'no dist-tag "x"', latest: '1.0.0' };
    assert.match(String(await pickVersion(s.ctx, { resolve }).then((r) => !r.ok && r.reason)), /no dist-tag "x"; its latest version is 1\.0\.0/);
  } finally {
    s.dispose();
  }
});

test('reportFailure tells the person what to do and gives the exit code', () => {
  /** @type {string[]} */
  const out = [];
  const log = { verbose: false, error: (/** @type {string} */ m) => out.push(m), info: () => {}, debug: () => {} };
  const noticeStream = { write: (/** @type {string} */ s) => void out.push(s), isTTY: false };
  const spec = { raw: `${name}@latest`, name, scope: 'contoso', range: 'latest' };
  const info = { spec, registry, env: {}, platform: /** @type {NodeJS.Platform} */ ('linux'), log, noticeStream };
  assert.equal(reportFailure({ ok: false, kind: 'auth', status: 403, reason: 'npm exited with 1' }, info), EXIT.NO_TOKEN);
  assert.match(out.join(''), /Sign-in refused[\s\S]*HTTP 403/);
  out.length = 0;
  assert.equal(reportFailure({ ok: false, kind: 'gone', reason: 'HTTP 404' }, info), EXIT.NOT_FOUND);
  assert.match(out[0], /@contoso\/tool@latest is not on https:\/\/pkgs\.dev\.azure\.com\/.* or its upstream sources \(HTTP 404\)\./);
  out.length = 0;
  assert.equal(reportFailure({ ok: false, kind: 'network', reason: 'npm exited with 1: npm error code ENOTFOUND' }, info), EXIT.INTERNAL);
  assert.match(out[0], /could not reach .*ENOTFOUND\)\. Check the network, VPN or proxy settings\./);
  out.length = 0;
  assert.equal(reportFailure({ ok: false, kind: 'busy', reason: 'another process has been installing x for over 5 minutes' }, info), EXIT.INTERNAL);
  assert.match(out[0], /for over 5 minutes; try again later\./);
});

test('feedTenant: a given tenant, a remembered one, or one discovery that is then remembered', async () => {
  const s = setup();
  try {
    let asked = 0;
    const discover = async () => {
      asked++;
      return { tenant: TENANT };
    };
    const o = { registry, env: {}, dir: s.ctx.dir, discover };
    assert.equal((await feedTenant({ ...o, tenant: '22222222-2222-2222-2222-222222222222' })).tenant, '22222222-2222-2222-2222-222222222222');
    assert.equal((await feedTenant({ ...o, tenant: undefined, env: { ADO_NPM_EXEC_TOKEN: 'x' } })).tenant, undefined, 'a given token needs no tenant');
    assert.equal(asked, 0);
    const first = await feedTenant({ ...o, tenant: undefined });
    assert.deepEqual([first.tenant, first.remembered, asked], [TENANT, undefined, 1]);
    const second = await feedTenant({ ...o, tenant: undefined });
    assert.deepEqual([second.tenant, second.remembered, asked], [TENANT, true, 1], 'no request');
    second.forget();
    assert.equal((await feedTenant({ ...o, tenant: undefined })).remembered, undefined, 'forgotten: asked again');
    assert.equal(asked, 2);
  } finally {
    s.dispose();
  }
});

test('npm steps that have the token see no workspace folder on PATH, and run scripts with an absolute shell', { skip: process.platform === 'win32' }, async () => {
  const PATH = ['/w/node_modules/.bin', 'relative/bin', '', '/usr/bin', '/bin'].join(path.delimiter);
  const s = setup({ range: '^1', env: { PATH, npm_config_script_shell: 'sh' } });
  try {
    const npmFake = fakeNpmRun(s.cacheDir, { resolvesTo: '1.2.3' });
    s.ctx.run = npmFake.run;
    assert.equal((await resolveWithNpm(s.ctx)).ok, true);
    assert.equal((await preinstall(s.ctx, { version: '1.2.3' })).ok, true);
    for (const call of npmFake.calls) {
      assert.equal(call.env.PATH, '/usr/bin:/bin', call.args[1]);
      assert.ok(call.args.includes('--script-shell=/bin/sh'), `${call.args[1]}: a workspace sh cannot read the token`);
    }
    const absolute = setup({ env: { npm_config_script_shell: '/bin/bash' } });
    try {
      const other = fakeNpmRun(absolute.cacheDir);
      absolute.ctx.run = other.run;
      await preinstall(absolute.ctx, { version: '1.2.3' });
      assert.equal(other.calls[0].args.some((a) => a.startsWith('--script-shell')), false, 'your own absolute shell is kept');
    } finally {
      absolute.dispose();
    }
  } finally {
    s.dispose();
  }
});

test('a ready version is claimed under its install lock, never while another process holds it', async () => {
  const s = setup();
  try {
    seedNpxInstall(s.cacheDir, { spec: `${name}@1.2.3`, name, version: '1.2.3' });
    seedPackument(s.cacheDir, FEED, name, { versions: ['1.2.3'] });
    const held = tryLock(s.ctx.dir, installLockName(`${name}@1.2.3`));
    /** @type {string[]} */
    const events = [];
    s.ctx.run = fakeNpmRun(s.cacheDir).run;
    const pending = preinstall(s.ctx, {
      version: '1.2.3',
      waitMs: 10_000,
      onReady: () => events.push(tryLock(s.ctx.dir, installLockName(`${name}@1.2.3`)) ? 'claimed without the lock' : 'claimed under the lock'),
    });
    await new Promise((r) => setTimeout(r, 300));
    events.push('cleanup lets go');
    held?.release();
    assert.deepEqual(await pending, { ok: true, created: false });
    assert.deepEqual(events, ['cleanup lets go', 'claimed under the lock']);
  } finally {
    s.dispose();
  }
});

test('starts that wait for an interrupted install do not block its repair: their leases come once it is ready', async () => {
  const s = setup();
  try {
    seedNpxInstall(s.cacheDir, { spec: `${name}@1.2.3`, name, version: '1.2.3', complete: false });
    s.ctx.run = fakeNpmRun(s.cacheDir, { during: () => new Promise((r) => setTimeout(r, 200)) }).run;
    /** @type {(import('../src/state.js').Lease | undefined)[]} */
    const leases = [];
    const start = () => preinstall(s.ctx, { version: '1.2.3', waitMs: 10_000, onReady: () => leases.push(writeLease(s.ctx.dir, { name, version: '1.2.3' })) });
    const results = await Promise.all([start(), start(), start()]);
    assert.deepEqual(results.map((r) => r.ok), [true, true, true], 'no start refuses');
    assert.equal(results.filter((r) => r.ok && r.created).length, 1, 'one installed it, the others used that install');
    assert.equal(leases.length, 3);
    for (const l of leases) l?.release();
  } finally {
    s.dispose();
  }
});

test('the lock and the install lease name the npm that installs, so a killed owner does not hand the folder over', async () => {
  const s = setup();
  try {
    /** @type {any} */
    let seen;
    s.ctx.run = fakeNpmRun(s.cacheDir, {
      during: () => {
        const owner = JSON.parse(fs.readFileSync(path.join(s.ctx.dir, 'locks', `${installLockName(`${name}@1.2.3`)}.lock`, 'owner.json'), 'utf8'));
        const sessions = path.join(s.ctx.dir, 'sessions');
        const lease = JSON.parse(fs.readFileSync(path.join(sessions, fs.readdirSync(sessions).filter((n) => n.endsWith('.json'))[0]), 'utf8'));
        seen = { owner: owner.pids, lease: lease.pids };
      },
    }).run;
    assert.equal((await preinstall(s.ctx, { version: '1.2.3' })).ok, true);
    assert.deepEqual(seen, { owner: [FAKE_NPM_PID], lease: [FAKE_NPM_PID] });
  } finally {
    s.dispose();
  }
});

test('a copy that could still start is not deleted when it cannot be moved aside for a reinstall', async () => {
  const s = setup();
  try {
    const old = seedNpxInstall(s.cacheDir, { spec: `${name}@1.2.3`, name, version: '1.2.3' });
    seedPackument(s.cacheDir, FEED, name, { versions: ['1.2.3'] });
    fs.mkdirSync(s.ctx.dir, { recursive: true });
    fs.writeFileSync(path.join(s.ctx.dir, 'replaced'), 'not a folder');
    const npmFake = fakeNpmRun(s.cacheDir);
    s.ctx.run = npmFake.run;
    const r = await preinstall(s.ctx, { version: '1.2.3', reinstall: true });
    assert.equal(!r.ok && r.kind, 'local');
    assert.match(r.ok ? '' : r.reason, /cannot be moved aside to install it again/);
    assert.equal(npmFake.calls.length, 0);
    assert.equal(readNpxInstall(s.cacheDir, `${name}@1.2.3`, name).complete, true, 'still there for the offline fallback');
    assert.ok(fs.existsSync(old));
  } finally {
    s.dispose();
  }
});

test('a copy that an interrupted reinstall moved aside is put back: by the install step, a cache start, or a start that finds it missing', async () => {
  const s = setup();
  try {
    const folder = seedNpxInstall(s.cacheDir, { spec: `${name}@1.2.3`, name, version: '1.2.3' });
    seedPackument(s.cacheDir, FEED, name, { versions: ['1.2.3'] });
    const strand = () => {
      backUp(s.ctx.dir, folder);
      assert.equal(fs.existsSync(folder), false);
    };
    const debug = () => {};
    const o = { cacheDir: s.cacheDir, dir: s.ctx.dir, registryHref: FEED, name, version: '1.2.3', debug };

    strand();
    const npmFake = fakeNpmRun(s.cacheDir, { code: 1, stderr: 'npm error code ENOTFOUND' });
    s.ctx.run = npmFake.run;
    assert.deepEqual(await preinstall(s.ctx, { version: '1.2.3' }), { ok: true, created: false });
    assert.equal(npmFake.calls.length, 0, 'offline, no download needed');

    strand();
    let claimed = 0;
    assert.equal(await claimCached(o, () => claimed++), 'ready');
    assert.equal(claimed, 1);

    strand();
    await recoverInterrupted(o);
    assert.equal(readNpxInstall(s.cacheDir, `${name}@1.2.3`, name).complete, true);
    assert.equal(await claimCached({ ...o, version: '9.9.9' }, () => {}), 'missing');
  } finally {
    s.dispose();
  }
});

test("with npm's before setting, the full registry metadata npm caches counts", async () => {
  const s = setup({ env: { npm_config_before: '2030-01-01' } });
  try {
    const npmFake = fakeNpmRun(s.cacheDir);
    s.ctx.run = npmFake.run;
    assert.deepEqual(await preinstall(s.ctx, { version: '1.2.3' }), { ok: true, created: true });
    assert.equal(isCached(s.cacheDir, packumentCacheKey(FEED, name)), false, 'npm did not cache the short form');
    assert.deepEqual(await preinstall(s.ctx, { version: '1.2.3' }), { ok: true, created: false });
    assert.equal(npmFake.calls.length, 1);
  } finally {
    s.dispose();
  }
});
