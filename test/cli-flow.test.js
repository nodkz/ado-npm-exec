// The start paths: from npm's cache without a token, online with an exact
// version resolved on the feed, and the fallbacks between them. npm is the
// fake from fixtures/fake-npm; feed lookups go to a registry on localhost
// (fixtures/run-main.js admits it in place of an Azure Artifacts URL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRegistryUrl } from '../src/registry.js';
import { isFromFeedOrg, npxInstallDir, readNpxInstall } from '../src/npm-cache.js';
import { installLockName, readState, signInMemory, stateKey, tryLock, writeLease, writeState } from '../src/state.js';
import { seedNpxInstall, seedPackument } from '../fixtures/npm-cache.js';
import { validJwt, TENANT } from '../fixtures/jwt.js';
import { cliSandbox, installFakeTools, readToolLog, runNode, waitFor } from '../fixtures/sandbox.js';

const BIN = fileURLToPath(new URL('../bin/ado-npm-exec.js', import.meta.url));
const RUN_MAIN = fileURLToPath(new URL('../fixtures/run-main.js', import.meta.url));
const FEED = 'https://contoso.pkgs.visualstudio.com/_packaging/feed/npm/registry/';
const isWin = process.platform === 'win32';
const name = '@contoso/tool';

/** @param {ReturnType<typeof cliSandbox>} s @param {string} feed @param {string} version */
function seedCached(s, feed, version) {
  seedNpxInstall(s.cache, { spec: `${name}@${version}`, name, version, registry: feed });
  seedPackument(s.cache, feed, name, { versions: [version] });
}

/** The spec npm was asked to run. @param {any} rec */
const ranSpec = (rec) => rec.argv[rec.argv.indexOf('--') + 1];

