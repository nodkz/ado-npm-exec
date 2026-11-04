import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distTagsUrl, fetchPackument, packumentUrl, probeTarball, resolveSpec } from '../src/resolve.js';
import { fakeFetch } from '../fixtures/fake-fetch.js';
import { validJwt } from '../fixtures/jwt.js';

const FEED = 'https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/';
const registry = { href: FEED };
const name = '@contoso/tool';
const TAGS = `${FEED}-/package/@contoso%2ftool/dist-tags`;
const DOC = `${FEED}@contoso%2ftool`;

/** @param {unknown} body @param {number} [status] */
const json = (body, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** @param {string} wanted */
const spec = (wanted) => ({ raw: wanted ? `${name}@${wanted}` : name, name, range: wanted || undefined });

/**
 * @param {string[]} versions
 * @param {Record<string, string>} distTags
 * @param {Record<string, object>} [extra]
 */
const doc = (versions, distTags, extra = {}) => ({
  name,
  'dist-tags': distTags,
  versions: Object.fromEntries(versions.map((v) => [v, { name, version: v, ...(extra[v] ?? {}) }])),
});

const KiB = 1024;
const MiB = 1024 * KiB;

/** @param {string} text @param {number} size bytes per chunk */
function chunked(text, size) {
  const bytes = new TextEncoder().encode(text);
  /** @type {Uint8Array[]} */
  const chunks = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
  return chunks;
}

/**
 * A route whose body arrives in `chunks`, and how much of it the stream gave out.
 *
 * @param {Uint8Array[]} chunks
 * @param {number} [status]
 */
function streamed(chunks, status = 200) {
  const seen = { bytes: 0, cancelled: false };
  const route = () => {
    let i = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (i === chunks.length) {
          controller.close();
          return;
        }
        seen.bytes += chunks[i].byteLength;
        controller.enqueue(chunks[i++]);
      },
      cancel() {
        seen.cancelled = true;
      },
    });
    return new Response(body, { status });
  };
  return { seen, route };
}

test('URLs: the scope slash is one encoded path segment', () => {
  assert.equal(distTagsUrl(FEED, name), TAGS);
  assert.equal(packumentUrl(FEED.slice(0, -1), 'tool'), `${FEED}tool`);
});

test('an exact version needs no request', async () => {
  const f = fakeFetch({});
  assert.deepEqual(await resolveSpec({ registry, spec: spec('1.2.3'), fetchImpl: f.impl }), { kind: 'resolved', version: '1.2.3', via: 'exact' });
  assert.deepEqual(await resolveSpec({ registry, spec: spec('v1.2.3'), fetchImpl: f.impl }), { kind: 'resolved', version: '1.2.3', via: 'exact' });
  assert.equal(f.calls.length, 0);
});

test('a dist-tag comes from the dist-tags endpoint, with the token and without following redirects', async () => {
  const token = validJwt();
  const f = fakeFetch({ [TAGS]: json({ latest: '1.2.3', next: '2.0.0-rc.1' }) });
  assert.deepEqual(await resolveSpec({ registry, spec: spec('latest'), token, fetchImpl: f.impl }), { kind: 'resolved', version: '1.2.3', via: 'dist-tags' });
  assert.deepEqual(await resolveSpec({ registry, spec: spec('next'), token, fetchImpl: f.impl }), { kind: 'resolved', version: '2.0.0-rc.1', via: 'dist-tags' });
  const [{ init }] = f.calls;
  const headers = /** @type {Record<string, string>} */ (init.headers);
  assert.equal(headers.authorization, `Bearer ${token}`);
  assert.equal(init.redirect, 'manual');
  assert.equal(f.calls.length, 2);
});

test('a tag the endpoint lacks is decided by the packument', async () => {
  const f = fakeFetch({ [TAGS]: json({ latest: '1.0.0' }), [DOC]: json(doc(['1.0.0', '1.1.0'], { latest: '1.0.0', beta: '1.1.0' })) });
  assert.deepEqual(await resolveSpec({ registry, spec: spec('beta'), fetchImpl: f.impl }), { kind: 'resolved', version: '1.1.0', via: 'packument' });
  const g = fakeFetch({ [TAGS]: json({ latest: '1.0.0' }), [DOC]: json(doc(['1.0.0'], { latest: '1.0.0' })) });
  const r = await resolveSpec({ registry, spec: spec('beta'), fetchImpl: g.impl });
  assert.equal(r.kind, 'no-match');
  assert.equal(r.kind === 'no-match' && r.latest, '1.0.0');
});

