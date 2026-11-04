// End-to-end with the REAL npm, offline (a localhost registry): starts from
// npm's cache and background updates. Verifies the npm behaviors these rely
// on, in whatever npm version runs the tests (CI runs npm 10 and 11):
// - `npm exec <spec>` installs into `_npx/<hash of the spec>` and writes the
//   hidden lockfile there, and caches the packument under the key we compute;
// - `npm exec --offline` then runs the package with no request at all and no
//   token in the npmrc;
// - `npm exec --package=<spec> --call "exit 0"` installs the same folder
//   without running the package;
// - a newer version installed in the background is what the next start runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCached, npxInstallDir, packumentCacheKey, readNpxInstall } from '../src/npm-cache.js';
import { resolveNpm } from '../src/npm-cli.js';
import { readState, stateDir, stateKey, updateState } from '../src/state.js';
import { validJwt } from '../fixtures/jwt.js';
import { makeTestRoot, waitFor } from '../fixtures/sandbox.js';

const RUN_MAIN = fileURLToPath(new URL('../fixtures/run-main.js', import.meta.url));
const FIXTURE_PKG = fileURLToPath(new URL('../fixtures/hello-mcp/', import.meta.url));
const isWin = process.platform === 'win32';
const npm = resolveNpm({ env: process.env });
const skip = npm ? false : 'npm-cli.js not found';
const name = '@contoso/hello-mcp';

/** @type {string} */ let root;
/** @type {http.Server} */ let server;
/** @type {string} */ let base;
/** @type {{ url: string, auth: string | undefined }[]} */ const seen = [];
/** @type {Record<string, { tgz: Buffer, integrity: string, shasum: string, manifest: any }>} */ const packed = {};
let published = ['1.0.0'];
let down = false;

/**
 * @param {string[]} args
 * @param {{ env: NodeJS.ProcessEnv, timeoutMs?: number }} opts
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
function run(args, { env, timeoutMs = 170_000 }) {
  return new Promise((resolve, reject) => {
    const cwd = path.join(root, 'cwd');
    const child = spawn(process.execPath, [RUN_MAIN, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** @param {NodeJS.ProcessEnv} extra */
function env(extra = {}) {
  const tmp = path.join(root, 'tmp');
  return {
    PATH: [path.dirname(npm?.node ?? process.execPath), path.dirname(process.execPath), ...(isWin ? [] : ['/usr/bin', '/bin'])].join(path.delimiter),
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    npm_config_cache: path.join(root, 'cache'),
    npm_config_globalconfig: path.join(root, 'global.npmrc'),
    npm_config_userconfig: path.join(root, 'empty.npmrc'),
    npm_config_update_notifier: 'false',
    npm_execpath: npm?.cli,
    npm_node_execpath: npm?.node,
    TEST_REGISTRY_HREF: `${base}/feed/`,
    HELLO_MCP_SHOW_VERSION: '1',
    ...(isWin ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT } : {}),
    ...extra,
  };
}

/** @param {string} version */
function pack(version) {
  assert.ok(npm);
  const dir = path.join(root, `pkg-${version}`);
  fs.mkdirSync(dir);
  for (const f of fs.readdirSync(FIXTURE_PKG)) fs.copyFileSync(path.join(FIXTURE_PKG, f), path.join(dir, f));
  const manifest = { ...JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')), version };
  delete manifest.scripts;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  const out = spawnSync(npm.node, [npm.cli, 'pack', '--json', '--ignore-scripts', '--pack-destination', root], {
    cwd: dir,
    env: { ...env(), npm_config_cache: path.join(root, 'pack-cache') },
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr);
  const [{ filename, integrity, shasum }] = JSON.parse(out.stdout);
  packed[version] = { tgz: fs.readFileSync(path.join(root, filename)), integrity, shasum, manifest };
}

before(async () => {
  if (!npm) return;
  root = makeTestRoot('real-npm-cache-');
  for (const d of ['tmp', 'home', 'cache', 'cwd']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'global.npmrc'), '');
  fs.writeFileSync(path.join(root, 'empty.npmrc'), '');
  server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0]);
    seen.push({ url, auth: req.headers.authorization });
    if (down) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":"down"}');
      return;
    }
    const latest = published[published.length - 1];
    const tarball = (/** @type {string} */ v) => `/_packaging/00000000-feed-guid/npm/registry/${name}/-/hello-mcp-${v}.tgz`;
    if (url === `/feed/${name}`) {
      const versions = Object.fromEntries(
        published.map((v) => [v, { ...packed[v].manifest, dist: { tarball: `${base}${tarball(v)}`, integrity: packed[v].integrity, shasum: packed[v].shasum } }]),
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name, 'dist-tags': { latest }, versions }));
    } else if (url === `/feed/-/package/${name}/dist-tags`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ latest }));
    } else if (published.some((v) => url === tarball(v))) {
      const v = /** @type {string} */ (published.find((p) => url === tarball(p)));
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(packed[v].tgz);
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  pack('1.0.0');
  pack('1.1.0');
});

