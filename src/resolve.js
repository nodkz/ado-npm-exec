/**
 * npm's exec cache folder is keyed by the spec string. Resolving the spec to
 * an exact version gives each version its own folder. The feed's answers also
 * turn npm's bare E401/E404 into clear messages.
 */

import { tlsChecksOff } from './env.js';
import { classifyWanted, parseVersion, pickVersion } from './semver.js';

/**
 * 'unsupported': the version cannot be picked exactly like npm, so npm must pick it.
 *
 * @typedef {{ kind: 'resolved', version: string, via: 'exact' | 'dist-tags' | 'packument' }
 *   | { kind: 'not-found', status: number, detail: string }
 *   | { kind: 'no-match', detail: string, latest?: string }
 *   | { kind: 'refused', status: number, detail: string }
 *   | { kind: 'unavailable', detail: string, status?: number }
 *   | { kind: 'unsupported', detail: string }} Resolution
 */

/**
 * @typedef {object} ResolveOptions
 * @property {{ href: string }} registry
 * @property {{ raw: string, name: string, range?: string }} spec
 * @property {string} [token]       Entra ID access token for the feed
 * @property {string} [nodeVersion] for `engines.node` (default: this Node)
 * @property {string} [npmVersion]  for `engines.npm`
 * @property {string} [defaultTag]  npm's `tag` setting (default: latest)
 * @property {string} [before]      npm's `before` setting (a date): when set, npm picks the version
 * @property {typeof fetch} [fetchImpl]
 * @property {number} [timeoutMs]   per request, headers and body
 * @property {number} [maxBytes]    cap for a success body (default: 1 MiB for dist-tags, 64 MiB for the packument)
 * @property {AbortSignal} [signal]
 */

const LOOKUP_TIMEOUT_MS = 10_000;
const DIST_TAGS_MAX_BYTES = 1024 * 1024;
const PACKUMENT_MAX_BYTES = 64 * 1024 * 1024;
const ERROR_MAX_BYTES = 64 * 1024;
// npm's Accept header for abbreviated metadata
const CORGI_ACCEPT = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';

/**
 * Azure Artifacts' answer to an ANONYMOUS read of a package the feed holds no
 * version of: 401 "No local versions of package '<name>'; please provide
 * authentication...". A real credentials failure is a 401 too (TF400813), so
 * only the message tells the two apart.
 */
const NO_LOCAL_VERSIONS_RE = /\bNo local versions of package\b/i;

/** @param {string} registryHref @param {string} name */
export function distTagsUrl(registryHref, name) {
  return `${registryHref.replace(/\/+$/, '')}/-/package/${name.replace('/', '%2f')}/dist-tags`;
}

/** @param {string} registryHref @param {string} name */
export function packumentUrl(registryHref, name) {
  return `${registryHref.replace(/\/+$/, '')}/${name.replace('/', '%2f')}`;
}

/**
 * @typedef {{ ok: true, status: number, body: unknown }
 *   | { ok: false, status?: number, detail: string, noLocalVersions?: boolean, network?: boolean, notJson?: boolean }} FetchResult
 */

const TLS_OFF = 'NODE_TLS_REJECT_UNAUTHORIZED=0 turns certificate checks off, so ado-npm-exec does not send the token itself';

/**
 * One GET with the token. It does not follow redirects: the token must not go
 * to another host.
 *
 * @param {string} url
 * @param {Pick<ResolveOptions, 'token' | 'fetchImpl' | 'timeoutMs' | 'signal'>} opts
 * @param {{ accept: string, maxBytes: number }} req  `maxBytes` caps a success body
 * @returns {Promise<FetchResult>}
 */
