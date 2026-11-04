// Background updates of a start from npm's cache: one check, its records,
// and the schedule of checks over a long session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readNpxInstall } from '../src/npm-cache.js';
import { validateRegistryUrl } from '../src/registry.js';
import { readState, signInMemory, stateDir, stateKey, tenantMemory, writeState } from '../src/state.js';
import { TokenError } from '../src/tokens.js';
import {
  backoffMs,
  checkDueIn,
  checkForUpdate,
  CHECK_IN_FLIGHT_MS,
  isCheckDue,
  MAX_BACKOFF_MS,
  startUpdates,
  START_CHECK_GAP_MS,
  waitForSteadyRun,
} from '../src/update.js';
import { fakeNpmRun } from '../fixtures/fake-npm-run.js';
import { validJwt, TENANT } from '../fixtures/jwt.js';
import { seedNpxInstall, seedPackument } from '../fixtures/npm-cache.js';
import { makeTestRoot } from '../fixtures/sandbox.js';

const FEED = 'https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/';
const registry = validateRegistryUrl(FEED);
const name = '@contoso/tool';
const npm = { node: process.execPath, cli: '/fake/npm-cli.js' };

test('isCheckDue, checkDueIn and the back-off schedule', () => {
  const now = 10 * START_CHECK_GAP_MS;
  assert.equal(isCheckDue(undefined, now), true);
  const base = { v: /** @type {1} */ (1), registry: FEED, spec: name, name };
  assert.equal(isCheckDue(base, now), true);
  assert.equal(isCheckDue({ ...base, checkedAt: now - 1000 }, now), false);
  assert.equal(checkDueIn({ ...base, checkedAt: now - 1000 }, now), START_CHECK_GAP_MS - 1000);
  assert.equal(isCheckDue({ ...base, checkedAt: now - START_CHECK_GAP_MS }, now), true);
  assert.equal(isCheckDue({ ...base, nextCheckAt: now + 1 }, now), false, 'backing off');
  assert.equal(checkDueIn({ ...base, nextCheckAt: now + 5 }, now), 5);
  assert.equal(isCheckDue({ ...base, checkStartedAt: now - 1000 }, now), false, 'another process is checking');
  assert.equal(isCheckDue({ ...base, checkStartedAt: now - CHECK_IN_FLIGHT_MS }, now), true);
  assert.equal(checkDueIn({ ...base, checkedAt: now - 1000 }, now, 6 * START_CHECK_GAP_MS), 6 * START_CHECK_GAP_MS - 1000, 'with the periodic gap');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 99].map(backoffMs), [1, 2, 4, 8, 16, 24, 24].map((h) => h * 3_600_000));
  assert.equal(backoffMs(99), MAX_BACKOFF_MS);
});

/**
 * @param {{ resolve?: import('../src/update.js').UpdateContext['resolve'], acquire?: import('../src/update.js').UpdateContext['acquire'],
 *   run?: import('../src/proc.js').runCapture, range?: string }} [over]
 */
