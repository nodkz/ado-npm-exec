/** Test helpers for fabricated (unsigned) JWTs. Never use real tokens in tests. */

export const ADO_AUD = '499b84ac-1321-427f-aa17-267ca6975798';
export const TENANT = '11111111-2222-3333-4444-555555555555';
export const OTHER_TENANT = '99999999-8888-7777-6666-555555555555';

/** @param {Record<string, unknown>} claims */
export function makeJwt(claims) {
  const enc = (/** @type {unknown} */ o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}.${'s'.repeat(43)}`;
}

/** @param {Record<string, unknown>} [overrides] */
export function validJwt(overrides = {}) {
  return makeJwt({ aud: ADO_AUD, tid: TENANT, exp: Math.floor(Date.now() / 1000) + 3600, ...overrides });
}
