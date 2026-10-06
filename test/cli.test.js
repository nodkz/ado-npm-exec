import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORCED_NPM_FLAGS } from '../src/run.js';
import { renderNpmrc } from '../src/npmrc.js';
import { validateRegistryUrl } from '../src/registry.js';
import { validJwt, TENANT } from '../fixtures/jwt.js';
import { makeTestRoot } from '../fixtures/sandbox.js';

const BIN = fileURLToPath(new URL('../bin/ado-npm-exec.js', import.meta.url));
const FAKE_NPM = fileURLToPath(new URL('../fixtures/fake-npm/npm-cli.js', import.meta.url));
const FEED = 'https://contoso.pkgs.visualstudio.com/_packaging/feed/npm/registry/';
const isWin = process.platform === 'win32';
const pkgVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function sandbox() {
  const root = makeTestRoot('cli-');
  const tmp = path.join(root, 'tmp');
  const home = path.join(root, 'home');
  fs.mkdirSync(tmp);
  fs.mkdirSync(home);
  const record = path.join(root, 'record.json');
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    PATH: path.dirname(process.execPath),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    npm_execpath: FAKE_NPM,
    npm_node_execpath: process.execPath,
    FAKE_NPM_RECORD: record,
    ...(isWin ? { SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT, ComSpec: process.env.ComSpec } : {}),
  };
  return {
    root,
    env,
    record,
    /** @returns {any} */
    read: () => JSON.parse(fs.readFileSync(record, 'utf8')),
    leftovers: () => fs.readdirSync(tmp).filter((n) => n.startsWith('ado-npm-exec-')),
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {{ input?: string, cwd?: string }} [opts]
 */
function runBin(args, env, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 60_000, ...opts });
}

/** Write a fake `az` that prints `token` and records its arguments. @param {string} dir @param {string} token @param {string} argsFile */
function writeFakeAz(dir, token, argsFile) {
  fs.mkdirSync(dir, { recursive: true });
  if (isWin) {
    fs.writeFileSync(path.join(dir, 'az.cmd'), `@echo off\r\necho %*> "${argsFile}"\r\necho ${token}\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, 'az'), `#!/bin/sh\necho "$*" > '${argsFile}'\necho '${token}'\n`, { mode: 0o755 });
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

/** @param {import('node:child_process').ChildProcess} child */
function exited(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

test('runs npm exec against the feed with a private npmrc and a clean environment', () => {
  const s = sandbox();
  try {
    const jwt = validJwt();
    const r = runBin(['--registry', FEED, '--', '@contoso/tool@1.0.0', 'serve', '--flag'], {
      ...s.env,
      ADO_NPM_EXEC_TOKEN: jwt,
      npm_config_registry: 'https://registry.npmjs.org/',
      NPM_CONFIG_USERCONFIG: path.join(s.root, 'user.npmrc'),
      npm_config_cache: path.join(s.root, 'cache'),
      npm_config_globalconfig: path.join(s.root, 'global.npmrc'),
      'npm_config_//contoso.pkgs.visualstudio.com/_packaging/feed/npm/registry/:_authToken': 'stale',
    }, { cwd: s.root });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr.includes(jwt), false);

    const rec = s.read();
    const prefixDir = path.dirname(rec.env.npm_config_userconfig);
    assert.deepEqual(rec.argv, [
      'exec',
      `--prefix=${prefixDir}`,
      `--registry=${FEED}`,
      ...FORCED_NPM_FLAGS,
      '--',
      '@contoso/tool@1.0.0',
      'serve',
      '--flag',
    ]);
    assert.equal(rec.npmrc, renderNpmrc({ registry: validateRegistryUrl(FEED), token: jwt, scope: 'contoso' }));
    if (!isWin) {
      assert.equal(rec.npmrcMode, 0o600);
      assert.equal(rec.dirMode, 0o700);
    }
    assert.equal(fs.realpathSync(rec.cwd), fs.realpathSync(s.root), 'npm runs in the caller cwd');
    const keys = Object.keys(rec.env).map((k) => k.toLowerCase());
    assert.equal(keys.includes('npm_config_registry'), false);
    assert.equal(keys.includes('ado_npm_exec_token'), false);
    assert.equal(keys.some((k) => k.startsWith('npm_config_//')), false);
    assert.equal(keys.filter((k) => k === 'npm_config_userconfig').length, 1);
    assert.equal(rec.env.npm_config_cache, path.join(s.root, 'cache'));
    assert.equal(rec.env.npm_config_globalconfig, path.join(s.root, 'global.npmrc'));
    assert.deepEqual(s.leftovers(), [], 'temp npmrc removed');
  } finally {
    s.dispose();
  }
});

test('stdout and stdin belong to the child: nothing added, nothing consumed', () => {
  const s = sandbox();
  try {
    const out = '{"jsonrpc":"2.0","id":1,"result":{}}\n';
    const input = '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n';
    const r = runBin(['--verbose', FEED, 'tool'], {
      ...s.env,
      ADO_NPM_EXEC_TOKEN: validJwt(),
      FAKE_NPM_STDOUT: out,
      FAKE_NPM_READ_STDIN: '1',
    }, { input });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, out);
    assert.match(r.stderr, /ado-npm-exec: feed https:\/\/contoso\.pkgs\.visualstudio\.com/);
    assert.equal(s.read().stdin, input);
  } finally {
    s.dispose();
  }
});

test('propagates the child exit code', () => {
  const s = sandbox();
  try {
    const r = runBin([FEED, 'tool'], { ...s.env, ADO_NPM_EXEC_TOKEN: validJwt(), FAKE_NPM_EXIT: '7' });
    assert.equal(r.status, 7);
    assert.deepEqual(s.leftovers(), []);
  } finally {
    s.dispose();
  }
});

test('usage errors exit 2 without touching stdout or running npm', () => {
  const s = sandbox();
  try {
    for (const args of [
      [],
      ['--registry', FEED],
      ['--bogus', FEED, 'tool'],
      ['https://registry.npmjs.org/', 'tool'],
      ['http://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/', 'tool'],
      [FEED, 'git+https://example.com/x.git'],
      ['--tenant', 'not-a-guid', FEED, 'tool'],
    ]) {
      const r = runBin(args, { ...s.env, ADO_NPM_EXEC_TOKEN: validJwt() });
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /ado-npm-exec: /);
    }
    assert.equal(fs.existsSync(s.record), false);
  } finally {
    s.dispose();
  }
});

test('help and version go to stderr', () => {
  const h = runBin(['--help'], {});
  assert.equal(h.status, 0);
  assert.equal(h.stdout, '');
  assert.match(h.stderr, /^Usage:/);
  const v = runBin(['--version'], {});
  assert.equal(v.status, 0);
  assert.equal(v.stdout, '');
  assert.equal(v.stderr, `${pkgVersion}\n`);
});

test('no token source: exit 3 with an actionable message and no npm run', () => {
  const s = sandbox();
  try {
    const r = runBin(['--tenant', TENANT, FEED, 'tool'], s.env);
    assert.equal(r.status, 3);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /could not acquire/);
    assert.match(r.stderr, /Install Azure CLI/);
    assert.equal(fs.existsSync(s.record), false);
    assert.deepEqual(s.leftovers(), []);
  } finally {
    s.dispose();
  }
});