function context(over = {}) {
  const root = makeTestRoot('update-');
  const cacheDir = path.join(root, 'npm-cache');
  const baseDir = path.join(root, 'tmp');
  fs.mkdirSync(baseDir, { recursive: true });
  const range = over.range ?? 'latest';
  const spec = { raw: `${name}@${range}`, name, scope: 'contoso', range };
  let clock = 1_000_000;
  /** @type {import('../src/update.js').UpdateContext} */
  const ctx = {
    registry,
    spec,
    cacheDir,
    dir: stateDir(cacheDir),
    key: stateKey(FEED, spec.raw),
    npm,
    baseDir,
    env: {},
    platform: process.platform,
    tenant: TENANT,
    tokenTimeoutMs: 1000,
    temps: new Set(),
    acquire: over.acquire ?? (async () => ({ token: validJwt(), source: 'az', claims: {} })),
    discover: async () => ({}),
    resolve: over.resolve ?? (async () => ({ kind: 'resolved', version: '1.3.0', via: 'dist-tags' })),
    run: over.run ?? fakeNpmRun(cacheDir).run,
    now: () => clock,
    log: { verbose: false, error: () => {}, info: () => {}, debug: () => {} },
  };
  return { ctx, root, advance: (/** @type {number} */ ms) => (clock += ms), dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a check installs a newer version and records it for the next start', async () => {
  const c = context();
  try {
    const { ctx } = c;
    writeState(ctx.dir, ctx.key, { v: 1, registry: FEED, spec: ctx.spec.raw, name, version: '1.2.0', usedAt: 1, installed: ['1.2.0'] });
    const r = await checkForUpdate(ctx, new AbortController().signal);
    assert.deepEqual(r, { outcome: 'updated', version: '1.3.0' });
    const s = readState(ctx.dir, ctx.key);
    assert.equal(s?.version, '1.3.0');
    assert.equal(s?.previous, '1.2.0');
    assert.deepEqual(s?.installed, ['1.2.0', '1.3.0']);
    assert.equal(s?.checkedAt, 1_000_000);
    assert.equal(s?.checkStartedAt, undefined);
    assert.equal(readNpxInstall(ctx.cacheDir, `${name}@1.3.0`, name).complete, true);
    assert.deepEqual(await checkForUpdate(ctx, new AbortController().signal), { outcome: 'current', version: '1.3.0' });
  } finally {
    c.dispose();
  }
});

test('failed checks back off; a sign-in problem is flagged, also when npm reports E401; a stop records nothing', async () => {
  const noToken = context({
    acquire: async () => {
      throw new TokenError('could not acquire a token.', { attempts: [{ source: 'az', reason: 'run az login' }], hint: 'Run az login' });
    },
  });
  try {
    const r = await checkForUpdate(noToken.ctx, new AbortController().signal);
    assert.equal(r.outcome === 'failed' && r.signIn, true);
    const s = readState(noToken.ctx.dir, noToken.ctx.key);
    assert.equal(s?.failures, 1);
    assert.equal(s?.nextCheckAt, 1_000_000 + backoffMs(1));
  } finally {
    noToken.dispose();
  }

  const refused = context({ range: '^1', resolve: async () => ({ kind: 'unsupported', detail: 'odd range' }) });
  try {
    refused.ctx.run = fakeNpmRun(refused.ctx.cacheDir, { code: 1, stderr: 'npm error code E401\nnpm error Unable to authenticate' }).run;
    const r = await checkForUpdate(refused.ctx, new AbortController().signal);
    assert.equal(r.outcome === 'failed' && r.signIn, true, "npm's E401 is a sign-in problem too");
  } finally {
    refused.dispose();
  }

  const ac = new AbortController();
  const stopping = context({
    resolve: async () => {
      ac.abort();
      return { kind: 'unavailable', detail: 'aborted' };
    },
  });
  try {
    const r = await checkForUpdate(stopping.ctx, ac.signal);
    assert.equal(r.outcome, 'stopped');
    const s = readState(stopping.ctx.dir, stopping.ctx.key);
    assert.equal(s?.failures, undefined, 'not counted');
    assert.equal(s?.checkStartedAt, undefined);
  } finally {
    stopping.dispose();
  }
});

test('a check another process just started is left to it; one installing the same version is skipped', async () => {
  const c = context();
  try {
    const { ctx } = c;
    writeState(ctx.dir, ctx.key, { v: 1, registry: FEED, spec: ctx.spec.raw, name, checkStartedAt: 1_000_000 - 1000 });
    assert.equal((await checkForUpdate(ctx, new AbortController().signal)).outcome, 'skipped');
  } finally {
    c.dispose();
  }
});

