import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPublish, compareVersions, writeOutputs } from '../scripts/publish-check.mjs';

/**
 * @param {number} status
 * @param {unknown} [body]
 * @param {string[]} [urls]
 * @returns {typeof fetch}
 */
function registry(status, body, urls = []) {
  return async (url) => {
    urls.push(String(url));
    return new Response(body === undefined ? 'not found' : JSON.stringify(body), { status });
  };
}

const doc = {
  'dist-tags': { latest: '1.2.0', next: '2.0.0-beta.1' },
  versions: { '1.0.0': {}, '1.2.0': {}, '2.0.0-beta.1': {} },
  time: { '1.0.0': 't', '1.1.0': 't', '1.2.0': 't', '2.0.0-beta.1': 't' },
};

test('compareVersions follows semver precedence', () => {
  const ordered = ['0.0.1', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.10.0', '2.0.0'];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.ok(compareVersions(ordered[i], ordered[i + 1]) < 0, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.ok(compareVersions(ordered[i + 1], ordered[i]) > 0, `${ordered[i + 1]} > ${ordered[i]}`);
  }
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0'), 0);
  assert.throws(() => compareVersions('1.0', '1.0.0'), /semver/);
});

test('a package that is not on npm yet is a first publish', async () => {
  /** @type {string[]} */
  const urls = [];
  const d = await checkPublish({ name: 'ado-npm-exec', version: '0.0.1', fetchImpl: registry(404, undefined, urls) });
  assert.deepEqual(d, { publish: true, version: '0.0.1', tag: 'latest', first: true, reason: 'ado-npm-exec is not on the registry yet' });
  assert.deepEqual(urls, ['https://registry.npmjs.org/ado-npm-exec']);
});

test('an already published version is skipped', async () => {
  const d = await checkPublish({ name: 'x', version: '1.2.0', fetchImpl: registry(200, doc) });
  assert.equal(d.publish, false);
  assert.match(d.reason, /already published/);
});

test('a new higher version is published as latest', async () => {
  const d = await checkPublish({ name: 'x', version: '1.3.0', fetchImpl: registry(200, doc) });
  assert.deepEqual({ publish: d.publish, tag: d.tag, first: d.first }, { publish: true, tag: 'latest', first: false });
});

test('a prerelease goes to the next dist-tag', async () => {
  const d = await checkPublish({ name: 'x', version: '2.0.0-beta.2', fetchImpl: registry(200, doc) });
  assert.deepEqual({ publish: d.publish, tag: d.tag }, { publish: true, tag: 'next' });
  const lowerPre = await checkPublish({ name: 'x', version: '1.0.0-rc.1', fetchImpl: registry(200, doc) });
  assert.equal(lowerPre.tag, 'next');
});

test('refuses versions npm would reject or that would move latest backwards', async () => {
  await assert.rejects(checkPublish({ name: 'x', version: '1.1.0', fetchImpl: registry(200, doc) }), /unpublished before/);
  await assert.rejects(checkPublish({ name: 'x', version: '1.0.5', fetchImpl: registry(200, doc) }), /lower than the latest published 1\.2\.0/);
  await assert.rejects(checkPublish({ name: 'x', version: 'v1.3.0', fetchImpl: registry(200, doc) }), /not a valid semver/);
  await assert.rejects(checkPublish({ name: 'x', version: '1.3.0', fetchImpl: registry(500, {}) }), /registry answered 500/);
});

test('scoped names and custom registries are addressed correctly', async () => {
  /** @type {string[]} */
  const urls = [];
  await checkPublish({ name: '@contoso/tool', version: '1.0.0', registry: 'https://registry.example/npm', fetchImpl: registry(404, undefined, urls) });
  assert.deepEqual(urls, ['https://registry.example/npm/@contoso%2ftool']);
});

test('writeOutputs appends GitHub Actions outputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-npm-exec-test-'));
  try {
    const file = path.join(dir, 'out');
    writeOutputs({ publish: true, version: '0.0.1', tag: 'latest', first: true, reason: '' }, file);
    assert.equal(fs.readFileSync(file, 'utf8'), 'publish=true\nversion=0.0.1\ntag=latest\nfirst=true\n');
    writeOutputs({ publish: false, version: '0.0.1', tag: 'latest', first: false, reason: '' }, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