async function getJson(url, { token, fetchImpl = fetch, timeoutMs = LOOKUP_TIMEOUT_MS, signal }, { accept, maxBytes }) {
  if (token && tlsChecksOff()) return { ok: false, detail: TLS_OFF, network: true };
  // A ref'd timer: AbortSignal.timeout's is unref'd and would let the event
  // loop drain while a request hangs without holding a handle.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  const onAbort = () => ac.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    /** @type {Record<string, string>} */
    const headers = { accept, 'user-agent': 'ado-npm-exec' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', headers, signal: ac.signal });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, status: res.status, detail: `HTTP ${res.status} redirect (not followed)`, network: true };
    }
    if (!res.ok) {
      // The status is the answer, and the message is at the start of the body.
      // A large error page must not turn the answer into a failure.
      const text = await readText(res, ERROR_MAX_BYTES, true);
      const message = errorMessage(text);
      return {
        ok: false,
        status: res.status,
        detail: message ? `HTTP ${res.status}: ${message}` : `HTTP ${res.status}`,
        ...(res.status === 401 && NO_LOCAL_VERSIONS_RE.test(text) ? { noLocalVersions: true } : {}),
      };
    }
    const text = await readText(res, maxBytes);
    try {
      return { ok: true, status: res.status, body: JSON.parse(text) };
    } catch {
      return { ok: false, status: res.status, detail: 'the response is not JSON', notJson: true };
    }
  } catch (error) {
    const reason = ac.signal.reason instanceof Error ? ac.signal.reason.message : /** @type {Error} */ (error)?.message || String(error);
    return { ok: false, detail: reason, network: true };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * The body as text. Each chunk is decoded when it arrives, so the bytes are
 * not kept. Over `maxBytes`, it throws, or with `truncate` it stops reading
 * and returns the text of the first `maxBytes`.
 *
 * @param {Response} res
 * @param {number} maxBytes
 * @param {boolean} [truncate]
 * @returns {Promise<string>}
 */
async function readText(res, maxBytes, truncate = false) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - size;
    if (value.byteLength > room) {
      await reader.cancel().catch(() => {});
      if (!truncate) throw new Error(`response larger than ${maxBytes} bytes`);
      text += decoder.decode(value.subarray(0, room), { stream: true });
      break;
    }
    size += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** The message of an Azure DevOps or npm error body, first line, capped. @param {string} text */
function errorMessage(text) {
  let message = '';
  try {
    const body = JSON.parse(text);
    for (const k of ['error', 'message', 'reason']) {
      if (typeof body?.[k] === 'string' && body[k].trim()) {
        message = body[k];
        break;
      }
    }
  } catch {
    message = /^\s*</.test(text) ? '' : text;
  }
  const line = message.split(/\r?\n/)[0].trim();
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/**
 * A dist-tags answer that says nothing about the package: a registry without
 * the endpoint answers 404 (like a missing package), 400, 405, 410 or 501, or
 * a page that is not JSON. Only the packument can tell those apart.
 *
 * @param {Extract<FetchResult, { ok: false }>} r
 */
function endpointCannotAnswer(r) {
  if (r.status === undefined || r.network || r.noLocalVersions) return false;
  if (r.notJson || r.status === 404 || r.status === 501) return true;
  return r.status >= 400 && r.status < 500 && ![401, 403, 408, 429].includes(r.status);
}

/**
 * @param {Extract<FetchResult, { ok: false }>} r
 * @returns {Resolution}
 */
function failure(r) {
  if (r.network || r.status === undefined) return { kind: 'unavailable', detail: r.detail };
  if (r.status === 404 || r.noLocalVersions) return { kind: 'not-found', status: r.status, detail: r.detail };
  if (r.status === 401 || r.status === 403) return { kind: 'refused', status: r.status, detail: r.detail };
  return { kind: 'unavailable', status: r.status, detail: r.detail };
}

/**
 * @param {unknown} v
 * @returns {string | undefined} a normalized version safe for `name@<version>`
 */
function exactVersion(v) {
  if (typeof v !== 'string') return undefined;
  const parsed = parseVersion(v);
  return parsed && /^[0-9A-Za-z.+-]+$/.test(parsed.version) ? parsed.version : undefined;
}

/**
 * @param {ResolveOptions} opts
 * @returns {Promise<Resolution>}
 */
export async function resolveSpec(opts) {
  // npm's before setting changes the pick. npm even refuses an exact version
  // that was published after that date.
  if (opts.before) return { kind: 'unsupported', detail: "npm's before setting is on" };
  const { registry, spec } = opts;
  const wanted = spec.range ?? '';
  const kind = classifyWanted(wanted);
  if (!kind) return { kind: 'unsupported', detail: `cannot tell whether ${JSON.stringify(wanted)} is a version, a range or a tag` };
  if (kind.type === 'version') {
    const version = exactVersion(kind.version);
    return version ? { kind: 'resolved', version, via: 'exact' } : { kind: 'unsupported', detail: `unusual version ${JSON.stringify(wanted)}` };
  }

  if (kind.type === 'tag') {
    // The dist-tags answer is a few bytes. Azure Artifacts ignores npm's
    // abbreviated-metadata request, so a packument can be tens of MB.
    const tags = await getJson(distTagsUrl(registry.href, spec.name), opts, { accept: 'application/json', maxBytes: opts.maxBytes ?? DIST_TAGS_MAX_BYTES });
    if (tags.ok) {
      const body = tags.body;
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        const version = exactVersion(/** @type {Record<string, unknown>} */ (body)[kind.tag]);
        if (version) return { kind: 'resolved', version, via: 'dist-tags' };
      }
      // An answer without the tag: let the packument (what npm reads) decide.
    } else if (!endpointCannotAnswer(tags)) {
      // Network errors, 5xx, 408, 429, 401 and 403 come from the same feed over
      // the same link: the packument would answer the same way.
      return failure(tags);
    }
  }

  const doc = await fetchPackument(opts);
  if (!doc.ok) return failure(doc);
  const packument = /** @type {any} */ (doc.body);
  if (!packument || typeof packument !== 'object' || typeof packument.versions !== 'object') {
    return { kind: 'unavailable', detail: 'the packument has no versions' };
  }
  const latest = exactVersion(packument['dist-tags']?.latest);
  const picked = pickVersion(packument, wanted, {
    nodeVersion: opts.nodeVersion ?? process.version,
    npmVersion: opts.npmVersion,
    ...(opts.defaultTag ? { defaultTag: opts.defaultTag } : {}),
  });
  if (picked === undefined) return { kind: 'unsupported', detail: `cannot pick a version for ${JSON.stringify(wanted)} exactly like npm` };
  if (picked === null) {
    const what = kind.type === 'tag' ? `no dist-tag ${JSON.stringify(kind.tag)}` : `no version matching ${JSON.stringify(wanted || '*')}`;
    return { kind: 'no-match', detail: `${spec.name} has ${what} on this feed`, ...(latest ? { latest } : {}) };
  }
  const version = exactVersion(picked);
  if (!version) return { kind: 'unsupported', detail: `unusual version ${JSON.stringify(picked)}` };
  return { kind: 'resolved', version, via: 'packument' };
}

/**
 * The packument (registry metadata) of `spec.name`, with the token.
 *
 * @param {ResolveOptions} opts
 * @returns {Promise<FetchResult>}
 */
export function fetchPackument(opts) {
  return getJson(packumentUrl(opts.registry.href, opts.spec.name), opts, { accept: CORGI_ACCEPT, maxBytes: opts.maxBytes ?? PACKUMENT_MAX_BYTES });
}

/**
 * @typedef {object} TarballProbe
 * @property {boolean} ok           npm could download the tarball
 * @property {string} host          the feed host asked
 * @property {number} [status]      the feed's answer
 * @property {string} [redirectHost] where the feed sends the download (Azure Artifacts: blob storage)
 * @property {number} [blobStatus]  that host's answer to a request without credentials
 * @property {string} detail
 */

/**
 * Whether npm could download a tarball. Azure Artifacts answers with a
 * redirect to blob storage on another host (`*.vsblob.vsassets.io`), which a
 * proxy or firewall must allow too. Only the feed's own host and protocol get
 * the token. One byte is requested from each host.
 *
 * @param {{ url: string, registry: { href: string }, token?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 * @returns {Promise<TarballProbe>}
 */
export async function probeTarball({ url, registry, token, fetchImpl = fetch, timeoutMs = LOOKUP_TIMEOUT_MS }) {
  const feed = new URL(registry.href);
  let target;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, host: feed.host, detail: 'the tarball URL is not valid' };
  }
  if (target.protocol !== 'https:' && target.protocol !== feed.protocol) {
    return { ok: false, host: target.host, detail: `the tarball URL is not https (${target.protocol})` };
  }
  /** @param {URL} u */
  const isFeed = (u) => u.host === feed.host && u.protocol === feed.protocol;
  const withToken = isFeed(target);
  if (withToken && token && tlsChecksOff()) return { ok: false, host: target.host, detail: `not checked: ${TLS_OFF}` };
  /** @param {string} u @param {boolean} auth */
  const get = async (u, auth) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    try {
      /** @type {Record<string, string>} */
      const headers = { range: 'bytes=0-0', 'user-agent': 'ado-npm-exec' };
      if (auth && token) headers.authorization = `Bearer ${token}`;
      const res = await fetchImpl(u, { method: 'GET', redirect: 'manual', headers, signal: ac.signal });
      await res.body?.cancel().catch(() => {});
      return { status: res.status, location: res.headers.get('location') ?? undefined };
    } catch (error) {
      return { error: ac.signal.reason instanceof Error ? ac.signal.reason.message : /** @type {Error} */ (error)?.message || String(error) };
    } finally {
      clearTimeout(timer);
    }
  };
  const first = await get(target.href, withToken);
  if (first.error !== undefined) return { ok: false, host: target.host, detail: first.error };
  const status = /** @type {number} */ (first.status);
  if (status >= 300 && status < 400 && first.location) {
    let next;
    try {
      next = new URL(first.location, target);
    } catch {
      return { ok: false, host: target.host, status, detail: 'the redirect target is not a valid URL' };
    }
    if (isFeed(next) && token && tlsChecksOff()) return { ok: false, host: target.host, status, redirectHost: next.host, detail: `not checked: ${TLS_OFF}` };
    const blob = await get(next.href, isFeed(next));
    if (blob.error !== undefined) return { ok: false, host: target.host, status, redirectHost: next.host, detail: `${next.host}: ${blob.error}` };
    const blobStatus = /** @type {number} */ (blob.status);
    const ok = blobStatus === 200 || blobStatus === 206;
    return { ok, host: target.host, status, redirectHost: next.host, blobStatus, detail: `${next.host} answered HTTP ${blobStatus}` };
  }
  const ok = status === 200 || status === 206;
  return { ok, host: target.host, status, detail: `HTTP ${status}${withToken ? '' : ' (another host: no token sent)'}` };
}
