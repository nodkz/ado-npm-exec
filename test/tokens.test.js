import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireToken,
  azArgs,
  azdArgs,
  azureauthArgs,
  azureauthEnv,
  buildHint,
  parseAzdToken,
  TokenError,
  AbortedError,
} from '../src/tokens.js';
import { withTrustedPath } from '../src/proc.js';
import { validJwt, TENANT, OTHER_TENANT } from '../fixtures/jwt.js';

/**
 * @typedef {{ file: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd?: string }} Call
 * @typedef {Partial<import('../src/proc.js').CaptureResult>} Answer
 */

/**
 * @param {Record<string, Answer | Answer[]>} answers by tool name ('az' | 'azd' | 'azureauth')
 * @param {{ missing?: string[] }} [opts]
 */
function harness(answers, { missing = [] } = {}) {
  /** @type {Call[]} */
  const calls = [];
  /** @type {number[]} */
  const sleeps = [];
  /** @type {Record<string, number>} */
  const counts = {};
  const find = (/** @type {string} */ cmd) => (missing.includes(cmd) ? undefined : `/opt/bin/${cmd}`);
  /** @type {import('../src/tokens.js').AcquireOptions['run']} */
  const run = async (file, args, { env, cwd }) => {
    calls.push({ file, args, env, cwd });
    const tool = file.split('/').pop() ?? '';
    const list = answers[tool];
    const i = counts[tool] ?? 0;
    counts[tool] = i + 1;
    const a = Array.isArray(list) ? list[Math.min(i, list.length - 1)] : list;
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, ...a };
  };
  const sleep = async (/** @type {number} */ ms) => {
    sleeps.push(ms);
  };
  return { calls, sleeps, opts: { find, run, sleep, random: () => 0.5, cwd: '/safe', platform: /** @type {NodeJS.Platform} */ ('linux') } };
}

test('ADO_NPM_EXEC_TOKEN wins and no tool runs', async () => {
  const jwt = validJwt();
  const h = harness({});
  const r = await acquireToken({ env: { ADO_NPM_EXEC_TOKEN: ` ${jwt}\n` }, tenant: TENANT, ...h.opts });
  assert.equal(r.source, 'ADO_NPM_EXEC_TOKEN');
  assert.equal(r.token, jwt);
  assert.equal(h.calls.length, 0);
});

test('ADO_NPM_EXEC_TOKEN must be an Entra ID JWT: PATs fail hard', async () => {
  const h = harness({ az: { stdout: validJwt() } });
  await assert.rejects(
    acquireToken({ env: { ADO_NPM_EXEC_TOKEN: 'a'.repeat(52) }, ...h.opts }),
    (/** @type {TokenError} */ e) => e instanceof TokenError && /PATs are not supported/.test(e.message),
  );
  await assert.rejects(
    acquireToken({ env: { ADO_NPM_EXEC_TOKEN: validJwt({ exp: 1 }) }, ...h.opts }),
    /expire/,
  );
  assert.equal(h.calls.length, 0, 'never falls through to az');
});

test('az is tried first with the ADO resource and tenant', async () => {
  const jwt = validJwt();
  const h = harness({ az: { stdout: `${jwt}\n` } });
  const r = await acquireToken({ env: { HOME: '/h' }, tenant: TENANT, ...h.opts });
  assert.equal(r.source, 'az');
  assert.equal(r.token, jwt);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].args, azArgs(TENANT));
  assert.deepEqual(azArgs(TENANT), [
    'account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798',
    '--query', 'accessToken', '--output', 'tsv', '--tenant', TENANT,
  ]);
  assert.deepEqual(azArgs(undefined).includes('--tenant'), false);
  assert.equal(h.calls[0].env.HOME, '/h');
});

