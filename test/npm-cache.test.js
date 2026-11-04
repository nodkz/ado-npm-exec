import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  contentPath,
  findCachedStart,
  installOrigin,
  isCached,
  isFromFeedOrg,
  isInstalledFromFeed,
  isReadyToStart,
  isSinglePackageNpxDir,
  npmCacheDir,
  npxInstallDir,
  packumentCacheKey,
  readNpxInstall,
} from '../src/npm-cache.js';
import { seedNpxInstall, seedPackument } from '../fixtures/npm-cache.js';

const FULL_ACCEPT = 'application/json';
import { makeTestRoot } from '../fixtures/sandbox.js';

const FEED = 'https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/';

test('npm cache folder: npm_config_cache, else npm\'s default', () => {
  assert.equal(npmCacheDir({ npm_config_cache: '/c/npm' }, { platform: 'linux' }), '/c/npm');
  assert.equal(npmCacheDir({ NPM_CONFIG_CACHE: '/c//npm/' }, { platform: 'linux' }), '/c/npm');
  assert.equal(npmCacheDir({ npm_config_cache: 'relative' }, { platform: 'linux', cwd: '/work' }), '/work/relative', 'relative to the current folder, like npm');
  assert.equal(npmCacheDir({ npm_config_cache: '~/c' }, { platform: 'linux', homedir: '/home/u' }), '/home/u/c');
  assert.equal(npmCacheDir({ HOME: '/home/u' }, { platform: 'darwin' }), '/home/u/.npm');
  assert.equal(npmCacheDir({}, { platform: 'linux', homedir: '' }), undefined, 'no home folder at all');
  assert.equal(typeof npmCacheDir({}, { platform: process.platform }), 'string', 'HOME unset: the OS home folder, like npm');
  assert.equal(npmCacheDir({ npm_config_cache: '~\\c' }, { platform: 'win32', homedir: 'C:\\Users\\u' }), 'C:\\Users\\u\\c');
  assert.equal(npmCacheDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, { platform: 'win32' }), 'C:\\Users\\u\\AppData\\Local\\npm-cache');
  assert.equal(npmCacheDir({ USERPROFILE: 'C:\\Users\\u' }, { platform: 'win32' }), 'C:\\Users\\u\\npm-cache');
});

test('the _npx folder is libnpmexec\'s hash of the package list', () => {
  const expected = crypto.createHash('sha512').update('@contoso/tool@1.2.3').digest('hex').slice(0, 16);
  assert.equal(npxInstallDir('/c', ['@contoso/tool@1.2.3']), path.join('/c', '_npx', expected));
  const two = crypto.createHash('sha512').update('a@1\nb@2').digest('hex').slice(0, 16);
  assert.equal(npxInstallDir('/c', ['b@2', 'a@1']), path.join('/c', '_npx', two));
});