after(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('real npm: start from the cache without a token, update in the background, start the update next', { skip, timeout: 600_000 }, async () => {
  const cache = path.join(root, 'cache');
  const feed = `${base}/feed/`;
  const key = stateKey(feed, `${name}@latest`);
  const dir = stateDir(cache);
  const token = validJwt();

  // 1. First start: online, resolved to the exact version.
  const first = await run(['--registry', 'ignored', '--', `${name}@latest`, 'a'], { env: env({ ADO_NPM_EXEC_TOKEN: token }) });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, 'REMOTE-OK@1.0.0 a\n');
  assert.equal(readState(dir, key)?.version, '1.0.0');
  // What npm wrote is what we look for.
  const install = readNpxInstall(cache, `${name}@1.0.0`, name);
  assert.equal(install.complete, true, `npm's install in ${install.dir}`);
  assert.ok(fs.readdirSync(path.join(cache, '_npx')).includes(path.basename(npxInstallDir(cache, [`${name}@1.0.0`]))));
  assert.equal(isCached(cache, packumentCacheKey(feed, name)), true, 'packument cache key');
  assert.equal(isCached(cache, packumentCacheKey(feed, name), { version: '1.0.0' }), true, 'the cached metadata lists the version');
  assert.equal(isCached(cache, packumentCacheKey(feed, name), { version: '1.1.0' }), false);

  // 2. Feed down, no token: the cached version starts with no request from npm.
  down = true;
  seen.length = 0;
  const offline = await run(['--registry', 'ignored', '--', `${name}@latest`, 'b'], { env: env() });
  assert.equal(offline.status, 0, offline.stderr);
  assert.equal(offline.stdout, 'REMOTE-OK@1.0.0 b\n');
  assert.deepEqual(seen, [], 'nothing asked the feed (the last check was just now)');

  // 3. 1.1.0 is published and a check is due: the cached 1.0.0 starts at
  //    once, and 1.1.0 is installed in the background meanwhile.
  down = false;
  published = ['1.0.0', '1.1.0'];
  updateState(dir, key, { registry: feed, spec: `${name}@latest`, name }, (s) => {
    delete s.checkedAt;
  });
  const release = path.join(root, 'release');
  const updating = run(['--registry', 'ignored', '--', `${name}@latest`, 'c'], { env: env({ ADO_NPM_EXEC_TOKEN: token, HELLO_MCP_WAIT_FOR: release }) });
  const promoted = await waitFor(() => readState(dir, key)?.version === '1.1.0', 240_000, 100);
  fs.writeFileSync(release, '');
  const third = await updating;
  assert.ok(promoted, `1.1.0 promoted; stderr:\n${third.stderr}`);
  assert.equal(third.status, 0, third.stderr);
  assert.equal(third.stdout, 'REMOTE-OK@1.0.0 c\n', 'the running server was not replaced');
  assert.match(third.stderr, /installed @contoso\/hello-mcp@1\.1\.0 in the background; the next start uses it/);
  assert.equal(readNpxInstall(cache, `${name}@1.1.0`, name).complete, true);
  assert.equal(isCached(cache, packumentCacheKey(feed, name), { version: '1.1.0' }), true, "npm's cached metadata lists the update");
  assert.deepEqual(readState(dir, key)?.installed, ['1.0.0', '1.1.0']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'tmp')).filter((n) => n.startsWith('ado-npm-exec-')), [], 'token files removed');

  // 4. The next start runs 1.1.0 from the cache, feed down, no token.
  down = true;
  seen.length = 0;
  const fourth = await run(['--registry', 'ignored', '--', `${name}@latest`, 'd'], { env: env() });
  assert.equal(fourth.status, 0, fourth.stderr);
  assert.equal(fourth.stdout, 'REMOTE-OK@1.1.0 d\n');
  assert.deepEqual(seen, []);
});

test('real npm: --prewarm installs without running, and the start needs no network', { skip, timeout: 300_000 }, async () => {
  down = false;
  published = ['1.0.0', '1.1.0'];
  const cache = path.join(root, 'cache-prewarm');
  const marker = path.join(root, 'prewarm-ran');
  const pre = await run(['--prewarm', '--registry', 'ignored', '--', `${name}@~1.0.0`], {
    env: env({ npm_config_cache: cache, ADO_NPM_EXEC_TOKEN: validJwt(), HELLO_MCP_MARKER: marker }),
  });
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(pre.stdout, '');
  assert.match(pre.stderr, /installed @contoso\/hello-mcp@1\.0\.0/);
  assert.equal(readNpxInstall(cache, `${name}@1.0.0`, name).complete, true);
  down = true;
  const start = await run(['--registry', 'ignored', '--', `${name}@~1.0.0`, 'e'], { env: env({ npm_config_cache: cache }) });
  assert.equal(start.status, 0, start.stderr);
  assert.equal(start.stdout, 'REMOTE-OK@1.0.0 e\n');
});