test('falls back to azureauth with PAT paths disabled and silent mode forced', async () => {
  const jwt = validJwt();
  const h = harness({ azureauth: { stdout: `Bearer ${jwt}\r\n` } }, { missing: ['az', 'azd'] });
  const env = {
    PATH: '/opt/bin',
    AZUREAUTH_ADO_PAT: 'pat',
    system_accesstoken: 'job-token',
    TF_BUILD: 'True',
    AZUREAUTH_NO_USER: '',
  };
  const r = await acquireToken({ env, tenant: TENANT, ...h.opts });
  assert.equal(r.source, 'azureauth');
  assert.equal(r.token, jwt);
  const call = h.calls[0];
  assert.deepEqual(call.args, azureauthArgs(TENANT));
  assert.deepEqual(azureauthArgs(TENANT), ['ado', 'token', '--output', 'headervalue', '--timeout', '1', '--tenant', TENANT]);
  assert.equal(azureauthArgs(TENANT).includes('--mode'), false, '--mode broker breaks azureauth 0.9.5 and skips the cache in 0.9.6');
  assert.deepEqual(call.env, { PATH: '/opt/bin', AZUREAUTH_NO_USER: '1' });
});

test('azureauthEnv strips PAT sources in any letter case', () => {
  assert.deepEqual(azureauthEnv({ Azureauth_Ado_Pat: 'x', System_AccessToken: 'y', tf_build: '1', KEEP: 'k' }), {
    KEEP: 'k',
    AZUREAUTH_NO_USER: '1',
  });
});

test('azureauth Basic (PAT) output is rejected', async () => {
  const h = harness({ azureauth: { stdout: 'Basic OmFiY2RlZmdoaWprbG1ub3A=' } }, { missing: ['az', 'azd'] });
  await assert.rejects(acquireToken({ env: {}, ...h.opts }), (/** @type {TokenError} */ e) => {
    assert.ok(e instanceof TokenError);
    assert.deepEqual(e.attempts.map((a) => a.source), ['az', 'azd', 'azureauth']);
    assert.match(e.attempts[2].reason, /PAT/);
    return true;
  });
});

test('unusable az tokens fall through to azureauth', async () => {
  for (const bad of [validJwt({ aud: 'https://management.azure.com/' }), validJwt({ tid: OTHER_TENANT }), validJwt({ exp: 5 }), 'garbage']) {
    const good = validJwt();
    const h = harness({ az: { stdout: bad }, azureauth: { stdout: `Bearer ${good}` } });
    const r = await acquireToken({ env: {}, tenant: TENANT, ...h.opts });
    assert.equal(r.source, 'azureauth');
  }
});

test('az timeout falls through without retry', async () => {
  const h = harness({ az: { code: null, timedOut: true }, azureauth: { stdout: `Bearer ${validJwt()}` } });
  const r = await acquireToken({ env: {}, ...h.opts });
  assert.equal(r.source, 'azureauth');
  assert.equal(h.calls.filter((c) => c.file.endsWith('/az')).length, 1);
});

test('a fast non-login az failure is retried once', async () => {
  const jwt = validJwt();
  const h = harness({ az: [{ code: 1, stderr: 'ERROR: Failed to acquire the token cache lock' }, { stdout: jwt }] });
  const r = await acquireToken({ env: {}, ...h.opts });
  assert.equal(r.source, 'az');
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.sleeps, [400]);
});

test('an az login failure is not retried and yields an actionable error', async () => {
  const h = harness(
    { az: { code: 1, stderr: "WARNING: x\nERROR: Please run 'az login' to setup account." } },
    { missing: ['azd', 'azureauth'] },
  );
  await assert.rejects(acquireToken({ env: {}, tenant: TENANT, ...h.opts }), (/** @type {TokenError} */ e) => {
    assert.equal(h.calls.length, 1);
    assert.match(e.attempts[0].reason, /az login/);
    assert.match(e.hint, new RegExp(`az login --tenant ${TENANT} --allow-no-subscriptions`));
    return true;
  });
});

