/**
 * Discover the Entra ID tenant that owns an Azure DevOps organization from
 * the feed's anonymous 401 response, so az/azureauth request a token for the
 * right tenant. Purely best effort: any failure just means "unknown".
 */

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

/** @param {unknown} s @returns {s is string} */
export function isGuid(s) {
  return typeof s === 'string' && GUID_RE.test(s);
}

/**
 * @typedef {object} TenantInfo
 * @property {string} [tenant]  tenant GUID
 * @property {boolean} [msa]    the organization is not backed by Entra ID
 * @property {string} [error]
 */

/**
 * @param {{ get(name: string): string | null }} headers
 * @returns {TenantInfo}
 */
export function tenantFromHeaders(headers) {
  const resourceTenant = headers.get('x-vss-resourcetenant')?.trim();
  if (isGuid(resourceTenant)) {
    if (resourceTenant === ZERO_GUID) return { msa: true };
    return { tenant: resourceTenant.toLowerCase() };
  }
  const challenge = headers.get('www-authenticate') || '';
  const m = /Bearer\s+authorization_uri="?([^\s",]+)/i.exec(challenge);
  if (m) {
    try {
      const segment = new URL(m[1]).pathname.split('/')[1];
      if (isGuid(segment) && segment !== ZERO_GUID) return { tenant: segment.toLowerCase() };
    } catch {
      // ignore malformed URI
    }
  }
  return {};
}

/**
 * @param {string} registryHref an allowlisted feed URL
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<TenantInfo>}
 */
export async function discoverTenant(registryHref, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  try {
    const res = await fetchImpl(registryHref, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': 'ado-npm-exec' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => {});
    return tenantFromHeaders(res.headers);
  } catch (error) {
    return { error: /** @type {Error} */ (error)?.message || String(error) };
  }
}
