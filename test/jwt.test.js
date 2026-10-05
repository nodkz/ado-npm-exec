import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEntraToken, isJwtShaped, decodeJwtPayload } from '../src/jwt.js';
import { makeJwt, validJwt, TENANT, OTHER_TENANT, ADO_AUD } from '../fixtures/jwt.js';

const now = Date.now();

test('accepts a valid Azure DevOps token', () => {
  const r = checkEntraToken(validJwt(), { tenant: TENANT, nowMs: now });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.claims.tid, TENANT);
});

test('accepts audience arrays, upper-case tenant and missing tid', () => {
  assert.equal(checkEntraToken(validJwt({ aud: ['x', ADO_AUD] }), { nowMs: now }).ok, true);
  assert.equal(checkEntraToken(validJwt(), { tenant: TENANT.toUpperCase(), nowMs: now }).ok, true);
  assert.equal(checkEntraToken(validJwt({ tid: undefined }), { tenant: TENANT, nowMs: now }).ok, true);
});

test('rejects PATs and other non-JWT strings', () => {
  for (const t of ['a'.repeat(52), 'ghp_abcdefghijklmnopqrstuvwxyz', '', 'a.b.c', `${validJwt()}\n`, undefined]) {
    const r = checkEntraToken(t, { nowMs: now });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : '', /PATs are not supported/);
  }
  assert.equal(isJwtShaped('x'.repeat(20000)), false);
});

test('rejects wrong audience, expiry and tenant', () => {
  const bad = (/** @type {Record<string, unknown>} */ o, /** @type {string} */ tenant = TENANT) =>
    checkEntraToken(validJwt(o), { tenant, nowMs: now });
  assert.match(JSON.stringify(bad({ aud: 'https://management.azure.com/' })), /not Azure DevOps/);
  assert.match(JSON.stringify(bad({ exp: Math.floor(now / 1000) + 60 })), /expire/);
  assert.match(JSON.stringify(bad({ exp: Math.floor(now / 1000) - 60 })), /expire/);
  assert.match(JSON.stringify(bad({ exp: 'soon' })), /no expiry/);
  assert.match(JSON.stringify(bad({ tid: OTHER_TENANT })), /tenant/);
});

test('rejects undecodable payloads', () => {
  const t = `${'eyJhbGciOiJSUzI1NiJ9'}.${Buffer.from('not json').toString('base64url')}xx.sig`;
  assert.equal(decodeJwtPayload(t), undefined);
  assert.equal(checkEntraToken(t, { nowMs: now }).ok, false);
  assert.equal(checkEntraToken(makeJwt(/** @type {any} */ ([1, 2])), { nowMs: now }).ok, false);
});