test('a PAT in ADO_NPM_EXEC_TOKEN is refused', () => {
  const s = sandbox();
  try {
    const pat = 'p'.repeat(52);
    const r = runBin([FEED, 'tool'], { ...s.env, ADO_NPM_EXEC_TOKEN: pat });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /PATs are not supported/);
    assert.equal(r.stderr.includes(pat), false);
    assert.equal(fs.existsSync(s.record), false);
  } finally {
    s.dispose();
  }
});

test('gets the token from az on PATH (directory with spaces and parentheses)', () => {
  const s = sandbox();
  try {
    const jwt = validJwt();
    const azDir = path.join(s.root, 'Azure CLI (x86)', 'wbin');
    const argsFile = path.join(s.root, 'az-args.txt');
    writeFakeAz(azDir, jwt, argsFile);
    const r = runBin(['--tenant', TENANT, FEED, '@contoso/tool'], {
      ...s.env,
      PATH: `${azDir}${path.delimiter}${s.env.PATH}`,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(
      fs.readFileSync(argsFile, 'utf8').trim(),
      `account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken --output tsv --tenant ${TENANT}`,
    );
    assert.match(s.read().npmrc, new RegExp(`:_authToken=${jwt.replace(/[.]/g, '\\.')}\\n$`));
  } finally {
    s.dispose();
  }
});

test('SIGTERM removes the npmrc before forwarding the signal', { skip: isWin }, async () => {
  const s = sandbox();
  try {
    const ready = path.join(s.root, 'ready');
    const child = spawn(process.execPath, [BIN, FEED, 'tool'], {
      env: { ...s.env, ADO_NPM_EXEC_TOKEN: validJwt(), FAKE_NPM_WAIT: ready, FAKE_NPM_SIGNAL_EXIT: '143' },
      stdio: 'ignore',
    });
    assert.ok(await waitFor(() => fs.existsSync(ready), 20_000), 'fake npm started');
    const done = exited(child);
    child.kill('SIGTERM');
    const { code } = /** @type {any} */ (await done);
    const rec = s.read();
    assert.equal(rec.gotSignal, 'SIGTERM');
    assert.equal(rec.npmrcExistsAtSignal, false, 'token file already gone when npm saw the signal');
    assert.equal(code, 143);
    assert.deepEqual(s.leftovers(), []);
  } finally {
    s.dispose();
  }
});

test('SIGHUP is forwarded as SIGTERM (npm only forwards INT/TERM)', { skip: isWin }, async () => {
  const s = sandbox();
  try {
    const ready = path.join(s.root, 'ready');
    const child = spawn(process.execPath, [BIN, FEED, 'tool'], {
      env: { ...s.env, ADO_NPM_EXEC_TOKEN: validJwt(), FAKE_NPM_WAIT: ready },
      stdio: 'ignore',
    });
    assert.ok(await waitFor(() => fs.existsSync(ready), 20_000));
    const done = exited(child);
    child.kill('SIGHUP');
    await done;
    assert.equal(s.read().gotSignal, 'SIGTERM');
  } finally {
    s.dispose();
  }
});

test('a child killed by a signal is mirrored', { skip: isWin }, () => {
  const s = sandbox();
  try {
    const r = runBin([FEED, 'tool'], { ...s.env, ADO_NPM_EXEC_TOKEN: validJwt(), FAKE_NPM_KILL_SELF: '1' });
    assert.equal(r.signal, 'SIGKILL');
    assert.deepEqual(s.leftovers(), []);
  } finally {
    s.dispose();
  }
});

test('a signal during token acquisition kills the provider and exits', { skip: isWin }, async () => {
  const s = sandbox();
  try {
    const azDir = path.join(s.root, 'az-bin');
    const pidFile = path.join(s.root, 'az.pid');
    fs.mkdirSync(azDir);
    fs.writeFileSync(path.join(azDir, 'az'), `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`, { mode: 0o755 });
    const child = spawn(process.execPath, [BIN, '--tenant', TENANT, FEED, 'tool'], {
      env: { ...s.env, PATH: `${azDir}:${s.env.PATH}:/bin:/usr/bin` },
      stdio: 'ignore',
    });
    assert.ok(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 20_000));
    const azPid = Number(fs.readFileSync(pidFile, 'utf8'));
    const started = Date.now();
    const done = exited(child);
    child.kill('SIGTERM');
    const { code, signal } = /** @type {any} */ (await done);
    assert.ok(Date.now() - started < 5000);
    assert.ok(code === 143 || signal === 'SIGTERM', `code=${code} signal=${signal}`);
    const gone = await waitFor(() => {
      try {
        process.kill(azPid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5000);
    assert.ok(gone, 'az was killed');
    assert.equal(fs.existsSync(s.record), false);
    assert.deepEqual(s.leftovers(), []);
  } finally {
    s.dispose();
  }
});

/**
 * Start the bin with a fake npm that runs a fake server (optionally behind a
 * launcher) and wait until the server is up.
 *
 * @param {ReturnType<typeof sandbox>} s
 * @param {NodeJS.ProcessEnv} extra
 */
async function startWithServer(s, extra) {
  const serverPid = path.join(s.root, 'server.pid');
  const events = path.join(s.root, 'server.events');
  fs.writeFileSync(events, '');
  const child = spawn(process.execPath, [BIN, FEED, 'tool'], {
    env: { ...s.env, ADO_NPM_EXEC_TOKEN: validJwt(), FAKE_NPM_SERVER_PID: serverPid, FAKE_NPM_SERVER_EVENTS: events, ...extra },
    stdio: 'ignore',
  });
  assert.ok(await waitFor(() => fs.existsSync(serverPid) && fs.readFileSync(serverPid, 'utf8') !== '', 20_000), 'server started');
  const pid = Number(fs.readFileSync(serverPid, 'utf8'));
  return { child, pid, events: () => fs.readFileSync(events, 'utf8').split('\n').filter(Boolean), done: exited(child) };
}

/** @param {number} pid */
function gone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

test('SIGTERM reaches the server even when npm ignores it (npm 10)', { skip: isWin }, async () => {
  const s = sandbox();
  try {
    const run = await startWithServer(s, { FAKE_NPM_IGNORE_SIGNALS: '1' });
    const started = Date.now();
    run.child.kill('SIGTERM');
    await run.done;
    assert.ok(Date.now() - started < 3000, 'no need to wait for the SIGKILL deadline');
    assert.deepEqual(run.events(), ['SIGTERM'], 'the server got exactly one SIGTERM');
    assert.ok(await waitFor(() => gone(run.pid), 3000), 'server stopped');
    assert.deepEqual(s.read().npmSignals, ['SIGTERM']);
    assert.deepEqual(s.leftovers(), []);
  } finally {
    s.dispose();
  }
});

test('SIGTERM reaches a server started by a launcher that does not forward it', { skip: isWin }, async () => {
  const s = sandbox();
  try {
    const run = await startWithServer(s, { FAKE_NPM_IGNORE_SIGNALS: '1', FAKE_NPM_LAUNCHER: '1' });
    run.child.kill('SIGTERM');
    await run.done;
    assert.deepEqual(run.events(), ['SIGTERM']);
    assert.ok(await waitFor(() => gone(run.pid), 3000), 'server stopped');
  } finally {
    s.dispose();
  }
});

test('a second signal kills a server that ignores SIGTERM', { skip: isWin }, async () => {
  const s = sandbox();
  try {
    const run = await startWithServer(s, { FAKE_NPM_IGNORE_SIGNALS: '1', FAKE_NPM_SERVER_MODE: 'ignore' });
    run.child.kill('SIGTERM');
    await waitFor(() => run.events().length > 0, 3000);
    const started = Date.now();
    run.child.kill('SIGTERM');
    await run.done;
    assert.ok(Date.now() - started < 2000);
    assert.ok(await waitFor(() => gone(run.pid), 3000), 'server killed');
    assert.deepEqual(s.leftovers(), []);
  } finally {
    s.dispose();
  }
});

test('a server that ignores SIGTERM is killed after 5 seconds', { skip: isWin }, async () => {
  const s = sandbox();
  try {
    const run = await startWithServer(s, { FAKE_NPM_IGNORE_SIGNALS: '1', FAKE_NPM_SERVER_MODE: 'ignore' });
    const started = Date.now();
    run.child.kill('SIGTERM');
    await run.done;
    const took = Date.now() - started;
    assert.ok(took >= 4500 && took < 9000, `took ${took} ms`);
    assert.ok(await waitFor(() => gone(run.pid), 3000), 'server killed');
  } finally {
    s.dispose();
  }
});

test('when the parent dies without signalling, the tree is stopped and the token removed', { skip: isWin }, async () => {
  const s = sandbox();
  try {
    const ready = path.join(s.root, 'ready');
    const binPidFile = path.join(s.root, 'bin.pid');
    // A parent like `npm exec` killed with SIGKILL by an MCP client.
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `const c = require('child_process').spawn(process.execPath, ${JSON.stringify([BIN, FEED, 'tool'])}, { stdio: 'ignore' });
         require('fs').writeFileSync(${JSON.stringify(binPidFile)}, String(c.pid));
         setInterval(() => {}, 1000);`,
      ],
      { env: { ...s.env, ADO_NPM_EXEC_TOKEN: validJwt(), FAKE_NPM_WAIT: ready }, stdio: 'ignore' },
    );
    assert.ok(await waitFor(() => fs.existsSync(ready), 20_000), 'fake npm started');
    const binPid = Number(fs.readFileSync(binPidFile, 'utf8'));
    parent.kill('SIGKILL');
    assert.ok(await waitFor(() => gone(binPid), 8000), 'ado-npm-exec exited after its parent died');
    const rec = s.read();
    assert.equal(rec.gotSignal, 'SIGTERM');
    assert.equal(rec.npmrcExistsAtSignal, false);
    assert.deepEqual(s.leftovers(), []);
  } finally {
    s.dispose();
  }
});

test('refuses to run when a file would shadow the package from the feed', () => {
  const s = sandbox();
  try {
    // npm would run <ancestor of the temp dir>/node_modules/.bin/<spec> instead.
    const bin = path.join(s.root, 'tmp', 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'tool@1.0.0'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
    const r = runBin([FEED, 'tool@1.0.0'], { ...s.env, ADO_NPM_EXEC_TOKEN: validJwt() });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /refusing to run: npm would execute .*tool@1\.0\.0/);
    assert.equal(fs.existsSync(s.record), false, 'npm did not run');
    assert.deepEqual(s.leftovers(), []);
  } finally {
    s.dispose();
  }
});

test('refuses a temp directory that other users can write to', { skip: isWin }, () => {
  const s = sandbox();
  try {
    const shared = path.join(s.root, 'shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o1777);
    // HOME is also inside the shared directory, so ~/.cache is not an option either.
    const home = path.join(shared, 'home');
    fs.mkdirSync(home);
    const r = runBin([FEED, 'tool'], { ...s.env, TMPDIR: shared, HOME: home, XDG_RUNTIME_DIR: '', ADO_NPM_EXEC_TOKEN: validJwt() });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no private directory for temporary files/);
    assert.equal(fs.existsSync(s.record), false);
  } finally {
    s.dispose();
  }
});