test('missing packages: 404 everywhere, or Azure Artifacts\' anonymous "No local versions" 401', async () => {
  const f = fakeFetch({});
  const r = await resolveSpec({ registry, spec: spec('latest'), fetchImpl: f.impl });
  assert.equal(r.kind, 'not-found');
  assert.deepEqual(f.calls.map((c) => c.url), [TAGS, DOC], 'a 404 from the endpoint alone proves nothing');
  const noLocal = { success: 'false', error: "No local versions of package '@contoso/tool'; please provide authentication to access versions from upstream that have not yet been saved to your feed." };
  const g = fakeFetch({ [TAGS]: json(noLocal, 401) });
  assert.equal((await resolveSpec({ registry, spec: spec('latest'), fetchImpl: g.impl })).kind, 'not-found');
  assert.equal(g.calls.length, 1);
});

test('a refused token is "refused", from the endpoint or the packument', async () => {
  for (const status of [401, 403]) {
    const f = fakeFetch({ [TAGS]: json({ message: 'TF400813: The user is not authorized to access this resource.' }, status) });
    const r = await resolveSpec({ registry, spec: spec('latest'), fetchImpl: f.impl });
    assert.equal(r.kind, 'refused');
    assert.match(r.kind === 'refused' ? r.detail : '', /TF400813/);
    assert.equal(f.calls.length, 1, 'the packument would answer the same');
  }
  const g = fakeFetch({ [DOC]: json({ message: 'denied' }, 403) });
  assert.equal((await resolveSpec({ registry, spec: spec('^1'), fetchImpl: g.impl })).kind, 'refused');
});

