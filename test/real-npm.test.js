// End-to-end with the REAL npm, fully offline: a localhost registry serves a
// packed fixture package. Verifies the npm behaviors this tool relies on:
// - stdout carries only the launched program's output, even when the user's
//   config enables foreground install scripts;
// - a hostile project .npmrc and a same-name local package in the cwd are
//   ignored (--prefix=<temp dir>), and the registry only ever sees our token;
// - npm errors never land on stdout, even with json=true inherited.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNpm } from '../src/npm-cli.js';
import { validJwt } from '../fixtures/jwt.js';

const RUN_MAIN = fileURLToPath(new URL('../fixtures/run-main.js', import.meta.url));
const FIXTURE_PKG = fileURLToPath(new URL('../fixtures/hello-mcp/', import.meta.url));
const isWin = process.platform === 'win32';
const npm = resolveNpm({ env: process.env });
const skip = npm ? false : 'npm-cli.js not found';

/**
 * Async on purpose: the registry is served from this process, so a
 * synchronous spawn would block it.
 *
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number }} opts
 * @returns {Promise<{ status: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string }>}
 */
function run(args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', reject);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

/** @type {string} */ let root;
/** @type {http.Server} */ let server;
/** @type {string} */ let base;
/** @type {{ url: string, auth: string | undefined }[]} */ const seen = [];

/** @param {NodeJS.ProcessEnv} extra */
function cleanEnv(extra) {
  const tmp = path.join(root, 'tmp');
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    PATH: [path.dirname(npm?.node ?? process.execPath), path.dirname(process.execPath), ...(isWin ? [] : ['/usr/bin', '/bin'])].join(path.delimiter),
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    npm_config_cache: path.join(root, 'cache'),
    npm_config_globalconfig: path.join(root, 'global.npmrc'),
    npm_config_update_notifier: 'false',
    ...(isWin ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT } : {}),
    ...extra,
  };
  return env;
}

before(async () => {
  if (!npm) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-npm-exec-test-'));
  for (const d of ['tmp', 'home', 'cache', 'pkg']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'global.npmrc'), '');
  fs.writeFileSync(path.join(root, 'empty.npmrc'), '');
  for (const f of fs.readdirSync(FIXTURE_PKG)) fs.copyFileSync(path.join(FIXTURE_PKG, f), path.join(root, 'pkg', f));

  const packed = spawnSync(npm.node, [npm.cli, 'pack', '--json', '--ignore-scripts', '--pack-destination', root], {
    cwd: path.join(root, 'pkg'),
    // A separate cache, or npm exec would find the tarball without fetching it.
    env: cleanEnv({ npm_config_userconfig: path.join(root, 'empty.npmrc'), npm_config_cache: path.join(root, 'pack-cache') }),
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, packed.stderr);
  const [{ filename, integrity, shasum }] = JSON.parse(packed.stdout);
  const tgz = fs.readFileSync(path.join(root, filename));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'pkg', 'package.json'), 'utf8'));
  // Azure Artifacts serves tarballs from GUID paths, not the feed-name path:
  // auth for them must come from the registry/scope fallback in npm.
  const tarballPath = '/_packaging/00000000-feed-guid/npm/registry/@contoso/hello-mcp/-/hello-mcp-1.0.0.tgz';

  server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0]);
    seen.push({ url, auth: req.headers.authorization });
    if (url === '/feed/@contoso/hello-mcp') {
      const doc = {
        name: manifest.name,
        'dist-tags': { latest: manifest.version },
        versions: {
          [manifest.version]: { ...manifest, hasInstallScript: true, dist: { tarball: `${base}${tarballPath}`, integrity, shasum } },
        },
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(doc));
    } else if (url === tarballPath) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(tgz);
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('real npm: clean stdout, our token only, hostile cwd ignored', { skip, timeout: 180_000 }, async () => {
  assert.ok(npm);
  const jwt = validJwt();
  const port = new URL(base).port;
  const project = path.join(root, 'project');
  const local = path.join(project, 'node_modules', '@contoso', 'hello-mcp');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'hostile', version: '1.0.0' }));
  fs.writeFileSync(
    path.join(project, '.npmrc'),
    [
      `registry=${base}/wrong/`,
      `@contoso:registry=${base}/wrong/`,
      `//127.0.0.1:${port}/feed/:_authToken=WRONG-FEED-TOKEN`,
      `//127.0.0.1:${port}/:_authToken=WRONG-HOST-TOKEN`,
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(local, 'package.json'), JSON.stringify({ name: '@contoso/hello-mcp', version: '1.0.0', bin: { 'hello-mcp': 'bin.js' } }));
  fs.writeFileSync(path.join(local, 'bin.js'), "#!/usr/bin/env node\nprocess.stdout.write('LOCAL-COPY\\n');\n", { mode: 0o755 });
  if (!isWin) {
    fs.mkdirSync(path.join(project, 'node_modules', '.bin'));
    fs.symlinkSync('../@contoso/hello-mcp/bin.js', path.join(project, 'node_modules', '.bin', 'hello-mcp'));
  }
  const marker = path.join(root, 'postinstall-ran');
  seen.length = 0;

  const r = await run([RUN_MAIN, '--registry', 'ignored', '--', '@contoso/hello-mcp@1.0.0', 'a', 'b'], {
    cwd: project,
    env: cleanEnv({
      npm_execpath: npm.cli,
      npm_node_execpath: npm.node,
      // What an outer `npm exec --registry=<public>` would export; must not leak.
      npm_config_registry: 'https://registry.invalid/',
      npm_config_userconfig: path.join(root, 'empty.npmrc'),
      // Environment config outranks our npmrc file, so these must be removed.
      'npm_config_@contoso:registry': `${base}/wrong/`,
      [`npm_config_//127.0.0.1:${port}/feed/:_authToken`]: 'WRONG-ENV-TOKEN',
      // A user config that would let install scripts write to our stdout.
      npm_config_foreground_scripts: 'true',
      ADO_NPM_EXEC_TOKEN: jwt,
      TEST_REGISTRY_HREF: `${base}/feed/`,
      HELLO_MCP_MARKER: marker,
    }),
    timeoutMs: 170_000,
  });

  assert.equal(r.status, 0, `stderr:\n${r.stderr}`);
  assert.equal(r.stdout, 'REMOTE-OK a b\n');
  assert.ok(fs.existsSync(marker), 'the postinstall script did run (its output was captured by npm)');
  assert.ok(seen.some((s) => s.url === '/feed/@contoso/hello-mcp'), 'packument fetched from the feed');
  assert.ok(seen.some((s) => s.url.endsWith('.tgz')), 'tarball fetched');
  for (const s of seen) assert.equal(s.auth, `Bearer ${jwt}`, `auth for ${s.url}`);
  assert.equal(r.stderr.includes(jwt), false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'tmp')).filter((n) => n.startsWith('ado-npm-exec-')), []);
});

test('real npm: errors stay off stdout even with json=true inherited', { skip, timeout: 180_000 }, async () => {
  assert.ok(npm);
  const cwd = path.join(root, 'empty-cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const r = await run([RUN_MAIN, '--registry', 'ignored', '--', '@contoso/missing@1.0.0'], {
    cwd,
    env: cleanEnv({
      npm_execpath: npm.cli,
      npm_node_execpath: npm.node,
      npm_config_json: 'true',
      ADO_NPM_EXEC_TOKEN: validJwt(),
      TEST_REGISTRY_HREF: `${base}/feed/`,
    }),
    timeoutMs: 170_000,
  });
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /404|not found/i);
});
