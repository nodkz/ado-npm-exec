import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireToken,
  azArgs,
  azureauthArgs,
  azureauthEnv,
  buildHint,
  TokenError,
  AbortedError,
} from '../src/tokens.js';
import { validJwt, TENANT, OTHER_TENANT } from '../fixtures/jwt.js';

/**
 * @typedef {{ file: string, args: readonly string[], env: NodeJS.ProcessEnv }} Call
 * @typedef {Partial<import('../src/proc.js').CaptureResult>} Answer
 */

/**
 * @param {Record<string, Answer | Answer[]>} answers by tool name ('az' | 'azureauth')
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
  const run = async (file, args, { env }) => {
    calls.push({ file, args, env });
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
  return { calls, sleeps, opts: { find, run, sleep, random: () => 0.5 } };
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
  const h = harness({ azureauth: { stdout: `Bearer ${jwt}\r\n` } }, { missing: ['az'] });
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
  assert.deepEqual(azureauthArgs(TENANT), ['ado', 'token', '--output', 'headervalue', '--mode', 'broker', '--timeout', '1', '--tenant', TENANT]);
  assert.deepEqual(call.env, { PATH: '/opt/bin', AZUREAUTH_NO_USER: '1' });
});

test('azureauthEnv strips PAT sources in any letter case', () => {
  assert.deepEqual(azureauthEnv({ Azureauth_Ado_Pat: 'x', System_AccessToken: 'y', tf_build: '1', KEEP: 'k' }), {
    KEEP: 'k',
    AZUREAUTH_NO_USER: '1',
  });
});

test('azureauth Basic (PAT) output is rejected', async () => {
  const h = harness({ azureauth: { stdout: 'Basic OmFiY2RlZmdoaWprbG1ub3A=' } }, { missing: ['az'] });
  await assert.rejects(acquireToken({ env: {}, ...h.opts }), (/** @type {TokenError} */ e) => {
    assert.ok(e instanceof TokenError);
    assert.match(e.attempts[1].reason, /PAT/);
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
    { missing: ['azureauth'] },
  );
  await assert.rejects(acquireToken({ env: {}, tenant: TENANT, ...h.opts }), (/** @type {TokenError} */ e) => {
    assert.equal(h.calls.length, 1);
    assert.match(e.attempts[0].reason, /az login/);
    assert.match(e.hint, new RegExp(`az login --tenant ${TENANT} --allow-no-subscriptions`));
    return true;
  });
});

test('nothing installed: install hint', async () => {
  const h = harness({}, { missing: ['az', 'azureauth'] });
  await assert.rejects(acquireToken({ env: {}, ...h.opts }), /could not acquire/);
  assert.match(buildHint({ attempts: [{ source: 'az', reason: '', notFound: true }, { source: 'azureauth', reason: '', notFound: true }] }), /Install Azure CLI/);
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
