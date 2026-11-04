// The actions: --doctor, --login and --prewarm, driven through their seams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/args.js';
import { runDoctor } from '../src/doctor.js';
import { createLogger } from '../src/log.js';
import { loginArgs, runLogin } from '../src/login.js';
import { readNpxInstall } from '../src/npm-cache.js';
import { safeWorkingDir } from '../src/proc.js';
import { runPrewarm } from '../src/prewarm.js';
import { validateRegistryUrl } from '../src/registry.js';
import { readState, signInMemory, stateDir, stateKey } from '../src/state.js';
import { acquireToken, TokenError } from '../src/tokens.js';
import { validJwt, TENANT, OTHER_TENANT } from '../fixtures/jwt.js';
import { seedNpxInstall, seedPackument } from '../fixtures/npm-cache.js';
import { fakeFetch } from '../fixtures/fake-fetch.js';
import { installFakeTools, makeTestRoot, readToolLog, runNode } from '../fixtures/sandbox.js';

const FEED = 'https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/';
const registry = validateRegistryUrl(FEED);
const name = '@contoso/tool';
const isWin = process.platform === 'win32';
const npm = { node: process.execPath, cli: '/fake/npm/bin/npm-cli.js' };
const BIN = fileURLToPath(new URL('../bin/ado-npm-exec.js', import.meta.url));
const RUN_MAIN = fileURLToPath(new URL('../fixtures/run-main.js', import.meta.url));
const DOCTOR_TENANT = '11111111-2222-3333-4444-555555555555';

function capture() {
  /** @type {string[]} */
  const out = [];
  return { out, write: (/** @type {string} */ s) => void out.push(s), text: () => out.join('') };
}

/**
 * A machine with a stand-in az that gives `azToken` (none: no sign-in).
 *
 * @param {string} root
 * @param {string} [azToken]
 */
function doctorEnv(root, azToken) {
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  const azDir = installFakeTools(path.join(root, 'az-bin'), ['az']);
  for (const d of [home, tmp]) fs.mkdirSync(d, { recursive: true });
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    PATH: `${azDir}${path.delimiter}${path.dirname(process.execPath)}`,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    npm_config_cache: path.join(root, 'npm-cache'),
    ...(azToken ? { FAKE_AZ_TOKEN: azToken } : {}),
    ...(isWin ? { SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT } : {}),
  };
  return { env, azDir, cache: path.join(root, 'npm-cache') };
}

