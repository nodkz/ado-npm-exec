/**
 * Registry allowlist and package-spec validation.
 *
 * A token is only ever sent to an Azure Artifacts npm feed on a Microsoft
 * operated host over https. Anything else is rejected before a token is
 * acquired, so a crafted config cannot point the token at another server.
 */

/** Well-known, public Entra ID application (resource) ID of Azure DevOps. */
export const ADO_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';

const DEV_AZURE_HOST = 'pkgs.dev.azure.com';
const VISUALSTUDIO_HOST_RE = /^([a-z0-9][a-z0-9-]{0,62})\.pkgs\.visualstudio\.com$/;

// Organization names: letters, digits, hyphens. Project names may contain
// spaces, which a URL carries as %20; no other escape is accepted.
const ORG_SEG = '[A-Za-z0-9][A-Za-z0-9-]*';
const PROJECT_SEG = '(?:[A-Za-z0-9._~-]|%20)+';
const FEED_SEG = '[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?';
const FEED_TAIL = `/_packaging/(${FEED_SEG})/npm/registry/`;
const DEV_AZURE_PATH_RE = new RegExp(`^/(${ORG_SEG})(?:/(${PROJECT_SEG}))?${FEED_TAIL}$`);
const VISUALSTUDIO_PATH_RE = new RegExp(`^(?:/(${PROJECT_SEG}))?${FEED_TAIL}$`);
// Raw input: https, a plain host name, and a path of URL-safe characters only.
const RAW_URL_RE = /^https:\/\/([A-Za-z0-9.-]+)(\/[A-Za-z0-9._~%@/-]*)$/i;

export class RegistryError extends Error {
  name = 'RegistryError';
}

/**
 * @typedef {object} Registry
 * @property {string} href      normalized feed URL, always ends with "/"
 * @property {string} host      lowercase host name
 * @property {string} pathname  path, always ends with "/"
 * @property {string} nerfDart  "//host/path/" key npm uses for registry-scoped auth
 * @property {string} org       organization name (for messages)
 */

/**
 * Validate an Azure Artifacts npm feed URL against the allowlist.
 *
 * @param {string | undefined} input
 * @returns {Registry}
 */
export function validateRegistryUrl(input) {
  const fail = (/** @type {string} */ why) =>
    new RegistryError(
      `refusing feed URL ${JSON.stringify(input)}: ${why}. Expected ` +
        'https://pkgs.dev.azure.com/<org>[/<project>]/_packaging/<feed>/npm/registry/ or ' +
        'https://<org>.pkgs.visualstudio.com[/<project>]/_packaging/<feed>/npm/registry/',
    );
  if (typeof input !== 'string' || input === '') throw fail('it is empty');
  if (!/^https:\/\//i.test(input)) throw fail('only https:// URLs are allowed');
  const raw = RAW_URL_RE.exec(input);
  if (!raw) {
    throw fail('it contains characters that are not allowed (query, fragment, port, credentials, spaces or backslashes)');
  }
  const host = raw[1].toLowerCase();
  let pathname = raw[2];
  if (/%(?!20)/.test(pathname)) throw fail('only %20 escapes are allowed in the path');
  if (pathname.split('/').some((s) => s === '.' || s === '..')) throw fail('dot segments are not allowed');
  if (!pathname.endsWith('/')) pathname += '/';

  let org;
  if (host === DEV_AZURE_HOST) {
    const m = DEV_AZURE_PATH_RE.exec(pathname);
    if (!m || m[2] === '_packaging') throw fail('the path is not an Azure Artifacts npm feed path');
    org = m[1];
  } else {
    const hm = VISUALSTUDIO_HOST_RE.exec(host);
    if (!hm) throw fail(`host ${host} is not ${DEV_AZURE_HOST} or <org>.pkgs.visualstudio.com`);
    const m = VISUALSTUDIO_PATH_RE.exec(pathname);
    if (!m || m[1] === '_packaging') throw fail('the path is not an Azure Artifacts npm feed path');
    org = hm[1];
  }

  const href = `https://${host}${pathname}`;
  // Belt and braces: the WHATWG parser must not reinterpret what we validated.
  const url = new URL(href);
  if (url.href !== href || url.hostname !== host || url.port !== '' || url.username || url.password) {
    throw fail('it does not round-trip through URL parsing');
  }
  return { href, host, pathname, nerfDart: `//${host}${pathname}`, org };
}

export class SpecError extends Error {
  name = 'SpecError';
}

const NAME_PART = '[a-z0-9~-][a-z0-9._~-]*';
const SPEC_RE = new RegExp(`^(?:@(${NAME_PART})/)?(${NAME_PART})(?:@([A-Za-z0-9 .^~<>=|+*_-]+))?$`);

/**
 * @typedef {object} PackageSpec
 * @property {string} raw
 * @property {string} name   full name including scope
 * @property {string | undefined} scope  scope without "@"
 * @property {string | undefined} range  version, range or dist-tag
 */

/**
 * Accept only registry specs: `[@scope/]name[@version|range|tag]`. URLs,
 * paths, git specs and `npm:` aliases would bypass the feed and are refused.
 *
 * @param {string | undefined} raw
 * @returns {PackageSpec}
 */
export function parseSpec(raw) {
  if (typeof raw !== 'string' || raw === '') throw new SpecError('missing package spec');
  const m = SPEC_RE.exec(raw);
  if (!m || raw.length > 256 || (m[3] !== undefined && m[3].trim() === '')) {
    throw new SpecError(
      `invalid package spec ${JSON.stringify(raw)}: expected [@scope/]name[@version|range|tag] ` +
        '(URLs, paths, git and npm: alias specs are not allowed)',
    );
  }
  const [, scope, base, range] = m;
  return { raw, name: scope ? `@${scope}/${base}` : base, scope, range };
}