test('nothing installed: install hint', async () => {
  const h = harness({}, { missing: ['az', 'azd', 'azureauth'] });
  await assert.rejects(acquireToken({ env: {}, ...h.opts }), /could not acquire/);
  assert.equal(h.calls.length, 0);
  assert.match(buildHint({ attempts: [{ source: 'az', reason: '', notFound: true }, { source: 'azureauth', reason: '', notFound: true }] }), /^Install the Azure CLI/);
});

test('the hint names the same sign-ins as the notice: --login, az without its subscription prompt, azd', () => {
  const hint = buildHint({ attempts: [{ source: 'az', reason: 'run az login' }], tenant: TENANT });
  assert.match(hint, /ado-npm-exec --login <feed-url>/);
  assert.match(hint, new RegExp(`az login --tenant ${TENANT} --allow-no-subscriptions\` with AZURE_CORE_LOGIN_EXPERIENCE_V2=off`));
  assert.match(hint, new RegExp(`azd auth login --tenant-id ${TENANT}`));
});

test('organizations without Entra ID get a clear hint', () => {
  assert.match(buildHint({ attempts: [], msa: true }), /not connected to Microsoft Entra ID/);
});

test('an aborted acquisition stops immediately', async () => {
  const ac = new AbortController();
  ac.abort();
  const h = harness({ az: { stdout: validJwt() } });
  await assert.rejects(acquireToken({ env: {}, signal: ac.signal, ...h.opts }), AbortedError);
  assert.equal(h.calls.length, 0);
});

test('az and azureauth never see workspace node_modules/.bin on PATH', async () => {
  const h = harness({
    az: { code: 1, stderr: "Please run 'az login'" },
    azd: { code: 1, stderr: 'ERROR: not logged in, run `azd auth login` to login' },
    azureauth: { stdout: `Bearer ${validJwt()}` },
  });
  await acquireToken({ env: { PATH: '/w/node_modules/.bin:/usr/bin' }, ...h.opts });
  assert.deepEqual(h.calls.map((c) => c.env.PATH), ['/usr/bin', '/usr/bin', '/usr/bin']);
  assert.deepEqual(h.calls.map((c) => c.cwd), ['/safe', '/safe', '/safe'], 'tools never run in the workspace');
  assert.deepEqual(withTrustedPath({ PATH: '/a/node_modules/.bin:/b' }, 'linux'), { PATH: '/b' });
});

test('azd: arguments, JSON output and the token checks', async () => {
  assert.deepEqual(azdArgs(TENANT), [
    'auth', 'token', '--output', 'json', '--no-prompt', '--scope', '499b84ac-1321-427f-aa17-267ca6975798/.default', '--tenant-id', TENANT,
  ]);
  assert.equal(azdArgs(undefined).includes('--tenant-id'), false);
  const jwt = validJwt();
  assert.equal(parseAzdToken(JSON.stringify({ token: jwt, expiresOn: '2026-11-03T15:00:00Z' })), jwt);
  assert.equal(parseAzdToken(`WARNING: update available\n${JSON.stringify({ token: jwt })}\n`), jwt);
  assert.equal(parseAzdToken('not json'), undefined);
  assert.equal(parseAzdToken('{"token":42}'), undefined);

  const h = harness({ azd: { stdout: JSON.stringify({ token: jwt, expiresOn: 'x' }) } }, { missing: ['az'] });
  const r = await acquireToken({ env: {}, tenant: TENANT, ...h.opts });
  assert.equal(r.source, 'azd');
  assert.equal(r.token, jwt);
  assert.deepEqual(h.calls[0].args, azdArgs(TENANT));

  const wrongTenant = harness({ azd: { stdout: JSON.stringify({ token: validJwt({ tid: OTHER_TENANT }) }) } }, { missing: ['az', 'azureauth'] });
  await assert.rejects(acquireToken({ env: {}, tenant: TENANT, ...wrongTenant.opts }), (/** @type {TokenError} */ e) => {
    assert.match(e.attempts[1].reason, /tenant/);
    return true;
  });
  const notLoggedIn = harness({ azd: { code: 1, stderr: 'ERROR: not logged in, run `azd auth login` to login' } }, { missing: ['az', 'azureauth'] });
  await assert.rejects(acquireToken({ env: {}, ...notLoggedIn.opts }), (/** @type {TokenError} */ e) => {
    assert.match(e.attempts[1].reason, /not logged in/);
    return true;
  });
});

