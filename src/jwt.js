/**
 * Local sanity checks for Microsoft Entra ID access tokens. The signature is
 * not verified: Azure DevOps does that. This only catches tokens that cannot
 * work (wrong audience, wrong tenant, expired, or not a JWT at all, e.g. a
 * PAT) so we can fall through to the next provider with a clear reason
 * instead of letting npm fail later with a bare E401.
 */

import { ADO_RESOURCE_ID } from './registry.js';

export const MAX_TOKEN_LENGTH = 16384;
const JWT_RE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*$/;
const ACCEPTED_AUDIENCES = new Set([ADO_RESOURCE_ID, 'https://app.vssps.visualstudio.com']);

/** @param {unknown} token */
export function isJwtShaped(token) {
  return typeof token === 'string' && token.length <= MAX_TOKEN_LENGTH && JWT_RE.test(token);
}

/**
 * @param {string} token
 * @returns {Record<string, unknown> | undefined}
 */
export function decodeJwtPayload(token) {
  try {
    const value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @typedef {{ ok: true, claims: Record<string, unknown> } | { ok: false, reason: string }} TokenCheck
 */

/**
 * @param {unknown} token
 * @param {{ tenant?: string, nowMs: number, minValidityMs?: number }} opts
 * @returns {TokenCheck}
 */
export function checkEntraToken(token, { tenant, nowMs, minValidityMs = 2 * 60 * 1000 }) {
  if (!isJwtShaped(token)) {
    return { ok: false, reason: 'not a Microsoft Entra ID access token (JWT); PATs are not supported' };
  }
  const claims = decodeJwtPayload(/** @type {string} */ (token));
  if (!claims) return { ok: false, reason: 'the JWT payload cannot be decoded' };

  const aud = claims.aud;
  const auds = Array.isArray(aud) ? aud : [aud];
  if (!auds.some((a) => typeof a === 'string' && ACCEPTED_AUDIENCES.has(a))) {
    return { ok: false, reason: `the token audience ${JSON.stringify(aud)} is not Azure DevOps` };
  }
  if (typeof claims.exp !== 'number') return { ok: false, reason: 'the token has no expiry' };
  if (claims.exp * 1000 - nowMs < minValidityMs) {
    return { ok: false, reason: 'the token is expired or expires within 2 minutes' };
  }
  if (tenant && typeof claims.tid === 'string' && claims.tid.toLowerCase() !== tenant.toLowerCase()) {
    return { ok: false, reason: `the token is for tenant ${claims.tid} but the feed belongs to tenant ${tenant}` };
  }
  return { ok: true, claims };
}