test('an install counts only once npm wrote its hidden lockfile for that version', () => {
  const root = makeTestRoot('npm-cache-');
  try {
    const spec = '@contoso/tool@1.2.3';
    assert.deepEqual(readNpxInstall(root, spec, '@contoso/tool'), { dir: npxInstallDir(root, [spec]), exists: false, complete: false });
    seedNpxInstall(root, { spec, name: '@contoso/tool', version: '1.2.3', complete: false });
    assert.equal(readNpxInstall(root, spec, '@contoso/tool').complete, false, 'interrupted install');
    assert.equal(readNpxInstall(root, spec, '@contoso/tool').exists, true);
    seedNpxInstall(root, { spec, name: '@contoso/tool', version: '1.2.3' });
    assert.deepEqual(readNpxInstall(root, spec, '@contoso/tool'), {
      dir: npxInstallDir(root, [spec]),
      exists: true,
      complete: true,
      version: '1.2.3',
      resolved: `${FEED}@contoso/tool/-/tool-1.2.3.tgz`,
    });
    assert.equal(readNpxInstall(root, spec, '@contoso/other').complete, false, 'another package');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only single-package npm exec folders are recognized', () => {
  const root = makeTestRoot('npm-cache-');
  try {
    const one = seedNpxInstall(root, { spec: 'tool@1.0.0', name: 'tool', version: '1.0.0' });
    assert.equal(isSinglePackageNpxDir(one, 'tool'), true);
    const two = seedNpxInstall(root, { spec: 'tool@2.0.0', name: 'tool', version: '2.0.0', extraDeps: { other: '1' } });
    assert.equal(isSinglePackageNpxDir(two, 'tool'), false);
    assert.equal(isSinglePackageNpxDir(path.join(root, 'missing'), 'tool'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('packument cache keys and content paths match npm', () => {
  assert.equal(
    packumentCacheKey(FEED, '@contoso/tool'),
    'make-fetch-happen:request-cache:https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/@contoso%2ftool',
  );
  assert.equal(packumentCacheKey(FEED.slice(0, -1), 'tool'), `make-fetch-happen:request-cache:${FEED}tool`);
  const digest = crypto.createHash('sha512').update('x').digest('base64');
  const hex = Buffer.from(digest, 'base64').toString('hex');
  assert.equal(contentPath('/c', `sha512-${digest}`), path.join('/c', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)));
  const sha1 = crypto.createHash('sha1').update('x').digest('base64');
  assert.equal(contentPath('/c', `sha1-${sha1} sha512-${digest}`), contentPath('/c', `sha512-${digest}`), 'the strongest algorithm');
  assert.equal(contentPath('/c', 'garbage'), undefined);
});

test("isCached reads cacache like npm: the newest entry that answers npm exec's request wins, and its content must be there", () => {
  const root = makeTestRoot('npm-cache-');
  try {
    const key = packumentCacheKey(FEED, '@contoso/tool');
    assert.equal(isCached(root, key), false);
    const seeded = seedPackument(root, FEED, '@contoso/tool');
    assert.equal(isCached(root, key), true);
    fs.appendFileSync(seeded.bucket, '\nnot-a-hash\t{"key":"x"}\n');
    assert.equal(isCached(root, key), true, 'corrupt lines are skipped');
    seedPackument(root, FEED, '@contoso/tool', { deleted: true });
    assert.equal(isCached(root, key), true, 'npm skips an entry without content or status');
    seedPackument(root, FEED, '@contoso/tool', { content: 'full', accept: FULL_ACCEPT, writeContent: false });
    assert.equal(isCached(root, key), true, 'the full metadata answers another request: the short form still counts');
    const gone = seedPackument(root, FEED, '@contoso/tool', { content: 'third', writeContent: false });
    assert.equal(fs.existsSync(gone.contentFile), false);
    assert.equal(isCached(root, key), false, 'the newest matching entry has no content file');
    seedPackument(root, FEED, '@contoso/tool', { content: 'fourth', status: 410 });
    assert.equal(isCached(root, key), false, 'a cached answer other than 200');
    seedPackument(root, FEED, '@contoso/tool', { content: 'fifth', accept: 'application/vnd.npm.install-v1+json;q=1.0,application/json;q=0.8,*/*' });
    assert.equal(isCached(root, key), true, 'the same media types, written otherwise');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isCached: only the full metadata, or an entry for another host, is no answer for npm exec', () => {
  const root = makeTestRoot('npm-cache-');
  try {
    const key = packumentCacheKey(FEED, '@contoso/tool');
    const full = seedPackument(root, FEED, '@contoso/tool', { accept: FULL_ACCEPT });
    assert.equal(isCached(root, key), false, 'npm view or npm install cached the full form only');
    const entry = JSON.stringify({
      key,
      integrity: 'sha512-AAAA',
      size: 1,
      metadata: { url: 'x', reqHeaders: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*', host: 'proxy.example' }, options: { compress: true } },
    });
    fs.appendFileSync(full.bucket, `\n${crypto.createHash('sha1').update(entry).digest('hex')}\t${entry}`);
    assert.equal(isCached(root, key), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findCachedStart: an exact or last-resolved version that is ready, never a folder of the spec as written', () => {
  const root = makeTestRoot('npm-cache-');
  try {
    const registry = { href: FEED };
    const latest = { name: '@contoso/tool' };
    assert.equal(findCachedStart({ cacheDir: root, registry, spec: latest, state: { version: '1.0.0' } }), undefined, 'nothing cached');
    seedNpxInstall(root, { spec: '@contoso/tool@1.0.0', name: '@contoso/tool', version: '1.0.0' });
    assert.equal(findCachedStart({ cacheDir: root, registry, spec: latest, state: { version: '1.0.0' } }), undefined, 'metadata not cached');
    seedPackument(root, FEED, '@contoso/tool');
    assert.deepEqual(findCachedStart({ cacheDir: root, registry, spec: latest, state: { version: '1.0.0' } }), { runSpec: '@contoso/tool@1.0.0', version: '1.0.0' });
    assert.equal(findCachedStart({ cacheDir: root, registry, spec: latest, state: { version: '2.0.0' } }), undefined);
    seedNpxInstall(root, { spec: '@contoso/tool@latest', name: '@contoso/tool', version: '1.1.0' });
    assert.equal(findCachedStart({ cacheDir: root, registry, spec: latest, state: {} }), undefined, 'what a 1.x start of the spec as written installed never runs');
    assert.deepEqual(findCachedStart({ cacheDir: root, registry, spec: latest, exact: '1.0.0' }), { runSpec: '@contoso/tool@1.0.0', version: '1.0.0' });
    assert.equal(findCachedStart({ cacheDir: root, registry, spec: latest, exact: '3.0.0' }), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an install under a symlinked cache path is recognized (Arborist keys it through the real path)', { skip: process.platform === 'win32' }, () => {
  const root = makeTestRoot('npm-cache-');
  try {
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    const spec = 'semver@7.8.5';
    const dir = seedNpxInstall(link, { spec, name: 'semver', version: '7.8.5', complete: false });
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'));
    fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'tool'), '', { mode: 0o755 });
    const key = path.relative(dir, fs.realpathSync(path.join(dir, 'node_modules', 'semver')));
    assert.match(key, /^\.\.\//, 'what real npm writes on macOS');
    const nested = path.relative(dir, path.join(fs.realpathSync(dir), 'node_modules', 'other', 'node_modules', 'semver'));
    fs.writeFileSync(
      path.join(dir, 'node_modules', '.package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages: { [nested]: { version: '1.0.0' }, [key]: { version: '7.8.5' } } }),
    );
    assert.equal(readNpxInstall(link, spec, 'semver').complete, true);
    fs.writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { [nested]: { version: '7.8.5' } } }));
    assert.equal(readNpxInstall(link, spec, 'semver').complete, false, 'a nested package of the same name does not count');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isFromFeedOrg: the same Azure DevOps organization (either host name), else the same host', () => {
  const t = (/** @type {string} */ path) => `https://pkgs.dev.azure.com${path}`;
  assert.equal(isFromFeedOrg(FEED, t('/contoso/_packaging/feed/npm/registry/@contoso/tool/-/tool-1.0.0.tgz')), true);
  assert.equal(isFromFeedOrg(FEED, t('/Contoso/_packaging/00000000-1111/npm/registry/tool/-/tool-1.0.0.tgz')), true, 'the feed by id');
  assert.equal(isFromFeedOrg(FEED, 'https://contoso.pkgs.visualstudio.com/_packaging/feed/npm/registry/tool/-/tool-1.0.0.tgz'), true, 'the other host name');
  assert.equal(isFromFeedOrg(FEED, t('/fabrikam/_packaging/feed/npm/registry/tool/-/tool-1.0.0.tgz')), false, 'another organization');
  assert.equal(isFromFeedOrg(FEED, t('/')), false);
  assert.equal(isFromFeedOrg(FEED, 'https://registry.npmjs.org/tool/-/tool-1.0.0.tgz'), false);
  assert.equal(isFromFeedOrg(FEED, 'https://contoso.example.com/_packaging/feed/npm/registry/tool/-/tool-1.0.0.tgz'), false);
  assert.equal(isFromFeedOrg(FEED, 'http://pkgs.dev.azure.com/contoso/x.tgz'), false);
  assert.equal(isFromFeedOrg(FEED, 'https://pkgs.dev.azure.com:8443/contoso/x.tgz'), false);
  assert.equal(isFromFeedOrg(FEED, 'https://user:pw@pkgs.dev.azure.com/contoso/x.tgz'), false);
  assert.equal(isFromFeedOrg(FEED, undefined), false);
  assert.equal(isFromFeedOrg(FEED, 'not a url'), false);
  const vs = 'https://contoso.pkgs.visualstudio.com/_packaging/feed/npm/registry/';
  assert.equal(isFromFeedOrg(vs, 'https://contoso.pkgs.visualstudio.com/_packaging/1234/npm/registry/tool/-/tool-1.0.0.tgz'), true);
  assert.equal(isFromFeedOrg(vs, t('/contoso/_packaging/1234/npm/registry/tool/-/tool-1.0.0.tgz')), true);
  assert.equal(isFromFeedOrg(vs, 'https://fabrikam.pkgs.visualstudio.com/_packaging/feed/npm/registry/tool/-/tool-1.0.0.tgz'), false);
  const local = 'http://127.0.0.1:4873/feed/';
  assert.equal(isFromFeedOrg(local, 'http://127.0.0.1:4873/feed/tool/-/tool-1.0.0.tgz'), true);
  assert.equal(isFromFeedOrg(local, 'http://127.0.0.1:4874/feed/tool/-/tool-1.0.0.tgz'), false);
});

test('installOrigin names the host only', () => {
  const inst = { dir: 'x', exists: true, complete: true };
  assert.equal(installOrigin({ ...inst, resolved: 'https://registry.npmjs.org/tool/-/tool-1.0.0.tgz' }), 'registry.npmjs.org');
  assert.equal(installOrigin({ ...inst, resolved: 'file:../tool' }), 'an unknown registry');
  assert.equal(installOrigin({ ...inst, resolved: '::' }), 'an unknown registry');
  assert.equal(installOrigin(inst), 'an unknown registry');
});

test('findCachedStart never picks an install that came from another registry', () => {
  const root = makeTestRoot('npm-cache-');
  try {
    seedNpxInstall(root, { spec: '@contoso/tool@1.0.0', name: '@contoso/tool', version: '1.0.0', registry: 'https://registry.npmjs.org/' });
    seedPackument(root, FEED, '@contoso/tool');
    const spec = { raw: '@contoso/tool@1.0.0', name: '@contoso/tool' };
    assert.equal(findCachedStart({ cacheDir: root, registry: { href: FEED }, spec, exact: '1.0.0' }), undefined);
    assert.equal(readNpxInstall(root, spec.raw, spec.name).resolved, 'https://registry.npmjs.org/@contoso/tool/-/tool-1.0.0.tgz');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an install counts only with its command linked as npm runs it here, so npm cannot pick a same-name command from PATH', () => {
  const root = makeTestRoot('npm-cache-');
  try {
    const spec = '@contoso/tool@1.2.3';
    const dir = seedNpxInstall(root, { spec, name: '@contoso/tool', version: '1.2.3' });
    const bin = path.join(dir, 'node_modules', '.bin', 'tool');
    const posix = { platform: /** @type {NodeJS.Platform} */ ('linux') };
    const win = { platform: /** @type {NodeJS.Platform} */ ('win32') };
    for (const f of [bin, `${bin}.cmd`]) fs.rmSync(f, { force: true });
    assert.equal(readNpxInstall(root, spec, '@contoso/tool', posix).complete, false, 'installed with bin-links=false');
    fs.writeFileSync(`${bin}.cmd`, '');
    assert.equal(readNpxInstall(root, spec, '@contoso/tool', win).complete, true, 'Windows runs the .cmd shim');
    if (process.platform !== 'win32') {
      assert.equal(readNpxInstall(root, spec, '@contoso/tool', posix).complete, false, 'a .cmd file runs nothing here');
      fs.writeFileSync(bin, '', { mode: 0o644 });
      assert.equal(readNpxInstall(root, spec, '@contoso/tool', posix).complete, false, 'not executable');
      fs.chmodSync(bin, 0o755);
      assert.equal(readNpxInstall(root, spec, '@contoso/tool', posix).complete, true);
    }
    const here = process.platform === 'win32' ? win : posix;
    const run = path.join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'run.cmd' : 'run');

    const manifest = path.join(dir, 'node_modules', '@contoso', 'tool', 'package.json');
    fs.writeFileSync(manifest, JSON.stringify({ name: '@contoso/tool', version: '1.2.3', bin: 'cli.js' }));
    assert.equal(readNpxInstall(root, spec, '@contoso/tool', here).complete, true, 'a string bin is named after the package, without its scope');
    fs.writeFileSync(manifest, JSON.stringify({ name: '@contoso/tool', version: '1.2.3', bin: { 'nested/run': 'r.js' } }));
    assert.equal(readNpxInstall(root, spec, '@contoso/tool', here).complete, false, 'run is not linked');
    fs.writeFileSync(run, '', { mode: 0o755 });
    assert.equal(readNpxInstall(root, spec, '@contoso/tool', here).complete, true, 'keys are reduced to their base name');
    fs.writeFileSync(manifest, JSON.stringify({ name: '@contoso/tool', version: '1.2.3' }));
    assert.equal(readNpxInstall(root, spec, '@contoso/tool', here).complete, true, 'no command: nothing to link');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isReadyToStart: a usable install of that version from the feed, and its cached registry metadata', () => {
  const root = makeTestRoot('npm-cache-');
  try {
    const name = '@contoso/tool';
    seedNpxInstall(root, { spec: `${name}@1.2.3`, name, version: '1.2.3' });
    assert.equal(isReadyToStart(root, FEED, name, '1.2.3'), false, 'no registry metadata yet');
    assert.equal(isInstalledFromFeed(root, FEED, name, '1.2.3'), true);
    seedPackument(root, FEED, name);
    assert.equal(isReadyToStart(root, FEED, name, '1.2.3'), true);
    assert.equal(isReadyToStart(root, 'https://pkgs.dev.azure.com/fabrikam/_packaging/feed/npm/registry/', name, '1.2.3'), false, 'another organization');
    seedNpxInstall(root, { spec: `${name}@2.0.0`, name, version: '2.0.1' });
    assert.equal(isReadyToStart(root, FEED, name, '2.0.0'), false, 'the folder of 2.0.0 holds 2.0.1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