test('waitForSteadyRun restarts its count after a freeze and stops on abort', async (t) => {
  // Its timer is unref'd (in use, the running server keeps the process alive);
  // here something must, or Node 20/22's test runner cancels the test.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  let wall = 0;
  let mono = 0;
  const ac = new AbortController();
  const ticks = [1000, 1000, 40_000, 1000, 1000, 1000];
  let i = 0;
  const steady = waitForSteadyRun(2500, ac.signal, {
    tickMs: 5,
    freezeMs: 20_000,
    wall: () => wall,
    mono: () => {
      if (i < ticks.length) {
        wall += ticks[i];
        mono += ticks[i++];
      } else {
        wall += 1000;
        mono += 1000;
      }
      return mono;
    },
  });
  assert.equal(await steady, true);
  assert.ok(i >= 5, 'it waited past the freeze');

  const stopped = new AbortController();
  const waiting = waitForSteadyRun(60_000, stopped.signal, { tickMs: 5 });
  stopped.abort();
  assert.equal(await waiting, false);
});

test('startUpdates: the first check waits a random delay, later ones skip a check another session just made', async () => {
  const c = context();
  try {
    const { ctx } = c;
    /** @type {string[]} */
    const outcomes = [];
    let asked = 0;
    const started = Date.now();
    const u = startUpdates(ctx, { checkNow: true, intervalMs: 60_000, firstDelayMs: 200, random: () => (asked++, 0.5), onResult: (r) => outcomes.push(r.outcome) });
    const end = Date.now() + 5000;
    while (outcomes.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(outcomes, ['updated']);
    assert.equal(asked, 1);
    assert.ok(Date.now() - started >= 90, 'it waited about half of the 200 ms');
    u.stop();
    await u.idle;

    // A long session: another session of the spec checked a moment ago, so ours waits.
    const real = { ...ctx, now: Date.now };
    writeState(ctx.dir, ctx.key, { v: 1, registry: FEED, spec: ctx.spec.raw, name, version: '1.3.0', checkedAt: Date.now() });
    /** @type {string[]} */
    const later = [];
    const periodic = startUpdates(real, { checkNow: false, intervalMs: 150, settleMs: 0, onResult: (r) => later.push(r.outcome) });
    await new Promise((r) => setTimeout(r, 100));
    writeState(ctx.dir, ctx.key, { v: 1, registry: FEED, spec: ctx.spec.raw, name, version: '1.3.0', checkedAt: Date.now() });
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(later, [], 'the check another session made counts');
    periodic.stop();
    await periodic.idle;
  } finally {
    c.dispose();
  }
});

test('behind a proxy fetch does not use, npm picks the version at once (a tag with npm view, a range with a lockfile), and the exact version follows from its cache', async () => {
  for (const range of ['latest', '^1']) {
    const c = context({ range, resolve: async () => assert.fail('no direct request through a proxy') });
    try {
      const { ctx } = c;
      const npmFake = fakeNpmRun(ctx.cacheDir, { resolvesTo: '1.5.0' });
      ctx.run = npmFake.run;
      ctx.env = { HTTPS_PROXY: 'http://proxy.example:8080' };
      assert.deepEqual(await checkForUpdate(ctx, new AbortController().signal), { outcome: 'updated', version: '1.5.0' }, range);
      const [ask, install] = npmFake.calls;
      assert.equal(ask.args[1], range === 'latest' ? 'view' : 'install');
      const rc = /** @type {string} */ (ask.env.npm_config_userconfig);
      assert.equal(ask.cwd, path.join(fs.realpathSync(ctx.baseDir), path.basename(path.dirname(rc))), 'in its own private folder');
      assert.equal(npmFake.calls.some((call) => call.args.includes(`--package=${name}@${range}`)), false, 'the folder of the spec as written is never used');
      assert.ok(install.args.includes(`--package=${name}@1.5.0`));
      assert.ok(install.args.includes('--prefer-offline'), 'the exact install reads what npm just cached');
      assert.equal(readState(ctx.dir, ctx.key)?.version, '1.5.0');
    } finally {
      c.dispose();
    }
  }
  const c = context({ resolve: async () => ({ kind: 'unavailable', detail: 'fetch failed' }) });
  try {
    const npmFake = fakeNpmRun(c.ctx.cacheDir);
    c.ctx.run = npmFake.run;
    const r = await checkForUpdate(c.ctx, new AbortController().signal);
    assert.equal(r.outcome, 'failed', 'no proxy: the feed is down, so back off');
    assert.equal(npmFake.calls.length, 0);
  } finally {
    c.dispose();
  }
});

test('an unreachable feed backs off without asking for a sign-in; a discovered tenant is remembered, and forgotten when the feed refuses', async () => {
  const c = context();
  try {
    const { ctx } = c;
    let asked = 0;
    ctx.acquire = async () => {
      asked++;
      return { token: validJwt(), source: 'az', claims: {} };
    };
    ctx.tenant = undefined;
    ctx.discover = async () => ({ error: 'getaddrinfo ENOTFOUND pkgs.dev.azure.com' });
    const r = await checkForUpdate(ctx, new AbortController().signal);
    assert.equal(r.outcome === 'failed' && r.signIn, undefined);
    assert.match(r.outcome === 'failed' ? r.detail : '', /could not reach/);
    assert.equal(asked, 0, 'no token is requested');
    assert.equal(readState(ctx.dir, ctx.key)?.failures, 1);

    let discoveries = 0;
    ctx.discover = async () => (discoveries++, { tenant: TENANT });
    writeState(ctx.dir, ctx.key, { v: 1, registry: FEED, spec: ctx.spec.raw, name });
    assert.equal((await checkForUpdate(ctx, new AbortController().signal)).outcome, 'updated');
    assert.equal(tenantMemory(ctx.dir, 'contoso', { now: ctx.now }).tenant, TENANT);
    ctx.resolve = async () => ({ kind: 'refused', status: 401, detail: 'HTTP 401' });
    const refused = await checkForUpdate(ctx, new AbortController().signal);
    assert.equal(refused.outcome === 'failed' && refused.signIn, true);
    assert.equal(discoveries, 1, 'the second check used the remembered tenant');
    assert.equal(tenantMemory(ctx.dir, 'contoso', { now: ctx.now }).tenant, undefined, 'refused: forgotten');
  } finally {
    c.dispose();
  }
});

test('a background check reuses the remembered sign-in tool, and remembers the one that gave the token', async () => {
  const c = context({
    acquire: async (o) => {
      preferred.push(o.prefer);
      o.remember?.('azureauth');
      return { token: validJwt(), source: 'azureauth', claims: {} };
    },
  });
  /** @type {(string | undefined)[]} */
  const preferred = [];
  try {
    signInMemory(c.ctx.dir, c.ctx.tenant).remember?.('azd');
    assert.equal((await checkForUpdate(c.ctx, new AbortController().signal)).outcome, 'updated');
    assert.deepEqual(preferred, ['azd']);
    assert.equal(signInMemory(c.ctx.dir, c.ctx.tenant).prefer, 'azureauth');
  } finally {
    c.dispose();
  }
});

test('a check records only versions npm installed for it, keeps the mark of a failed start it did not repair, and a spec gone from the feed makes the next start ask the feed', async () => {
  const c = context();
  try {
    const { ctx } = c;
    writeState(ctx.dir, ctx.key, { v: 1, registry: FEED, spec: ctx.spec.raw, name, version: '1.2.0', usedAt: 1, installed: ['1.2.0'] });
    // A manual npx with the feed installed 1.3.0 already.
    seedNpxInstall(ctx.cacheDir, { spec: `${name}@1.3.0`, name, version: '1.3.0' });
    seedPackument(ctx.cacheDir, FEED, name);
    assert.deepEqual(await checkForUpdate(ctx, new AbortController().signal), { outcome: 'updated', version: '1.3.0' });
    assert.deepEqual(readState(ctx.dir, ctx.key)?.installed, ['1.2.0'], 'not ours: cleanup never removes it');

    writeState(ctx.dir, ctx.key, { ...(/** @type {import('../src/state.js').SpecState} */ (readState(ctx.dir, ctx.key))), offlineFailedAt: 5 });
    assert.equal((await checkForUpdate(ctx, new AbortController().signal)).outcome, 'current');
    assert.equal(readState(ctx.dir, ctx.key)?.offlineFailedAt, 5, 'not repaired: the next start still reinstalls it');

    ctx.resolve = async () => ({ kind: 'not-found', status: 404, detail: 'HTTP 404' });
    const g = await checkForUpdate(ctx, new AbortController().signal);
    assert.equal(g.outcome === 'failed' && g.gone, true);
    assert.equal(typeof readState(ctx.dir, ctx.key)?.missingAt, 'number');
  } finally {
    c.dispose();
  }
});

test('only the lookup marks a spec as gone: a version npm cannot install (a missing dependency) keeps the cached copy starting', async () => {
  for (const stderr of [
    'npm error code ETARGET\nnpm error notarget No matching version found for depx@^2.0.0.',
    `npm error code ETARGET\nnpm error notarget No matching version found for ${name}@1.3.0.`,
  ]) {
    const c = context();
    try {
      c.ctx.run = fakeNpmRun(c.ctx.cacheDir, { code: 1, stderr }).run;
      const r = await checkForUpdate(c.ctx, new AbortController().signal);
      assert.equal(r.outcome, 'failed');
      assert.equal(r.outcome === 'failed' && r.gone, undefined, stderr);
      assert.equal(readState(c.ctx.dir, c.ctx.key)?.missingAt, undefined, 'the next start still uses npm\'s cache');
      assert.equal(readState(c.ctx.dir, c.ctx.key)?.failures, 1, 'backs off');
    } finally {
      c.dispose();
    }
  }
});

test('offline with a remembered tenant: "could not reach", not "sign in", and the tenant stays remembered', async () => {
  const c = context({
    acquire: async () => {
      throw new TokenError('could not acquire a token.', { attempts: [{ source: 'az', reason: 'HTTPSConnectionPool: Max retries exceeded' }], hint: '' });
    },
  });
  try {
    const { ctx } = c;
    ctx.tenant = undefined;
    tenantMemory(ctx.dir, 'contoso', { now: ctx.now }).remember(TENANT);
    let probes = 0;
    ctx.discover = async () => (probes++, { error: 'getaddrinfo ENOTFOUND pkgs.dev.azure.com' });
    const r = await checkForUpdate(ctx, new AbortController().signal);
    assert.equal(r.outcome, 'failed');
    assert.equal(r.outcome === 'failed' && r.signIn, undefined);
    assert.match(r.outcome === 'failed' ? r.detail : '', /could not reach/);
    assert.equal(probes, 1, 'one anonymous request tells offline from a missing sign-in');
    assert.equal(tenantMemory(ctx.dir, 'contoso', { now: ctx.now }).tenant, TENANT);

    ctx.discover = async () => ({ tenant: TENANT });
    const online = await checkForUpdate(ctx, new AbortController().signal);
    assert.equal(online.outcome === 'failed' && online.signIn, true, 'the feed answers: the sign-in is what is missing');
    assert.equal(tenantMemory(ctx.dir, 'contoso', { now: ctx.now }).tenant, undefined);
  } finally {
    c.dispose();
  }
});

test('the first background check is skipped when another session checked during its delay', async () => {
  const c = context();
  try {
    const { ctx } = c;
    const real = { ...ctx, now: Date.now };
    let checks = 0;
    const counting = { ...real, resolve: /** @type {typeof real.resolve} */ (async () => (checks++, { kind: 'resolved', version: '1.3.0', via: 'dist-tags' })) };
    const a = startUpdates(counting, { checkNow: true, firstDelayMs: 0, intervalMs: 60_000 });
    const b = startUpdates(counting, { checkNow: true, firstDelayMs: 400, random: () => 1, intervalMs: 60_000 });
    await new Promise((r) => setTimeout(r, 1500));
    a.stop();
    b.stop();
    await Promise.all([a.idle, b.idle]);
    assert.equal(checks, 1, 'one lookup for both sessions');
  } finally {
    c.dispose();
  }
});