test('transient failures are "unavailable" and do not ask the packument over the same link', async () => {
  for (const route of [json({}, 500), json({}, 503), json({}, 429), json({}, 408), () => new Response(null, { status: 303, headers: { location: 'https://elsewhere.example/' } })]) {
    const f = fakeFetch({ [TAGS]: route });
    assert.equal((await resolveSpec({ registry, spec: spec('latest'), fetchImpl: f.impl })).kind, 'unavailable');
    assert.equal(f.calls.length, 1);
  }
  const down = await resolveSpec({
    registry,
    spec: spec('latest'),
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.deepEqual(down, { kind: 'unavailable', detail: 'fetch failed' });
  const hang = await resolveSpec({
    registry,
    spec: spec('latest'),
    timeoutMs: 50,
    fetchImpl: (_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  assert.deepEqual(hang, { kind: 'unavailable', detail: 'timed out after 50 ms' });
});

test('an endpoint the registry lacks (405, 501, HTML) defers to the packument', async () => {
  for (const route of [json({}, 405), json({}, 501), () => new Response('<html>hi</html>', { status: 200 })]) {
    const f = fakeFetch({ [TAGS]: route, [DOC]: json(doc(['1.0.0'], { latest: '1.0.0' })) });
    assert.deepEqual(await resolveSpec({ registry, spec: spec('latest'), fetchImpl: f.impl }), { kind: 'resolved', version: '1.0.0', via: 'packument' });
  }
});

test('ranges and bare names are picked from the packument like npm', async () => {
  const packument = doc(['1.0.0', '1.4.0', '1.5.0', '2.0.0'], { latest: '2.0.0' }, { '1.5.0': { deprecated: 'broken' }, '2.0.0': { engines: { node: '>=99' } } });
  const f = fakeFetch({ [DOC]: json(packument) });
  const opts = { registry, fetchImpl: f.impl, nodeVersion: 'v20.11.1', npmVersion: '11.0.0' };
  assert.deepEqual(await resolveSpec({ ...opts, spec: spec('^1.0.0') }), { kind: 'resolved', version: '1.4.0', via: 'packument' });
  assert.deepEqual(await resolveSpec({ ...opts, spec: spec('') }), { kind: 'resolved', version: '1.4.0', via: 'packument' }, 'latest needs a newer Node');
  const oldNpm = await resolveSpec({ ...opts, npmVersion: '10.2.4', spec: spec('') });
  assert.deepEqual(oldNpm, { kind: 'resolved', version: '2.0.0', via: 'packument' }, 'npm before 10.8.2 takes latest without checking engines');
  assert.equal((await resolveSpec({ ...opts, npmVersion: undefined, spec: spec('') })).kind, 'unsupported', 'unknown npm: npm decides');
  assert.equal((await resolveSpec({ ...opts, spec: spec('^3') })).kind, 'no-match');
  const accept = /** @type {Record<string, string>} */ (f.calls[0].init.headers).accept;
  assert.match(accept, /application\/vnd\.npm\.install-v1\+json/);
});

test('what cannot be decided exactly like npm is "unsupported"', async () => {
  const f = fakeFetch({ [DOC]: json(doc(['1.0.0'], { latest: '1.0.0' }, { '1.0.0': { engines: { node: '>= 20 <<< 30' } } })) });
  assert.equal((await resolveSpec({ registry, spec: spec('^1'), fetchImpl: f.impl })).kind, 'unsupported');
  assert.equal((await resolveSpec({ registry, spec: spec('01.2.3'), fetchImpl: f.impl })).kind, 'unsupported');
});

test('a body over the cap is not read', async () => {
  const f = fakeFetch({ [DOC]: () => new Response('x'.repeat(5000), { status: 200 }) });
  const r = await resolveSpec({ registry, spec: spec('^1'), fetchImpl: f.impl, maxBytes: 1000 });
  assert.equal(r.kind, 'unavailable');
  assert.match(r.kind === 'unavailable' ? r.detail : '', /larger than 1000 bytes/);
});

test('a dist-tags answer may have 1 MiB, a packument more', async () => {
  /** @param {number} size */
  const tags = (size) => {
    const text = JSON.stringify({ latest: '1.2.3' });
    return chunked(text + ' '.repeat(size - text.length), 64 * KiB);
  };
  const f = fakeFetch({ [TAGS]: streamed(tags(MiB)).route });
  assert.deepEqual(await resolveSpec({ registry, spec: spec('latest'), fetchImpl: f.impl }), { kind: 'resolved', version: '1.2.3', via: 'dist-tags' });

  const g = fakeFetch({ [TAGS]: streamed(tags(MiB + 1)).route });
  const r = await resolveSpec({ registry, spec: spec('latest'), fetchImpl: g.impl });
  assert.equal(r.kind, 'unavailable');
  assert.match(r.kind === 'unavailable' ? r.detail : '', /larger than 1048576 bytes/);
  const long = streamed(tags(4 * MiB));
  assert.equal((await resolveSpec({ registry, spec: spec('latest'), fetchImpl: fakeFetch({ [TAGS]: long.route }).impl })).kind, 'unavailable');
  assert.equal(long.seen.cancelled, true);
  assert.ok(long.seen.bytes < 2 * MiB, `the rest is not read (${long.seen.bytes} bytes)`);

  const big = JSON.stringify(doc(['1.0.0'], { latest: '1.0.0' })) + ' '.repeat(2 * MiB);
  const h = fakeFetch({ [DOC]: streamed(chunked(big, 64 * KiB)).route });
  assert.deepEqual(await resolveSpec({ registry, spec: spec('^1'), fetchImpl: h.impl }), { kind: 'resolved', version: '1.0.0', via: 'packument' });
});

test('a packument may have 64 MiB, in resolveSpec and in fetchPackument', async () => {
  // One chunk over the cap: it is refused before it is decoded.
  const huge = () => streamed([new Uint8Array(64 * MiB + 1), new Uint8Array(KiB)]);
  const first = huge();
  const r = await resolveSpec({ registry, spec: spec('^1'), fetchImpl: fakeFetch({ [DOC]: first.route }).impl });
  assert.match(r.kind === 'unavailable' ? r.detail : '', /larger than 67108864 bytes/);
  assert.equal(first.seen.cancelled, true);
  const second = huge();
  const d = await fetchPackument({ registry, spec: spec(''), fetchImpl: fakeFetch({ [DOC]: second.route }).impl });
  assert.match(d.ok ? '' : d.detail, /larger than 67108864 bytes/);
  assert.equal(second.seen.cancelled, true);
});

test('an error body is read up to 64 KiB, and its status stays the answer', async () => {
  const padding = 'x'.repeat(200 * KiB);
  for (const status of [401, 403]) {
    const body = streamed(chunked(`TF400813: The user is not authorized to access this resource.\n${padding}`, 4 * KiB), status);
    const f = fakeFetch({ [TAGS]: body.route });
    const r = await resolveSpec({ registry, spec: spec('latest'), fetchImpl: f.impl });
    assert.deepEqual(r, { kind: 'refused', status, detail: `HTTP ${status}: TF400813: The user is not authorized to access this resource.` });
    assert.equal(body.seen.cancelled, true);
    assert.ok(body.seen.bytes < 100 * KiB, `the rest is not read (${body.seen.bytes} bytes)`);
  }

  const noLocal = `{"success":"false","error":"No local versions of package '@contoso/tool'; please provide authentication to access versions from upstream that have not yet been saved to your feed.","padding":"${padding}"}`;
  const anonymous = streamed(chunked(noLocal, 4 * KiB), 401);
  const g = fakeFetch({ [TAGS]: anonymous.route });
  const r = await resolveSpec({ registry, spec: spec('latest'), fetchImpl: g.impl });
  assert.equal(r.kind, 'not-found');
  assert.equal(r.kind === 'not-found' && r.status, 401);
  assert.equal(g.calls.length, 1);
  assert.equal(anonymous.seen.cancelled, true);

  const page = streamed(chunked(`<html>${padding}</html>`, 4 * KiB), 401);
  const h = fakeFetch({ [DOC]: page.route });
  assert.deepEqual(await fetchPackument({ registry, spec: spec(''), fetchImpl: h.impl }), { ok: false, status: 401, detail: 'HTTP 401' });
});

test('a UTF-8 character split across chunks is decoded whole', async () => {
  const description = 'café, 5 €, 😀';
  const f = fakeFetch({ [DOC]: streamed(chunked(JSON.stringify({ ...doc(['1.0.0'], { latest: '1.0.0' }), description }), 1)).route });
  const r = await fetchPackument({ registry, spec: spec(''), fetchImpl: f.impl });
  assert.equal(r.ok && /** @type {{ description?: string }} */ (r.body).description, description);

  const message = 'Zugriff verweigert: Größe 😀';
  const g = fakeFetch({ [TAGS]: streamed(chunked(JSON.stringify({ message }), 1), 403).route });
  assert.deepEqual(await resolveSpec({ registry, spec: spec('latest'), fetchImpl: g.impl }), { kind: 'refused', status: 403, detail: `HTTP 403: ${message}` });
});

test('fetchPackument returns the document', async () => {
  const f = fakeFetch({ [DOC]: json(doc(['1.0.0'], { latest: '1.0.0' })) });
  const r = await fetchPackument({ registry, spec: spec(''), token: validJwt(), fetchImpl: f.impl });
  assert.equal(r.ok, true);
});

test('the tarball probe sends the token to the feed only, then asks blob storage without it', async () => {
  const token = validJwt();
  const tarball = `${FEED}@contoso/tool/-/tool-1.0.0.tgz`;
  const blob = 'https://vsblob.example.vsassets.io/b/x.blob?sig=secret';
  const f = fakeFetch({
    [tarball]: () => new Response(null, { status: 303, headers: { location: blob } }),
    [blob]: () => new Response('x', { status: 206 }),
  });
  const ok = await probeTarball({ url: tarball, registry, token, fetchImpl: f.impl });
  assert.deepEqual(ok, { ok: true, host: 'pkgs.dev.azure.com', status: 303, redirectHost: 'vsblob.example.vsassets.io', blobStatus: 206, detail: 'vsblob.example.vsassets.io answered HTTP 206' });
  const [first, second] = f.calls.map((c) => /** @type {Record<string, string>} */ (c.init.headers));
  assert.equal(first.authorization, `Bearer ${token}`);
  assert.equal(second.authorization, undefined);
  assert.equal(first.range, 'bytes=0-0');

  const blocked = fakeFetch({ [tarball]: () => new Response(null, { status: 303, headers: { location: blob } }), [blob]: () => new Response('', { status: 403 }) });
  const r = await probeTarball({ url: tarball, registry, token, fetchImpl: blocked.impl });
  assert.equal(r.ok, false);
  assert.equal(r.redirectHost, 'vsblob.example.vsassets.io');

  const other = fakeFetch({ 'https://cdn.example/x.tgz': () => new Response('x', { status: 200 }) });
  await probeTarball({ url: 'https://cdn.example/x.tgz', registry, token, fetchImpl: other.impl });
  assert.equal(/** @type {Record<string, string>} */ (other.calls[0].init.headers).authorization, undefined, 'another host never gets the token');

  const plain = await probeTarball({ url: 'http://pkgs.dev.azure.com/x.tgz', registry, token, fetchImpl: other.impl });
  assert.equal(plain.ok, false);
  assert.equal(other.calls.length, 1, 'no request over http');
});

test('a redirect to plain http on the feed host never gets the token', async () => {
  const token = validJwt();
  const tarball = `${FEED}@contoso/tool/-/tool-1.0.0.tgz`;
  const downgraded = 'http://pkgs.dev.azure.com/blob/x.tgz';
  const f = fakeFetch({
    [tarball]: () => new Response(null, { status: 302, headers: { location: downgraded } }),
    [downgraded]: () => new Response('x', { status: 200 }),
  });
  await probeTarball({ url: tarball, registry, token, fetchImpl: f.impl });
  assert.equal(f.calls.length, 2);
  assert.equal(/** @type {Record<string, string>} */ (f.calls[1].init.headers).authorization, undefined);
});

test('with certificate checks off, no request of ours carries the token', async () => {
  const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const f = fakeFetch({ [TAGS]: json({ latest: '1.0.0' }) });
    const r = await resolveSpec({ registry, spec: { raw: `${name}@latest`, name, range: 'latest' }, token: validJwt(), fetchImpl: f.impl });
    assert.equal(r.kind, 'unavailable');
    assert.match('detail' in r ? r.detail : '', /NODE_TLS_REJECT_UNAUTHORIZED=0/);
    assert.equal(f.calls.length, 0);
    const probe = await probeTarball({ url: `${FEED}@contoso/tool/-/tool-1.0.0.tgz`, registry, token: validJwt(), fetchImpl: f.impl });
    assert.equal(probe.ok, false);
    assert.match(probe.detail, /not checked/);
    assert.equal(f.calls.length, 0);
    const anonymous = await resolveSpec({ registry, spec: { raw: `${name}@latest`, name, range: 'latest' }, fetchImpl: f.impl });
    assert.equal(anonymous.kind, 'resolved', 'a request without the token is still made');
  } finally {
    if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved;
  }
});

test("npm's tag setting is the default tag of a pick; with its before setting npm picks, even an exact version", async () => {
  const doc = {
    name,
    'dist-tags': { latest: '1.0.0', beta: '2.0.0-beta.1' },
    versions: { '1.0.0': { name, version: '1.0.0' }, '2.0.0-beta.1': { name, version: '2.0.0-beta.1' } },
  };
  const f = fakeFetch({ [DOC]: json(doc) });
  const bare = { raw: name, name };
  assert.deepEqual(await resolveSpec({ registry, spec: bare, token: validJwt(), fetchImpl: f.impl }), { kind: 'resolved', version: '1.0.0', via: 'packument' });
  assert.deepEqual(await resolveSpec({ registry, spec: bare, token: validJwt(), fetchImpl: f.impl, defaultTag: 'beta' }), {
    kind: 'resolved',
    version: '2.0.0-beta.1',
    via: 'packument',
  });
  const calls = f.calls.length;
  const before = await resolveSpec({ registry, spec: bare, token: validJwt(), fetchImpl: f.impl, before: '2026-01-01' });
  assert.equal(before.kind, 'unsupported');
  for (const wanted of ['latest', '^1', '1.0.0']) {
    const r = await resolveSpec({ registry, spec: spec(wanted), token: validJwt(), fetchImpl: f.impl, before: '2026-01-01' });
    assert.equal(r.kind, 'unsupported', wanted);
  }
  assert.equal(f.calls.length, calls, 'no request: npm decides');
  // Without before, an exact version is resolved here, with no request.
  assert.deepEqual(await resolveSpec({ registry, spec: spec('1.0.0'), fetchImpl: f.impl }), { kind: 'resolved', version: '1.0.0', via: 'exact' });
  assert.equal(f.calls.length, calls);
});