test('a cached exact version starts with --offline: no token, no request, no token in the npmrc', async () => {
  const s = cliSandbox('flow-');
  try {
    seedCached(s, FEED, '1.0.0');
    const r = await runNode([BIN, FEED, `${name}@1.0.0`, 'serve'], s.env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    const rec = s.read();
    assert.equal(ranSpec(rec), `${name}@1.0.0`);
    assert.ok(rec.argv.includes('--offline'));
    assert.equal(rec.argv.at(-1), 'serve');
    assert.equal(rec.npmrc.includes('_authToken'), false);
    assert.match(rec.npmrc, /^registry=https:\/\/contoso\.pkgs\.visualstudio\.com\//);
    assert.deepEqual(s.leftovers(), []);
    assert.equal(typeof readState(s.dir, stateKey(FEED, `${name}@1.0.0`))?.usedAt, 'number');
    assert.equal(readState(s.dir, stateKey(FEED, `${name}@1.0.0`))?.version, '1.0.0', 'recorded, so cleanup keeps the pinned version');
  } finally {
    s.dispose();
  }
});

test('a spec resolved before starts its last version from the cache; the background check reports a missing sign-in', async () => {
  const s = cliSandbox('flow-');
  try {
    seedCached(s, FEED, '1.0.0');
    const key = stateKey(FEED, `${name}@latest`);
    writeState(s.dir, key, { v: 1, registry: FEED, spec: `${name}@latest`, name, version: '1.0.0', usedAt: 1 });
    const r = await runNode([RUN_MAIN, '--tenant', TENANT, FEED, `${name}@latest`], { ...s.env, FAKE_NPM_SLEEP_MS: '1500' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(ranSpec(s.read()), `${name}@1.0.0`);
    assert.ok(s.read().argv.includes('--offline'));
    assert.match(r.stderr, /could not check for a newer @contoso\/tool/);
    const state = readState(s.dir, key);
    assert.equal(state?.failures, 1, 'backs off');
    assert.ok((state?.nextCheckAt ?? 0) > Date.now());
    assert.deepEqual(s.leftovers(), []);
  } finally {
    s.dispose();
  }
});

test('--always-fresh asks the feed although the version is cached; the server still never gets the token', async () => {
  const s = cliSandbox('flow-');
  try {
    seedCached(s, FEED, '1.0.0');
    const jwt = validJwt();
    const r = await runNode([BIN, '--always-fresh', FEED, `${name}@1.0.0`], { ...s.env, ADO_NPM_EXEC_TOKEN: jwt });
    assert.equal(r.status, 0, r.stderr);
    const rec = s.read();
    assert.equal(typeof readState(s.dir, stateKey(FEED, `${name}@1.0.0`))?.checkedAt, 'number', 'the online path ran');
    assert.ok(rec.argv.includes('--offline'), 'the version it installed or found starts from npm\'s cache');
    assert.equal(rec.npmrc.includes('_authToken'), false);
    assert.equal(rec.argv.includes('--fetch-timeout=120000'), false, 'no request, so no fetch settings');
  } finally {
    s.dispose();
  }
});

test('no token: the cached copy runs instead, unless the offline fallback is off', async () => {
  const s = cliSandbox('flow-');
  try {
    seedCached(s, FEED, '1.0.0');
    const r = await runNode([BIN, '--always-fresh', '--tenant', TENANT, FEED, `${name}@1.0.0`], s.env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Starting the copy of @contoso\/tool@1\.0\.0 in npm's cache instead/);
    assert.ok(s.read().argv.includes('--offline'));

    fs.rmSync(s.record);
    const strict = await runNode([BIN, '--always-fresh', '--no-offline-fallback', '--tenant', TENANT, FEED, `${name}@1.0.0`], s.env);
    assert.equal(strict.status, 3);
    assert.match(strict.stderr, /Sign-in needed/);
    assert.equal(fs.existsSync(s.record), false, 'npm did not run');
    const env = await runNode([BIN, '--always-fresh', '--tenant', TENANT, FEED, `${name}@1.0.0`], { ...s.env, ADO_NPM_EXEC_OFFLINE_FALLBACK: '0' });
    assert.equal(env.status, 3);
  } finally {
    s.dispose();
  }
});

test('no token and nothing cached: a framed sign-in notice with the exact command, exit 3', async () => {
  const s = cliSandbox('flow-');
  try {
    const r = await runNode([BIN, '--tenant', TENANT, FEED, `${name}@1.0.0`], { ...s.env, SHELL: '/bin/zsh' });
    assert.equal(r.status, 3);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /┌─ Sign-in needed/);
    assert.match(r.stderr, new RegExp(`AZURE_CORE_LOGIN_EXPERIENCE_V2=off az login --tenant ${TENANT} --allow-no-subscriptions`));
    assert.match(r.stderr, new RegExp(`azd auth login --tenant-id ${TENANT}`));
    assert.match(r.stderr, /Install the Azure CLI/);
    for (const line of r.stderr.split('\n').filter(Boolean)) assert.match(line, /^ado-npm-exec: /, 'piped: every line is attributable');
  } finally {
    s.dispose();
  }
});

test('a cached start that fails at once makes the next start ask the feed', async () => {
  const s = cliSandbox('flow-');
  try {
    seedCached(s, FEED, '1.0.0');
    const r = await runNode([BIN, FEED, `${name}@1.0.0`], { ...s.env, FAKE_NPM_EXIT: '1' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /the next start asks the feed/);
    assert.equal(typeof readState(s.dir, stateKey(FEED, `${name}@1.0.0`))?.offlineFailedAt, 'number');
    const jwt = validJwt();
    const r2 = await runNode([BIN, FEED, `${name}@1.0.0`], { ...s.env, ADO_NPM_EXEC_TOKEN: jwt });
    assert.equal(r2.status, 0, r2.stderr);
    const reinstall = s.readSteps().find((step) => step.argv.includes(`--package=${name}@1.0.0`));
    assert.ok(reinstall, 'the copy that failed is installed again');
    assert.ok(reinstall.npmrc.includes(`:_authToken=${jwt}`), 'the install step has the token');
    assert.equal(s.read().npmrc.includes('_authToken'), false, 'the server does not');
    assert.equal(readState(s.dir, stateKey(FEED, `${name}@1.0.0`))?.offlineFailedAt, undefined, 'cleared by the online start');
  } finally {
    s.dispose();
  }
});

/** @type {http.Server} */ let server;
/** @type {string} */ let base;
/** @type {{ url: string, auth: string | undefined }[]} */ const seen = [];
/** @type {Record<string, { status: number, body: unknown }>} */ let routes = {};

before(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    seen.push({ url, auth: req.headers.authorization });
    const route = routes[url] ?? { status: 404, body: { error: 'not found' } };
    res.writeHead(route.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(route.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve(undefined)));
});

/** @param {ReturnType<typeof cliSandbox>} s @param {string[]} args @param {NodeJS.ProcessEnv} [extra] */
function runLocal(s, args, extra = {}) {
  return runNode([RUN_MAIN, '--registry', 'ignored', '--', ...args], { ...s.env, TEST_REGISTRY_HREF: `${base}/feed/`, ...extra });
}

const tags = `/feed/-/package/${name.replace('/', '%2f')}/dist-tags`;
const doc = `/feed/${name.replace('/', '%2f')}`;
/** @param {string[]} versions @param {string} latest */
const packument = (versions, latest) => ({
  name,
  'dist-tags': { latest },
  versions: Object.fromEntries(versions.map((v) => [v, { name, version: v, dist: { tarball: `${base}/feed/x.tgz` } }])),
});

test('a dist-tag is resolved on the feed with the token, and that exact version runs', async () => {
  const s = cliSandbox('flow-');
  try {
    const jwt = validJwt();
    routes = { [tags]: { status: 200, body: { latest: '1.2.3', next: '2.0.0-rc.1' } } };
    seen.length = 0;
    const r = await runLocal(s, [`${name}@latest`, 'serve'], { ADO_NPM_EXEC_TOKEN: jwt });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(ranSpec(s.read()), `${name}@1.2.3`);
    assert.deepEqual(seen, [{ url: tags, auth: `Bearer ${jwt}` }]);
    const state = readState(s.dir, stateKey(`${base}/feed/`, `${name}@latest`));
    assert.equal(state?.version, '1.2.3');
    assert.deepEqual(state?.installed, ['1.2.3']);

    const next = await runLocal(s, [`${name}@next`], { ADO_NPM_EXEC_TOKEN: jwt });
    assert.equal(next.status, 0, next.stderr);
    assert.equal(ranSpec(s.read()), `${name}@2.0.0-rc.1`);
  } finally {
    s.dispose();
  }
});

test('a range and a bare name are picked from the packument like npm does', async () => {
  const s = cliSandbox('flow-');
  try {
    routes = { [doc]: { status: 200, body: packument(['1.0.0', '1.5.0', '2.0.0'], '2.0.0') } };
    const r = await runLocal(s, [`${name}@^1.0.0`], { ADO_NPM_EXEC_TOKEN: validJwt() });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(ranSpec(s.read()), `${name}@1.5.0`);
    const bare = await runLocal(s, [name], { ADO_NPM_EXEC_TOKEN: validJwt() });
    assert.equal(bare.status, 0, bare.stderr);
    assert.equal(ranSpec(s.read()), `${name}@2.0.0`);
  } finally {
    s.dispose();
  }
});

test('one sign-in is reused: the tool that gave the last token runs first, alone, at the next start', async () => {
  const s = cliSandbox('flow-');
  try {
    const tools = installFakeTools(path.join(s.root, 'tools'));
    const log = path.join(s.root, 'tools.log');
    routes = { [tags]: { status: 200, body: { latest: '1.2.3' } } };
    /** @type {NodeJS.ProcessEnv} */
    const env = {
      PATH: `${tools}${path.delimiter}${s.env.PATH}`,
      FAKE_TOOL_LOG: log,
      FAKE_AZD_TOKEN: validJwt(),
      ADO_NPM_EXEC_TENANT: TENANT,
      ADO_NPM_EXEC_ALWAYS_FRESH: '1',
    };
    const ran = () => readToolLog(log).map((c) => c.tool);

    const first = await runLocal(s, [`${name}@latest`], env);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(ran(), ['az', 'azd'], 'az has no sign-in, azd has one; azureauth never runs');
    assert.equal(signInMemory(s.dir, TENANT).prefer, 'azd');
    assert.equal(fs.readFileSync(path.join(s.dir, 'sign-in.json'), 'utf8').includes('.'), false, 'no token stored');

    const second = await runLocal(s, [`${name}@latest`], env);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(ran(), ['az', 'azd', 'azd'], 'only the remembered tool ran');

    // azd's sign-in expired, and az has one now.
    const third = await runLocal(s, [`${name}@latest`], { ...env, FAKE_AZD_TOKEN: '', FAKE_AZ_TOKEN: validJwt() });
    assert.equal(third.status, 0, third.stderr);
    assert.deepEqual(ran().slice(3), ['azd', 'az']);
    assert.equal(signInMemory(s.dir, TENANT).prefer, 'az');
    assert.equal(ranSpec(s.read()), `${name}@1.2.3`);
  } finally {
    s.dispose();
  }
});

test('the feed\'s answers become clear errors: not found and no match exit 5, refused exits 3', async () => {
  const s = cliSandbox('flow-');
  try {
    routes = {};
    const missing = await runLocal(s, [`${name}@latest`], { ADO_NPM_EXEC_TOKEN: validJwt() });
    assert.equal(missing.status, 5);
    assert.match(missing.stderr, /@contoso\/tool@latest is not on .* or its upstream sources \(HTTP 404/);

    routes = { [tags]: { status: 200, body: { latest: '1.0.0' } }, [doc]: { status: 200, body: packument(['1.0.0'], '1.0.0') } };
    const noTag = await runLocal(s, [`${name}@beta`], { ADO_NPM_EXEC_TOKEN: validJwt() });
    assert.equal(noTag.status, 5);
    assert.match(noTag.stderr, /has no dist-tag "beta" on this feed; its latest version is 1\.0\.0/);
    const noVersion = await runLocal(s, [`${name}@^3`], { ADO_NPM_EXEC_TOKEN: validJwt() });
    assert.equal(noVersion.status, 5);
    assert.match(noVersion.stderr, /no version matching "\^3"/);

    routes = { [tags]: { status: 403, body: { message: 'TF400813: not authorized' } } };
    const refused = await runLocal(s, [`${name}@latest`], { ADO_NPM_EXEC_TOKEN: validJwt({ upn: 'someone@contoso.com' }) });
    assert.equal(refused.status, 3);
    assert.match(refused.stderr, /Sign-in refused/);
    assert.match(refused.stderr, /someone@contoso\.com/);
    assert.match(refused.stderr, /Reader role/);
    assert.equal(fs.existsSync(s.record), false, 'npm never ran');
  } finally {
    s.dispose();
  }
});

test('a feed our own lookup cannot reach: npm picks the version, or the cached copy runs', async () => {
  const s = cliSandbox('flow-');
  try {
    routes = { [tags]: { status: 503, body: { message: 'busy' } } };
    const r = await runLocal(s, [`${name}@latest`], { ADO_NPM_EXEC_TOKEN: validJwt(), FAKE_NPM_RESOLVES: '1.4.0' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(ranSpec(s.read()), `${name}@1.4.0`, 'the exact version npm picked');
    const [pick, install] = s.readSteps();
    assert.deepEqual([pick.argv[0], pick.argv.at(-2)], ['view', `${name}@latest`], 'with no copy to fall back to, npm tries too');
    assert.ok(install.argv.includes(`--package=${name}@1.4.0`));

    const feed = `${base}/feed/`;
    seedCached(s, feed, '1.0.0');
    writeState(s.dir, stateKey(feed, `${name}@latest`), { v: 1, registry: feed, spec: `${name}@latest`, name, version: '1.0.0', usedAt: 1 });
    const cached = await runLocal(s, [`${name}@latest`], { ADO_NPM_EXEC_TOKEN: validJwt(), ADO_NPM_EXEC_ALWAYS_FRESH: '1' });
    assert.equal(cached.status, 0, cached.stderr);
    assert.match(cached.stderr, /could not reach .* starting the copy of @contoso\/tool@1\.0\.0 in npm's cache/);
    assert.equal(ranSpec(s.read()), `${name}@1.0.0`);
    assert.ok(s.read().argv.includes('--offline'), 'the copy in the cache, without the network');
    assert.equal(s.read().npmrc.includes('_authToken'), false, 'and without the token');

    const proxied = await runLocal(s, [`${name}@latest`], {
      ADO_NPM_EXEC_TOKEN: validJwt(),
      ADO_NPM_EXEC_ALWAYS_FRESH: '1',
      HTTPS_PROXY: 'http://proxy.invalid:8080',
      FAKE_NPM_RESOLVES: '1.4.0',
    });
    assert.equal(proxied.status, 0, proxied.stderr);
    assert.equal(ranSpec(s.read()), `${name}@1.4.0`, 'behind a proxy npm (which uses it) picks the version');

    // Certificate checks off: no request of ours carries the token; npm (strict TLS) asks instead.
    routes = { [tags]: { status: 200, body: { latest: '1.0.0' } } };
    seen.length = 0;
    const tlsOff = await runLocal(s, [`${name}@latest`], {
      ADO_NPM_EXEC_TOKEN: validJwt(),
      ADO_NPM_EXEC_ALWAYS_FRESH: '1',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      FAKE_NPM_RESOLVES: '1.4.0',
    });
    assert.equal(tlsOff.status, 0, tlsOff.stderr);
    assert.deepEqual(seen, [], 'no lookup of ours');
    assert.equal(ranSpec(s.read()), `${name}@1.4.0`);
  } finally {
    s.dispose();
  }
});

test('a spec only npm can decide runs the exact version npm picks; the folder of the spec as written is never used', async () => {
  const s = cliSandbox('flow-');
  try {
    const feed = `${base}/feed/`;
    routes = { [doc]: { status: 503, body: { message: 'busy' } } };
    const spec = `${name}@^1.0.0`;
    // npm would run what this folder holds without asking anybody: here an install from another registry.
    const raw = seedNpxInstall(s.cache, { spec, name, version: '1.0.0', registry: 'https://registry.npmjs.org/' });
    const r = await runLocal(s, [spec], { ADO_NPM_EXEC_TOKEN: validJwt(), FAKE_NPM_RESOLVES: '1.2.0' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(ranSpec(s.read()), `${name}@1.2.0`);
    assert.ok(fs.existsSync(path.join(raw, 'node_modules', '.package-lock.json')), 'never run, never touched');
    assert.equal(readState(s.dir, stateKey(feed, spec))?.version, '1.2.0', 'the version npm picked is recorded');
  } finally {
    s.dispose();
  }
});

test('an install from another registry that cannot be removed is refused', { skip: isWin || process.getuid?.() === 0 }, async () => {
  const s = cliSandbox('flow-');
  try {
    const spec = `${name}@1.0.0`;
    seedNpxInstall(s.cache, { spec, name, version: '1.0.0', registry: 'https://registry.npmjs.org/' });
    // Neither moved aside nor removed: its parent folder is read-only.
    const npx = path.join(s.cache, '_npx');
    fs.chmodSync(npx, 0o500);
    try {
      const r = await runNode([BIN, FEED, spec], { ...s.env, ADO_NPM_EXEC_TOKEN: validJwt() });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /refusing to run @contoso\/tool@1\.0\.0: the install of @contoso\/tool@1\.0\.0 in npm's cache is from registry\.npmjs\.org, and it cannot be removed/);
      assert.equal(fs.existsSync(s.record), false, 'npm never ran');
    } finally {
      fs.chmodSync(npx, 0o700);
    }
  } finally {
    s.dispose();
  }
});

test('a start waits while another process installs the same version, then runs that install', async () => {
  const s = cliSandbox('flow-');
  try {
    const feed = `${base}/feed/`;
    routes = { [tags]: { status: 200, body: { latest: '1.3.0' } } };
    // Another process is installing 1.3.0: the folder is incomplete and its install lock is held.
    const folder = seedNpxInstall(s.cache, { spec: `${name}@1.3.0`, name, version: '1.3.0', complete: false, registry: feed });
    const lock = tryLock(s.dir, installLockName(`${name}@1.3.0`));
    assert.ok(lock);
    const pending = runLocal(s, [`${name}@latest`], { ADO_NPM_EXEC_TOKEN: validJwt() });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(fs.existsSync(s.record), false, 'npm does not run while the install is unfinished');
    seedNpxInstall(s.cache, { spec: `${name}@1.3.0`, name, version: '1.3.0', registry: feed });
    seedPackument(s.cache, feed, name, { versions: ['1.3.0'] });
    lock.release();
    const r = await pending;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(ranSpec(s.read()), `${name}@1.3.0`);
    assert.deepEqual(s.readSteps(), [], 'its install was used, not repeated');
    assert.ok(fs.existsSync(folder));
  } finally {
    s.dispose();
  }
});

test("npm's install errors keep their meaning: a missing version exits 5, a refused token 3", async () => {
  const s = cliSandbox('flow-');
  try {
    const missing = await runNode([BIN, FEED, `${name}@9.9.9`], {
      ...s.env,
      ADO_NPM_EXEC_TOKEN: validJwt(),
      FAKE_NPM_INSTALL_EXIT: '1',
      FAKE_NPM_INSTALL_STDERR: 'npm error code ETARGET\nnpm error notarget No matching version found for @contoso/tool@9.9.9.\n',
    });
    assert.equal(missing.status, 5, missing.stderr);
    assert.match(missing.stderr, /@contoso\/tool@9\.9\.9 is not on .* \(npm exited with 1: npm error code ETARGET\)/);
    const refused = await runNode([BIN, FEED, `${name}@1.0.0`], {
      ...s.env,
      ADO_NPM_EXEC_TOKEN: validJwt({ upn: 'someone@contoso.com' }),
      FAKE_NPM_INSTALL_EXIT: '1',
      FAKE_NPM_INSTALL_STDERR: 'npm error code E401\nnpm error 401 Unauthorized - GET https://contoso.pkgs.visualstudio.com/x\n',
    });
    assert.equal(refused.status, 3, refused.stderr);
    assert.match(refused.stderr, /Sign-in refused/);
    assert.match(refused.stderr, /someone@contoso\.com/);
    assert.equal(fs.existsSync(s.record), false, 'the package never ran');
  } finally {
    s.dispose();
  }
});

test('a spec gone from the feed at the last check does not start from the cache', async () => {
  const s = cliSandbox('flow-');
  try {
    seedCached(s, FEED, '1.0.0');
    const key = stateKey(FEED, `${name}@latest`);
    writeState(s.dir, key, { v: 1, registry: FEED, spec: `${name}@latest`, name, version: '1.0.0', usedAt: 1, missingAt: 2 });
    const r = await runNode([BIN, '--tenant', TENANT, FEED, `${name}@latest`], s.env);
    assert.equal(r.status, 3, 'it asks the feed, which needs a sign-in');
    assert.equal(fs.existsSync(s.record), false);
    assert.match(r.stderr, /Sign-in needed/);
  } finally {
    s.dispose();
  }
});

test('a relative npm cache folder is the one npm uses: relative to the current folder', async () => {
  const s = cliSandbox('flow-');
  try {
    const cwd = path.join(s.root, 'work');
    fs.mkdirSync(cwd);
    const r = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, FEED, `${name}@1.0.0`], { env: { ...s.env, npm_config_cache: 'rel-cache', ADO_NPM_EXEC_TOKEN: validJwt() }, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stderr }));
    });
    assert.equal(/** @type {any} */ (r).status, 0, /** @type {any} */ (r).stderr);
    const cache = path.join(cwd, 'rel-cache');
    const given = /** @type {string[]} */ (s.read().argv).find((a) => a.startsWith('--cache='));
    assert.equal(fs.realpathSync(/** @type {string} */ (given).slice('--cache='.length)), fs.realpathSync(cache), 'npm gets it as --cache');
    assert.ok(fs.existsSync(path.join(cache, '_ado-npm-exec')), 'and ado-npm-exec checks it');
  } finally {
    s.dispose();
  }
});

test('unknown feeds are still refused before anything else', async () => {
  const s = cliSandbox('flow-');
  try {
    const r = await runNode([BIN, 'https://registry.npmjs.org/', `${name}@1.0.0`], s.env);
    assert.equal(r.status, 2);
    assert.equal(validateRegistryUrl(FEED).host, 'contoso.pkgs.visualstudio.com');
  } finally {
    s.dispose();
  }
});

test('an install of the same version from another registry is never run as ours', async () => {
  const s = cliSandbox('flow-');
  try {
    // A manual `npx @contoso/tool@1.0.0` from another registry filled the same folder.
    seedNpxInstall(s.cache, { spec: `${name}@1.0.0`, name, version: '1.0.0', registry: 'https://registry.npmjs.org/' });
    seedPackument(s.cache, FEED, name, { versions: ['1.0.0'] });
    const folder = npxInstallDir(s.cache, [`${name}@1.0.0`]);
    const noToken = await runNode([BIN, '--tenant', TENANT, FEED, `${name}@1.0.0`], s.env);
    assert.equal(noToken.status, 3, 'not a start from the cache');
    assert.ok(fs.existsSync(folder));

    const lease = writeLease(s.dir, { name, version: '1.0.0', pid: process.pid });
    const inUse = await runNode([BIN, FEED, `${name}@1.0.0`], { ...s.env, ADO_NPM_EXEC_TOKEN: validJwt() });
    assert.equal(inUse.status, 1);
    assert.match(inUse.stderr, /refusing to run @contoso\/tool@1\.0\.0: the install of @contoso\/tool@1\.0\.0 in npm's cache is from registry\.npmjs\.org, and another process may use it/);
    assert.equal(fs.existsSync(s.record), false);
    lease?.release();

    const online = await runNode([BIN, FEED, `${name}@1.0.0`], { ...s.env, ADO_NPM_EXEC_TOKEN: validJwt() });
    assert.equal(online.status, 0, online.stderr);
    assert.equal(isFromFeedOrg(FEED, readNpxInstall(s.cache, `${name}@1.0.0`, name).resolved), true, 'replaced by an install from the feed');
    assert.ok(s.read().argv.includes('--offline'), 'and run from what was just installed, with no request');
  } finally {
    s.dispose();
  }
});

test('a copy that failed at start is installed again, also when its registry metadata is gone, and only then the mark is cleared', async () => {
  const s = cliSandbox('flow-');
  try {
    const folder = seedNpxInstall(s.cache, { spec: `${name}@1.0.0`, name, version: '1.0.0', registry: FEED });
    fs.writeFileSync(path.join(folder, 'marker'), 'the copy that failed');
    const key = stateKey(FEED, `${name}@1.0.0`);
    writeState(s.dir, key, { v: 1, registry: FEED, spec: `${name}@1.0.0`, name, version: '1.0.0', offlineFailedAt: 5 });
    const r = await runNode([BIN, FEED, `${name}@1.0.0`], { ...s.env, ADO_NPM_EXEC_TOKEN: validJwt() });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(s.readSteps().some((step) => step.argv.includes(`--package=${name}@1.0.0`)), 'installed again');
    assert.equal(fs.existsSync(path.join(folder, 'marker')), false, 'a fresh copy');
    assert.equal(readState(s.dir, key)?.offlineFailedAt, undefined);
  } finally {
    s.dispose();
  }
});

test('a session whose lease could not be written writes it as soon as it can', { skip: isWin || process.getuid?.() === 0 }, async () => {
  const s = cliSandbox('flow-');
  try {
    seedCached(s, FEED, '1.0.0');
    const sessions = path.join(s.dir, 'sessions');
    fs.mkdirSync(s.dir, { recursive: true });
    // A full disk, for a moment: the sessions folder cannot be created.
    fs.writeFileSync(sessions, '');
    const pending = runNode([RUN_MAIN, '--registry', 'ignored', '--', `${name}@1.0.0`], {
      ...s.env,
      TEST_REGISTRY_HREF: FEED,
      TEST_LEASE_RETRY_MS: '100',
      FAKE_NPM_SLEEP_MS: '3000',
    });
    const started = await waitFor(() => fs.existsSync(s.record), 20_000);
    assert.ok(started, 'the server starts without a lease');
    fs.rmSync(sessions);
    const leased = await waitFor(() => fs.existsSync(sessions) && fs.readdirSync(sessions).some((n) => n.endsWith('.json')), 10_000);
    const r = await pending;
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /could not write a session lease in .*; trying again every 0 s/);
    assert.ok(leased, 'written while the server runs');
  } finally {
    s.dispose();
  }
});