/**
 * A run() seam whose answers settle on a schedule, with a record of when each
 * tool started, whether it was stopped, and how many ran at the same time.
 *
 * @param {Record<string, { afterMs: number, answer: Answer } | 'hang'>} plan
 */
function timedHarness(plan) {
  const started0 = Date.now();
  /** @type {Record<string, { at: number, signal: AbortSignal | undefined }>} */
  const runs = {};
  let active = 0;
  const peak = { value: 0 };
  /** @type {import('../src/tokens.js').AcquireOptions['run']} */
  const run = (file, _args, { signal }) => {
    const tool = file.split('/').pop() ?? '';
    runs[tool] = { at: Date.now() - started0, signal };
    peak.value = Math.max(peak.value, ++active);
    const step = plan[tool];
    const base = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false };
    return new Promise((resolve) => {
      const done = (/** @type {import('../src/proc.js').CaptureResult} */ r) => {
        active--;
        resolve(r);
      };
      const stop = () => done({ ...base, code: null, aborted: true });
      if (signal?.aborted) return stop();
      signal?.addEventListener('abort', stop, { once: true });
      if (step !== 'hang' && step) setTimeout(() => done({ ...base, ...step.answer }), step.afterMs);
    });
  };
  return { runs, peak, opts: { run, find: (/** @type {string} */ cmd) => `/opt/bin/${cmd}`, sleep: async () => {}, random: () => 0, cwd: '/safe' } };
}

test('one tool at a time: the next starts only when the previous one has no token', async () => {
  const good = validJwt();
  const h = timedHarness({
    az: { afterMs: 40, answer: { code: null, timedOut: true } },
    azd: { afterMs: 5, answer: { stdout: JSON.stringify({ token: good }) } },
    azureauth: 'hang',
  });
  const r = await acquireToken({ env: {}, ...h.opts });
  assert.equal(r.source, 'azd');
  assert.ok(h.runs.azd.at >= 35, `azd started after az gave up (${h.runs.azd.at} ms)`);
  assert.equal(h.runs.azureauth, undefined, 'no third tool once a token arrived');
  assert.equal(h.peak.value, 1, 'never two tools at once');
});

test('a failing tool starts the next one at once', async () => {
  const good = validJwt();
  const h = timedHarness({
    az: { afterMs: 0, answer: { code: 1, stderr: "Please run 'az login'" } },
    azd: { afterMs: 0, answer: { code: 1, stderr: 'not logged in' } },
    azureauth: { afterMs: 0, answer: { stdout: `Bear${'er'} ${good}` } },
  });
  const started = Date.now();
  const r = await acquireToken({ env: {}, ...h.opts });
  assert.equal(r.source, 'azureauth');
  assert.ok(Date.now() - started < 5000);
  assert.equal(h.peak.value, 1);
});

test('the remembered tool runs first and alone, and the one that gave the token is reported', async () => {
  const jwt = validJwt();
  const h = harness({ az: { stdout: validJwt() }, azd: { stdout: JSON.stringify({ token: jwt }) }, azureauth: { stdout: `Bear${'er'} ${jwt}` } });
  /** @type {string[]} */
  const remembered = [];
  const r = await acquireToken({ env: {}, tenant: TENANT, prefer: 'azd', remember: (s) => remembered.push(s), ...h.opts });
  assert.equal(r.source, 'azd');
  assert.equal(r.token, jwt);
  assert.deepEqual(h.calls.map((c) => c.file), ['/opt/bin/azd'], 'az and azureauth never ran');
  assert.deepEqual(remembered, ['azd']);
});