test('doctor: a healthy setup, every source on its own, and never a token', async () => {
  const root = makeTestRoot('doctor-');
  try {
    const token = validJwt({ upn: 'dev@contoso.com' });
    const { env, cache } = doctorEnv(root, token);
    seedNpxInstall(cache, { spec: `${name}@1.2.3`, name, version: '1.2.3' });
    seedPackument(cache, FEED, name);
    signInMemory(stateDir(cache), DOCTOR_TENANT).remember?.('az');
    const tarball = `${FEED}@contoso/tool/-/tool-1.2.3.tgz`;
    const out = capture();
    const code = await runDoctor({
      parsed: parseArgs(['--doctor', FEED, `${name}@1.2.3`]),
      tenant: undefined,
      env,
      platform: process.platform,
      write: out.write,
      validateRegistry: validateRegistryUrl,
      discover: async () => ({ tenant: DOCTOR_TENANT }),
      acquire: acquireToken,
      resolve: async () => ({ kind: 'resolved', version: '1.2.3', via: 'exact' }),
      findNpm: () => npm,
      now: Date.now,
      fetchImpl: fakeFetch({
        [`${FEED}@contoso%2ftool`]: () => new Response(JSON.stringify({ versions: { '1.2.3': { dist: { tarball } } } }), { status: 200 }),
        [tarball]: () => new Response(null, { status: 303, headers: { location: 'https://blob.example.vsassets.io/x' } }),
        'https://blob.example.vsassets.io/x': () => new Response('x', { status: 206 }),
      }).impl,
    });
    const text = out.text();
    assert.equal(code, 0, text);
    assert.equal(text.includes(token), false, 'the token is never printed');
    assert.match(text, /0 errors/);
    assert.match(text, /az: token \(dev@contoso\.com, tenant 11111111-2222-3333-4444-555555555555, expires in \d+ min\)/);
    assert.match(text, /azd: Azure Developer CLI \(azd\) was not found on PATH/);
    assert.match(text, /remembered sign-in tool for tenant 11111111-2222-3333-4444-555555555555: az \(a start runs it first, alone/);
    assert.match(text, /download: pkgs\.dev\.azure\.com HTTP 303 -> blob\.example\.vsassets\.io HTTP 206/);
    assert.match(text, /@contoso\/tool@1\.2\.3: installed/);
    assert.match(text, /next start: @contoso\/tool@1\.2\.3 from npm's cache, no token and no network/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: findings name the problems and the exit code is 1', async () => {
  const root = makeTestRoot('doctor-');
  try {
    const { env } = doctorEnv(root, validJwt({ tid: OTHER_TENANT }));
    const out = capture();
    const code = await runDoctor({
      parsed: parseArgs(['--doctor', FEED, `${name}@latest`]),
      tenant: TENANT,
      env: { ...env, HTTPS_PROXY: 'http://user:secret@proxy.example:8080', npm_config_https_proxy: 'http://user:secret@proxy.example:8080', npm_config_replace_registry_host: 'never' },
      platform: process.platform,
      write: out.write,
      validateRegistry: validateRegistryUrl,
      discover: async () => ({}),
      acquire: acquireToken,
      resolve: async () => ({ kind: 'refused', status: 403, detail: 'HTTP 403: denied' }),
      findNpm: () => undefined,
      now: Date.now,
    });
    const text = out.text();
    assert.equal(code, 1);
    assert.match(text, /\[error\] npm's npm-cli\.js was not found/);
    assert.match(text, /\[error\] No token source works/, 'az has a token, but for another tenant');
    assert.match(text, new RegExp(`remembered sign-in tool for tenant ${TENANT}: none yet \\(a start tries az, azd and azureauth, one at a time\\)`));
    assert.match(text, /\[warn\] A proxy is configured/);
    assert.match(text, /\[info\] replace-registry-host=never is inherited/);
    assert.equal(text.includes('secret'), false, 'proxy credentials are not printed');
    assert.match(text, /<credentials>@proxy\.example/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: without a feed it still reports the machine', async () => {
  const root = makeTestRoot('doctor-');
  try {
    const { env } = doctorEnv(root);
    const out = capture();
    const code = await runDoctor({
      parsed: parseArgs(['--doctor']),
      tenant: undefined,
      env,
      platform: process.platform,
      write: out.write,
      validateRegistry: validateRegistryUrl,
      discover: async () => ({}),
      acquire: async () => {
        throw new TokenError('none', { attempts: [{ source: 'az', reason: 'not found', notFound: true }] });
      },
      resolve: async () => ({ kind: 'unsupported', detail: '' }),
      findNpm: () => npm,
      now: Date.now,
    });
    assert.equal(code, 1, 'no token source works');
    assert.match(out.text(), /\[info\] Give the feed URL and a package spec/);
    assert.match(out.text(), /^Runtime$/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A fake child process for the sign-in tool. @param {number} code */
function fakeChild(code) {
  const child = new EventEmitter();
  setImmediate(() => child.emit('exit', code, null));
  return child;
}

/**
 * @param {{ tools?: string[], exit?: number, acquire?: import('../src/login.js').LoginOptions['acquire'], tty?: boolean,
 *   discover?: import('../src/login.js').LoginOptions['discover'], tenant?: string, dir?: string, env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform, find?: (cmd: string) => string | undefined, child?: () => EventEmitter }} [over]
 */
function loginHarness(over = {}) {
  const err = capture();
  /** @type {{ command: string, args: string[], options: any }[]} */
  const spawned = [];
  /** The silent token checks after the sign-in. @type {import('../src/tokens.js').AcquireOptions[]} */
  const checks = [];
  const opts = {
    registry,
    tenant: over.tenant,
    env: over.env ?? { PATH: '/usr/bin', SystemRoot: 'C:\\Windows' },
    platform: over.platform ?? /** @type {NodeJS.Platform} */ ('linux'),
    log: createLogger({ write: err.write }),
    noticeStream: { write: err.write, isTTY: false },
    discover: over.discover ?? (async () => ({ tenant: TENANT })),
    acquire:
      over.acquire ??
      (async (/** @type {import('../src/tokens.js').AcquireOptions} */ o) => {
        checks.push(o);
        const source = o.prefer ?? 'az';
        o.remember?.(source);
        return { token: validJwt(), source, claims: { tid: TENANT, upn: 'dev@contoso.com' } };
      }),
    ...(over.dir ? { dir: over.dir } : {}),
    stdinIsTTY: over.tty ?? true,
    stderrIsTTY: over.tty ?? true,
    find: over.find ?? ((/** @type {string} */ cmd) => ((over.tools ?? ['az']).includes(cmd) ? `/opt/bin/${cmd}` : undefined)),
    spawnImpl: (/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ options) => {
      spawned.push({ command, args, options });
      return /** @type {any} */ (over.child ? over.child() : fakeChild(over.exit ?? 0));
    },
  };
  return { opts, err, spawned, checks };
}

test('login: az login for the feed\'s tenant without the subscription picker, then a silent token', async () => {
  const h = loginHarness();
  const code = await runLogin(h.opts);
  assert.equal(code, 0, h.err.text());
  assert.equal(h.spawned.length, 1);
  const [{ command, args, options }] = h.spawned;
  assert.equal(command, '/opt/bin/az');
  assert.deepEqual(args, ['login', '--tenant', TENANT, '--allow-no-subscriptions']);
  assert.equal(options.env.AZURE_CORE_LOGIN_EXPERIENCE_V2, 'off');
  assert.deepEqual(options.stdio, ['inherit', 2, 'inherit'], "az's stdout goes to our stderr");
  assert.equal(options.cwd, safeWorkingDir('linux', {}), 'never the workspace');
  assert.match(h.err.text(), /signed in as dev@contoso\.com/);
  assert.deepEqual(loginArgs({ tool: 'azd', tenant: TENANT }), ['auth', 'login', '--tenant-id', TENANT]);
});

test('login: azd when az is missing; a notice when neither is installed', async () => {
  const azd = loginHarness({ tools: ['azd'] });
  assert.equal(await runLogin(azd.opts), 0);
  assert.deepEqual(azd.spawned[0].args, ['auth', 'login', '--tenant-id', TENANT]);
  assert.equal(azd.spawned[0].options.env.AZURE_CORE_LOGIN_EXPERIENCE_V2, undefined);
  const none = loginHarness({ tools: [] });
  assert.equal(await runLogin(none.opts), 3);
  assert.match(none.err.text(), /Sign-in needed/);
  assert.equal(none.spawned.length, 0);
});

test('login: refuses without a terminal, and reports a failed or useless sign-in', async () => {
  const noTty = loginHarness({ tty: false });
  assert.equal(await runLogin(noTty.opts), 2);
  assert.match(noTty.err.text(), /needs a terminal/);
  assert.equal(noTty.spawned.length, 0);

  const failed = loginHarness({ exit: 1 });
  assert.equal(await runLogin(failed.opts), 3);
  assert.match(failed.err.text(), /did not finish/);

  const useless = loginHarness({
    acquire: async () => {
      throw new TokenError('could not acquire a token.', { attempts: [{ source: 'az', reason: 'wrong tenant' }] });
    },
  });
  assert.equal(await runLogin(useless.opts), 3);
  assert.match(useless.err.text(), /still no usable token/);

  const msa = loginHarness({ discover: async () => ({ msa: true }) });
  assert.equal(await runLogin(msa.opts), 3);
  assert.match(msa.err.text(), /not connected to Microsoft Entra ID/);
});

test('login: the token check runs the tool that just signed in first, and the next start reuses it', async () => {
  const root = makeTestRoot('login-');
  try {
    const dir = stateDir(root);
    signInMemory(dir, TENANT).remember?.('azureauth');
    const az = loginHarness({ dir });
    assert.equal(await runLogin(az.opts), 0, az.err.text());
    assert.equal(az.checks.length, 1);
    assert.equal(az.checks[0].prefer, 'az');
    assert.equal(az.checks[0].tenant, TENANT);
    assert.equal(signInMemory(dir, TENANT).prefer, 'az');
    assert.match(az.err.text(), /\): az now gives a token silently\. Restart the server/);

    const azd = loginHarness({ dir, tools: ['azd'] });
    assert.equal(await runLogin(azd.opts), 0, azd.err.text());
    assert.equal(azd.checks[0].prefer, 'azd');
    assert.equal(signInMemory(dir, TENANT).prefer, 'azd');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('login: --tenant skips discovery; a failed discovery signs in to the home tenant', async () => {
  const given = loginHarness({
    tenant: OTHER_TENANT,
    discover: async () => {
      throw new Error('must not ask the feed');
    },
  });
  assert.equal(await runLogin(given.opts), 0, given.err.text());
  assert.deepEqual(given.spawned[0].args, ['login', '--tenant', OTHER_TENANT, '--allow-no-subscriptions']);
  assert.equal(given.checks[0].tenant, OTHER_TENANT);

  const unknown = loginHarness({ discover: async () => ({ error: 'getaddrinfo ENOTFOUND pkgs.dev.azure.com' }) });
  assert.equal(await runLogin(unknown.opts), 0, unknown.err.text());
  assert.deepEqual(unknown.spawned[0].args, ['login', '--allow-no-subscriptions']);
  assert.equal(unknown.checks[0].tenant, undefined);
  assert.match(unknown.err.text(), /could not discover the feed's tenant \(getaddrinfo ENOTFOUND pkgs\.dev\.azure\.com\); signing in to your home tenant/);
});

test('login: a tool that cannot start, or that a signal stops, is a failed sign-in without a token check', async () => {
  const cannotStart = loginHarness({
    child: () => {
      const c = new EventEmitter();
      setImmediate(() => c.emit('error', new Error('spawn /opt/bin/az EACCES')));
      return c;
    },
  });
  assert.equal(await runLogin(cannotStart.opts), 3);
  assert.match(cannotStart.err.text(), /could not start az: spawn \/opt\/bin\/az EACCES/);
  assert.equal(cannotStart.checks.length, 0);

  const interrupted = loginHarness({
    child: () => {
      const c = new EventEmitter();
      setImmediate(() => c.emit('exit', null, 'SIGINT'));
      return c;
    },
  });
  assert.equal(await runLogin(interrupted.opts), 3);
  assert.match(interrupted.err.text(), /az sign-in did not finish/);
  assert.equal(interrupted.checks.length, 0);
});

test('login: on Windows az.cmd runs through cmd.exe with a checked command line', async () => {
  const env = { Path: 'C:\\Windows\\system32', SystemRoot: 'D:\\Win' };
  const h = loginHarness({ platform: 'win32', env, find: (cmd) => (cmd === 'az' ? 'C:\\Program Files\\Azure CLI\\wbin\\az.cmd' : undefined) });
  assert.equal(await runLogin(h.opts), 0, h.err.text());
  const [{ command, args, options }] = h.spawned;
  assert.equal(command, `"C:\\Program Files\\Azure CLI\\wbin\\az.cmd" login --tenant ${TENANT} --allow-no-subscriptions`);
  assert.deepEqual(args, []);
  assert.equal(options.shell, true);
  assert.equal(options.cwd, 'D:\\Win', 'from %SystemRoot%, never the workspace');

  const unsafe = loginHarness({ platform: 'win32', env, find: (cmd) => (cmd === 'az' ? 'C:\\100%\\az.cmd' : undefined) });
  assert.equal(await runLogin(unsafe.opts), 3);
  assert.match(unsafe.err.text(), /refusing to run C:\\100%\\az\.cmd through cmd\.exe/);
  assert.equal(unsafe.spawned.length, 0);
});

test('login: the tool never sees workspace bins on PATH, and ADO_NPM_EXEC_TOKEN cannot stand in for the sign-in', async () => {
  const h = loginHarness({ env: { PATH: '/w/node_modules/.bin:/usr/bin', ado_npm_exec_token: validJwt() } });
  assert.equal(await runLogin(h.opts), 0, h.err.text());
  assert.equal(h.spawned[0].options.env.PATH, '/usr/bin');
  assert.equal(
    Object.keys(h.checks[0].env).some((k) => k.toLowerCase() === 'ado_npm_exec_token'),
    false,
    'the check asks the tools, not the variable',
  );
  assert.match(h.err.text(), /ADO_NPM_EXEC_TOKEN is set, and it takes precedence over this sign-in/);
});

/** A machine with a stand-in az, and a workspace that plants its own az first on PATH. @param {string} root */
function loginSandbox(root) {
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  for (const d of [home, tmp]) fs.mkdirSync(d, { recursive: true });
  const tools = installFakeTools(path.join(root, 'tools'), ['az']);
  const planted = installFakeTools(path.join(root, 'ws', 'node_modules', '.bin'), ['az'], { label: 'planted' });
  const log = path.join(root, 'tools.log');
  const cache = path.join(root, 'npm-cache');
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    PATH: [planted, tools, path.dirname(process.execPath)].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    npm_config_cache: cache,
    FAKE_TOOL_LOG: log,
    FAKE_AZ_TOKEN: validJwt({ upn: 'dev@contoso.com' }),
    TEST_REGISTRY_HREF: 'http://127.0.0.1:9/feed/',
    ...(isWin ? { SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT, ComSpec: process.env.ComSpec } : {}),
  };
  return { env, log, cache, planted };
}

/** @param {string} a @param {string} b */
function sameDir(a, b) {
  /** @param {string} p */
  const real = (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return p;
    }
  };
  return isWin ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b);
}

test('login, end to end: the sign-in tool reads our stdin, its stdout goes to our stderr, and the next start reuses it', async () => {
  const root = makeTestRoot('login-');
  try {
    const s = loginSandbox(root);
    const r = await runNode([RUN_MAIN, '--login', '--tenant', TENANT, 'ignored'], { ...s.env, TEST_TTY: '1' }, { input: 'y\n' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', 'nothing on stdout, although the tool printed there');
    assert.match(r.stderr, /FAKE SUBSCRIPTION LIST/, "the tool's stdout went to our stderr");
    assert.match(r.stderr, /fake az login read "y\\n" from stdin/, 'the tool read our stdin');
    assert.match(r.stderr, /signed in as dev@contoso\.com \(tenant [0-9a-f-]+\): az now gives a token silently/);
    const calls = readToolLog(s.log);
    assert.deepEqual(
      calls.map((c) => `${c.label} ${c.args[0]}`),
      ['tool login', 'tool account'],
      'the sign-in, then the silent token check; the planted az never ran',
    );
    assert.deepEqual(calls[0].args, ['login', '--tenant', TENANT, '--allow-no-subscriptions']);
    assert.equal(calls[0].env.AZURE_CORE_LOGIN_EXPERIENCE_V2, 'off', 'no subscription picker');
    assert.ok(sameDir(calls[0].cwd, safeWorkingDir(process.platform, s.env)), `ran in ${calls[0].cwd}`);
    const seenPath = calls[0].env.PATH ?? calls[0].env.Path ?? '';
    assert.equal(seenPath.split(path.delimiter).includes(s.planted), false, 'workspace bins are not on its PATH');
    assert.equal(signInMemory(stateDir(s.cache), TENANT).prefer, 'az', 'remembered for the next start');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('login, end to end: a failed sign-in exits 3 without a token check, and without a terminal nothing runs', async () => {
  const root = makeTestRoot('login-');
  try {
    const s = loginSandbox(root);
    const failed = await runNode([RUN_MAIN, '--login', '--tenant', TENANT, 'ignored'], { ...s.env, TEST_TTY: '1', FAKE_LOGIN_EXIT: '1' }, { input: 'n\n' });
    assert.equal(failed.status, 3, failed.stderr);
    assert.match(failed.stderr, /az sign-in did not finish \(exit code 1\)/);
    assert.deepEqual(readToolLog(s.log).map((c) => c.args[0]), ['login'], 'no token check after a failed sign-in');
    assert.equal(signInMemory(stateDir(s.cache), TENANT).prefer, undefined);

    fs.rmSync(s.log, { force: true });
    // The published entry point; stdin is a pipe here, not a terminal.
    const noTerminal = await runNode([BIN, '--login', '--tenant', TENANT, FEED], s.env, { input: 'y\n' });
    assert.equal(noTerminal.status, 2, noTerminal.stderr);
    assert.match(noTerminal.stderr, /needs a terminal/);
    assert.equal(noTerminal.stdout, '');
    assert.deepEqual(readToolLog(s.log), [], 'no tool ran');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: what an exact version skips, proxy credentials, replaced values, certificate checks and odd records', async () => {
  const root = makeTestRoot('doctor-');
  try {
    const { env, cache } = doctorEnv(root);
    const key = stateKey(FEED, `${name}@1.2.3`);
    fs.mkdirSync(path.join(stateDir(cache), 'specs'), { recursive: true });
    const record = { v: 1, registry: FEED, spec: `${name}@1.2.3`, name, failures: 1, nextCheckAt: 9e15, missingAt: Date.now() - 60_000 };
    fs.writeFileSync(path.join(stateDir(cache), 'specs', `${key}.json`), JSON.stringify(record));
    /** @param {number} status */
    const doctorWith = async (status) => {
      const out = capture();
      const code = await runDoctor({
        parsed: parseArgs(['--doctor', FEED, `${name}@1.2.3`]),
        tenant: TENANT,
        env: {
          ...env,
          ADO_NPM_EXEC_TOKEN: validJwt(),
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
          npm_config_https_proxy: 'http://alice:p@ss@proxy.example:8080',
          npm_config_userconfig: '/home/u/.npmrc',
        },
        platform: process.platform,
        write: out.write,
        validateRegistry: validateRegistryUrl,
        discover: async () => ({}),
        acquire: async () => {
          throw new TokenError('none', { attempts: [] });
        },
        resolve: async () => ({ kind: 'resolved', version: '1.2.3', via: 'exact' }),
        findNpm: () => npm,
        now: Date.now,
        fetchImpl: fakeFetch({ [`${FEED}@contoso%2ftool`]: () => new Response('{"message":"no"}', { status }) }).impl,
      });
      return { code, text: out.text() };
    };
    const missing = await doctorWith(404);
    assert.equal(missing.code, 1);
    assert.match(missing.text, /\[error\] @contoso\/tool is not on the feed or its upstream sources \(HTTP 404/, 'an exact version is not looked up before npm runs');
    assert.match(missing.text, /\[warn\] NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks/);
    assert.match(missing.text, /\[warn\] The feed had no version for @contoso\/tool@1\.2\.3 at the last check/);
    assert.match(missing.text, /kept npm_config_https_proxy=http:\/\/<credentials>@proxy\.example:8080/);
    assert.equal(missing.text.includes('alice') || missing.text.includes('ss@proxy'), false, 'no part of the password');
    assert.match(missing.text, /replaced npm_config_userconfig: \/home\/u\/\.npmrc -> /);
    assert.match(missing.text, /review it before you share it/);
    assert.match(missing.text, /next start: asks the feed/);
    const refused = await doctorWith(401);
    assert.match(refused.text, /\[error\] The feed refused the token \(HTTP 401/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * @param {string} root
 * @param {{ resolve?: import('../src/prewarm.js').PrewarmOptions['resolve'], acquire?: import('../src/prewarm.js').PrewarmOptions['acquire'], failInstall?: string }} [over]
 *   failInstall: npm's stderr when an install fails
 */
function prewarmHarness(root, over = {}) {
  const cacheDir = path.join(root, 'npm-cache');
  const baseDir = path.join(root, 'tmp');
  fs.mkdirSync(baseDir, { recursive: true });
  const err = capture();
  /** @type {string[]} */
  const installed = [];
  /** @type {import('../src/proc.js').runCapture} */
  const run = async (_file, args, { cwd }) => {
    const ok = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false };
    // npm picks the version of a dist-tag it alone can reach.
    if (args[1] === 'view') return { ...ok, stdout: '9.9.9\n' };
    if (args[1] === 'install') {
      // npm picks the version of a spec it alone can decide.
      fs.writeFileSync(path.join(/** @type {string} */ (cwd), 'package-lock.json'), JSON.stringify({ packages: { [`node_modules/${name}`]: { version: '9.9.9' } } }));
      return ok;
    }
    const spec = args.find((a) => a.startsWith('--package='))?.slice('--package='.length) ?? '';
    if (over.failInstall) return { ...ok, code: 1, stderr: over.failInstall };
    installed.push(spec);
    const at = spec.lastIndexOf('@');
    seedNpxInstall(cacheDir, { spec, name, version: spec.slice(at + 1) });
    seedPackument(cacheDir, FEED, name);
    return ok;
  };
  /** @param {string} raw */
  const spec = (raw) => {
    const at = raw.lastIndexOf('@');
    return { raw, name, scope: 'contoso', range: at > 0 ? raw.slice(at + 1) : undefined };
  };
  const opts = {
    registry,
    specs: [spec(`${name}@latest`)],
    tenant: TENANT,
    npm,
    npmVersion: '11.0.0',
    baseDir,
    cacheDir,
    env: {},
    platform: process.platform,
    log: createLogger({ write: err.write }),
    noticeStream: { write: err.write, isTTY: false },
    discover: async () => ({}),
    acquire: over.acquire ?? (async () => ({ token: validJwt(), source: /** @type {const} */ ('az'), claims: {} })),
    resolve: over.resolve ?? (async () => ({ kind: /** @type {const} */ ('resolved'), version: '1.4.0', via: /** @type {const} */ ('dist-tags') })),
    now: () => 42,
    tokenTimeoutMs: 1000,
    run,
    signals: /** @type {Pick<NodeJS.Process, 'on' | 'off'>} */ (/** @type {unknown} */ (new EventEmitter())),
  };
  return { opts, err, installed, cacheDir, spec };
}

test('prewarm: installs the resolved version and records it for the next start', async () => {
  const root = makeTestRoot('prewarm-');
  try {
    const h = prewarmHarness(root);
    const code = await runPrewarm(h.opts);
    assert.equal(code, 0, h.err.text());
    assert.deepEqual(h.installed, [`${name}@1.4.0`]);
    assert.equal(readNpxInstall(h.cacheDir, `${name}@1.4.0`, name).complete, true);
    const state = readState(stateDir(h.cacheDir), stateKey(FEED, `${name}@latest`));
    assert.equal(state?.version, '1.4.0');
    assert.equal(state?.usedAt, 42);
    assert.match(h.err.text(), /installed @contoso\/tool@1\.4\.0/);
    assert.deepEqual(fs.readdirSync(h.opts.baseDir), [], 'no token file left');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prewarm: npm picks the version of a spec only it can decide; failures set the exit code', async () => {
  const root = makeTestRoot('prewarm-');
  try {
    /** @type {Record<string, import('../src/resolve.js').Resolution>} */
    const answers = {
      [`${name}@odd`]: { kind: 'unsupported', detail: 'x' },
      [`${name}@gone`]: { kind: 'not-found', status: 404, detail: 'HTTP 404' },
      [`${name}@locked`]: { kind: 'refused', status: 403, detail: 'HTTP 403' },
    };
    const h = prewarmHarness(root, { resolve: async ({ spec }) => answers[spec.raw] });
    h.opts.specs = [h.spec(`${name}@odd`), h.spec(`${name}@gone`), h.spec(`${name}@locked`)];
    const code = await runPrewarm(h.opts);
    assert.equal(code, 5, 'the first failure decides');
    assert.deepEqual(h.installed, [`${name}@9.9.9`], 'the exact version npm picked, never the spec as written');
    assert.match(h.err.text(), /@contoso\/tool@gone is not on .* or its upstream sources \(HTTP 404\)/);
    assert.match(h.err.text(), /Sign-in refused/);

    const noToken = prewarmHarness(root, {
      acquire: async () => {
        throw new TokenError('no', { attempts: [{ source: 'az', reason: 'run az login' }] });
      },
    });
    assert.equal(await runPrewarm(noToken.opts), 3);
    assert.match(noToken.err.text(), /Sign-in needed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prewarm: reuses the remembered sign-in tool, and remembers the one that gave the token', async () => {
  const root = makeTestRoot('prewarm-');
  try {
    /** @type {(string | undefined)[]} */
    const preferred = [];
    const h = prewarmHarness(root, {
      acquire: async (o) => {
        preferred.push(o.prefer);
        o.remember?.('azd');
        return { token: validJwt(), source: 'azd', claims: {} };
      },
    });
    signInMemory(stateDir(h.cacheDir), TENANT).remember?.('azureauth');
    assert.equal(await runPrewarm(h.opts), 0, h.err.text());
    assert.deepEqual(preferred, ['azureauth']);
    assert.equal(signInMemory(stateDir(h.cacheDir), TENANT).prefer, 'azd');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prewarm: behind a proxy npm picks the version; npm errors keep their exit codes', async () => {
  const root = makeTestRoot('prewarm-');
  try {
    const proxied = prewarmHarness(root, { resolve: async () => ({ kind: 'unavailable', detail: 'fetch failed' }) });
    proxied.opts.env = { HTTPS_PROXY: 'http://proxy.example:8080' };
    assert.equal(await runPrewarm(proxied.opts), 0, proxied.err.text());
    assert.deepEqual(proxied.installed, [`${name}@9.9.9`]);
    assert.equal(readState(stateDir(proxied.cacheDir), stateKey(FEED, `${name}@latest`))?.version, '9.9.9');

    const unreachable = prewarmHarness(root, { resolve: async () => ({ kind: 'unavailable', detail: 'fetch failed' }) });
    assert.equal(await runPrewarm(unreachable.opts), 1, 'no proxy: the feed is down');
    assert.deepEqual(unreachable.installed, []);

    const gone = prewarmHarness(root, { failInstall: 'npm error code E404\nnpm error 404 Not Found - GET https://feed/@contoso%2ftool' });
    assert.equal(await runPrewarm(gone.opts), 5, gone.err.text());
    assert.match(gone.err.text(), /npm error code E404/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prewarm: a signal stops it with 128 + the signal number', async () => {
  const root = makeTestRoot('prewarm-');
  try {
    const signals = new EventEmitter();
    const h = prewarmHarness(root, {
      acquire: async (o) => {
        signals.emit('SIGTERM', 'SIGTERM');
        await new Promise((resolve) => (o.signal?.aborted ? resolve(undefined) : o.signal?.addEventListener('abort', resolve, { once: true })));
        throw new (await import('../src/tokens.js')).AbortedError('stopped');
      },
    });
    h.opts.signals = /** @type {Pick<NodeJS.Process, 'on' | 'off'>} */ (/** @type {unknown} */ (signals));
    assert.equal(await runPrewarm(h.opts), 143);
    assert.equal(signals.listenerCount('SIGTERM'), 0, 'handlers removed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prewarm: a copy that failed at start is installed again, and only then the mark is cleared', async () => {
  const root = makeTestRoot('prewarm-');
  try {
    const h = prewarmHarness(root);
    const dir = stateDir(h.cacheDir);
    const key = stateKey(FEED, `${name}@latest`);
    seedNpxInstall(h.cacheDir, { spec: `${name}@1.4.0`, name, version: '1.4.0' });
    seedPackument(h.cacheDir, FEED, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'specs', `${key}.json`), JSON.stringify({ v: 1, registry: FEED, spec: `${name}@latest`, name, version: '1.4.0', offlineFailedAt: 7 }));
    assert.equal(await runPrewarm(h.opts), 0, h.err.text());
    assert.deepEqual(h.installed, [`${name}@1.4.0`], 'installed again');
    assert.equal(readState(dir, key)?.offlineFailedAt, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
