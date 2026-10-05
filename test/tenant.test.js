import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenantFromHeaders, discoverTenant, isGuid, ZERO_GUID } from '../src/tenant.js';
import { TENANT } from '../fixtures/jwt.js';

const FEED = 'https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/';

test('reads x-vss-resourcetenant', () => {
  assert.deepEqual(tenantFromHeaders(new Headers({ 'x-vss-resourcetenant': TENANT.toUpperCase() })), { tenant: TENANT });
});

test('zero tenant means the organization is not backed by Entra ID', () => {
  assert.deepEqual(tenantFromHeaders(new Headers({ 'x-vss-resourcetenant': ZERO_GUID })), { msa: true });
});

test('falls back to the Bearer authorization_uri challenge', () => {
  const h = new Headers();
  h.append('www-authenticate', `Bearer authorization_uri=https://login.windows.net/${TENANT}`);
  h.append('www-authenticate', 'Basic realm="https://example.invalid/"');
  assert.deepEqual(tenantFromHeaders(h), { tenant: TENANT });
  const quoted = new Headers({ 'www-authenticate': `Bearer authorization_uri="https://login.microsoftonline.com/${TENANT}", x=y` });
  assert.deepEqual(tenantFromHeaders(quoted), { tenant: TENANT });
});

test('ignores junk', () => {
  assert.deepEqual(tenantFromHeaders(new Headers()), {});
  assert.deepEqual(tenantFromHeaders(new Headers({ 'x-vss-resourcetenant': 'nope' })), {});
  assert.deepEqual(tenantFromHeaders(new Headers({ 'www-authenticate': 'Bearer authorization_uri=::bad' })), {});
  assert.deepEqual(tenantFromHeaders(new Headers({ 'www-authenticate': 'Bearer authorization_uri=https://x/common' })), {});
  assert.equal(isGuid('x'), false);
});

test('discoverTenant makes one anonymous request and never follows redirects', async () => {
  /** @type {{ url: unknown, init: RequestInit | undefined }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response('unauthorized', { status: 401, headers: { 'x-vss-resourcetenant': TENANT } });
  };
  assert.deepEqual(await discoverTenant(FEED, { fetchImpl }), { tenant: TENANT });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, FEED);
  assert.equal(calls[0].init?.redirect, 'manual');
  const headers = /** @type {Record<string, string>} */ (calls[0].init?.headers);
  assert.equal(Object.keys(headers).some((k) => k.toLowerCase() === 'authorization'), false);
});

test('discoverTenant is best effort', async () => {
  const failing = /** @type {typeof fetch} */ (async () => {
    throw new Error('offline');
  });
  assert.deepEqual(await discoverTenant(FEED, { fetchImpl: failing }), { error: 'offline' });

  /** @type {typeof fetch} */
  const hanging = (_url, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('timed out'))));
  const started = Date.now();
  const r = await discoverTenant(FEED, { fetchImpl: hanging, timeoutMs: 50 });
  assert.ok(r.error);
  assert.ok(Date.now() - started < 2000);

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  const cancelled = await discoverTenant(FEED, { fetchImpl: hanging, timeoutMs: 10_000, signal: ac.signal });
  assert.ok(cancelled.error, 'an outer abort (e.g. SIGINT) cancels discovery');
});