test('when the remembered tool has no token, the others run in order, and the one that works is reported', async () => {
  const jwt = validJwt();
  const h = harness(
    { azureauth: { code: 1, stderr: 'no account' }, az: { code: 1, stderr: "ERROR: Please run 'az login' to setup account." }, azd: { stdout: JSON.stringify({ token: jwt }) } },
  );
  /** @type {string[]} */
  const remembered = [];
  const r = await acquireToken({ env: {}, prefer: 'azureauth', remember: (s) => remembered.push(s), ...h.opts });
  assert.equal(r.source, 'azd');
  assert.deepEqual(h.calls.map((c) => c.file), ['/opt/bin/azureauth', '/opt/bin/az', '/opt/bin/azd']);
  assert.deepEqual(remembered, ['azd']);
});

test('attempts are reported in the order the tools ran; nothing is remembered without a token', async () => {
  const h = harness(
    { az: { code: 1, stderr: "Please run 'az login'" }, azd: { code: 1, stderr: 'not logged in' }, azureauth: { code: 1, stderr: 'no account' } },
  );
  /** @type {string[]} */
  const remembered = [];
  await assert.rejects(acquireToken({ env: {}, prefer: 'azd', remember: (s) => remembered.push(s), ...h.opts }), (/** @type {TokenError} */ e) => {
    assert.ok(e instanceof TokenError);
    assert.deepEqual(e.attempts.map((a) => a.source), ['azd', 'az', 'azureauth']);
    return true;
  });
  assert.deepEqual(remembered, []);
});

test('ADO_NPM_EXEC_TOKEN is not a sign-in tool: nothing is remembered', async () => {
  /** @type {string[]} */
  const remembered = [];
  const h = harness({});
  const r = await acquireToken({ env: { ADO_NPM_EXEC_TOKEN: validJwt() }, prefer: 'azd', remember: (s) => remembered.push(s), ...h.opts });
  assert.equal(r.source, 'ADO_NPM_EXEC_TOKEN');
  assert.deepEqual(remembered, []);
  assert.equal(h.calls.length, 0);
});

test('an unknown remembered tool is ignored, and a failing memory never fails the acquisition', async () => {
  const h = harness({ az: { stdout: validJwt() } });
  const r = await acquireToken({
    env: {},
    prefer: /** @type {any} */ ('pwsh'),
    remember: () => {
      throw new Error('read-only file system');
    },
    ...h.opts,
  });
  assert.equal(r.source, 'az');
  assert.deepEqual(h.calls.map((c) => c.file), ['/opt/bin/az']);
});

test('an abort stops the running tool and starts no other', async () => {
  const h = timedHarness({ az: 'hang', azd: 'hang', azureauth: 'hang' });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(acquireToken({ env: {}, signal: ac.signal, ...h.opts }), AbortedError);
  assert.equal(h.runs.az?.signal?.aborted, true);
  assert.equal(h.runs.azd, undefined);
  assert.equal(h.runs.azureauth, undefined);
});

test('tools run from a neutral directory by default', async () => {
  /** @type {(string | undefined)[]} */
  const cwds = [];
  /** @type {import('../src/tokens.js').AcquireOptions['run']} */
  const run = async (_file, _args, { cwd }) => {
    cwds.push(cwd);
    return { code: 0, signal: null, stdout: validJwt(), stderr: '', timedOut: false, aborted: false };
  };
  await acquireToken({ env: {}, platform: 'linux', run, find: () => '/opt/bin/az' });
  await acquireToken({ env: { SystemRoot: 'D:\\Win' }, platform: 'win32', run, find: () => 'C:\\az\\az.cmd' });
  assert.ok(cwds[0] === '/bin' || cwds[0] === '/', `linux: ${cwds[0]}`);
  assert.equal(cwds[1], 'D:\\Win');
});
