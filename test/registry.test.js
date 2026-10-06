import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { validateRegistryUrl, parseSpec, RegistryError, SpecError, ADO_RESOURCE_ID } from '../src/registry.js';
import { resolveNpm } from '../src/npm-cli.js';

test('ADO resource id is the public Azure DevOps application id', () => {
  assert.equal(ADO_RESOURCE_ID, '499b84ac-1321-427f-aa17-267ca6975798');
});

test('accepts pkgs.dev.azure.com org and project feeds', () => {
  const org = validateRegistryUrl('https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/');
  assert.deepEqual(org, {
    href: 'https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/',
    host: 'pkgs.dev.azure.com',
    pathname: '/contoso/_packaging/feed/npm/registry/',
    nerfDart: '//pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/',
    org: 'contoso',
  });
  const project = validateRegistryUrl('https://pkgs.dev.azure.com/contoso/My%20Project/_packaging/my.feed@Release/npm/registry');
  assert.equal(project.href, 'https://pkgs.dev.azure.com/contoso/My%20Project/_packaging/my.feed@Release/npm/registry/');
  assert.equal(project.nerfDart, '//pkgs.dev.azure.com/contoso/My%20Project/_packaging/my.feed@Release/npm/registry/');
});

test('accepts <org>.pkgs.visualstudio.com feeds and normalizes case', () => {
  const r = validateRegistryUrl('HTTPS://Contoso.PKGS.VisualStudio.com/_packaging/feed/npm/registry/');
  assert.equal(r.href, 'https://contoso.pkgs.visualstudio.com/_packaging/feed/npm/registry/');
  assert.equal(r.org, 'contoso');
  const p = validateRegistryUrl('https://contoso.pkgs.visualstudio.com/proj-1/_packaging/feed/npm/registry/');
  assert.equal(p.pathname, '/proj-1/_packaging/feed/npm/registry/');
});

const rejected = {
  'http scheme': 'http://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/',
  'other host': 'https://registry.npmjs.org/',
  'lookalike suffix': 'https://pkgs.dev.azure.com.evil.example/contoso/_packaging/feed/npm/registry/',
  'lookalike prefix': 'https://evilpkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/',
  'visualstudio without org': 'https://pkgs.visualstudio.com/_packaging/feed/npm/registry/',
  'nested visualstudio subdomain': 'https://a.b.pkgs.visualstudio.com/_packaging/feed/npm/registry/',
  'trailing dot host': 'https://pkgs.dev.azure.com./contoso/_packaging/feed/npm/registry/',
  userinfo: 'https://user:pw@pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/',
  'user only': 'https://user@pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/',
  'explicit port': 'https://pkgs.dev.azure.com:443/contoso/_packaging/feed/npm/registry/',
  query: 'https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/?x=1',
  'empty query': 'https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/?',
  fragment: 'https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/#x',
  'encoded dot': 'https://pkgs.dev.azure.com/contoso/%2e%2e/_packaging/feed/npm/registry/',
  'encoded slash': 'https://pkgs.dev.azure.com/contoso/a%2Fb/_packaging/feed/npm/registry/',
  'dot dot segment': 'https://pkgs.dev.azure.com/contoso/x/../_packaging/feed/npm/registry/',
  'dot segment': 'https://pkgs.dev.azure.com/contoso/./_packaging/feed/npm/registry/',
  semicolon: 'https://pkgs.dev.azure.com/contoso/_packaging/fe;ed/npm/registry/',
  backslash: 'https://pkgs.dev.azure.com\\contoso/_packaging/feed/npm/registry/',
  'literal space': 'https://pkgs.dev.azure.com/contoso/My Project/_packaging/feed/npm/registry/',
  newline: 'https://pkgs.dev.azure.com/contoso/_packaging/fe\ned/npm/registry/',
  tab: 'https://pkgs.dev.azure.com/contoso/_packaging/fe\ted/npm/registry/',
  'not a feed path': 'https://pkgs.dev.azure.com/contoso/_apis/projects/',
  'nuget feed': 'https://pkgs.dev.azure.com/contoso/_packaging/feed/nuget/v3/index.json',
  'too many segments': 'https://pkgs.dev.azure.com/a/b/c/_packaging/feed/npm/registry/',
  'missing org': 'https://pkgs.dev.azure.com/_packaging/feed/npm/registry/',
  'extra tail': 'https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/@scope%2fpkg',
  'ini injection': 'https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/\n_authToken=x',
  empty: '',
};

for (const [name, url] of Object.entries(rejected)) {
  test(`rejects ${name}`, () => {
    assert.throws(() => validateRegistryUrl(url), RegistryError);
  });
}

test('rejects non-string input', () => {
  assert.throws(() => validateRegistryUrl(undefined), RegistryError);
});

test('parseSpec accepts registry specs', () => {
  assert.deepEqual(parseSpec('@contoso/tool@latest'), {
    raw: '@contoso/tool@latest',
    name: '@contoso/tool',
    scope: 'contoso',
    range: 'latest',
  });
  assert.deepEqual(parseSpec('tool'), { raw: 'tool', name: 'tool', scope: undefined, range: undefined });
  assert.equal(parseSpec('@contoso/tool@1.2.3').range, '1.2.3');
  assert.equal(parseSpec('@contoso/tool@^1.2.0').range, '^1.2.0');
  assert.equal(parseSpec('tool@>=1.0.0 <2').range, '>=1.0.0 <2');
  assert.equal(parseSpec('@contoso/tool.js@next').name, '@contoso/tool.js');
});

for (const bad of [
  'https://example.com/x.tgz',
  'git+https://example.com/repo.git',
  'github:contoso/tool',
  'contoso/tool',
  './local',
  '../local',
  '/abs/path',
  'file:../x',
  'alias@npm:@contoso/tool@1',
  '@contoso/tool@',
  '@contoso/tool@ ',
  '@Contoso/tool',
  '.hidden',
  '_private',
  '@/tool',
  '@contoso/',
  'tool\n',
  'x'.repeat(300),
]) {
  test(`parseSpec rejects ${JSON.stringify(bad).slice(0, 40)}`, () => {
    assert.throws(() => parseSpec(bad), SpecError);
  });
}

for (const bad of ['tool@.', '@contoso/tool@..', 'tool@.1', 'tool@.x', 'tool@payload.tgz', 'tool@x.tar', 'tool@x.TAR.GZ']) {
  test(`parseSpec rejects local-path suffix ${bad}`, () => {
    assert.throws(() => parseSpec(bad), /looks like a local path|invalid package spec/);
  });
}

// Every spec we accept must be a registry spec for npm itself.
const npm = resolveNpm({ env: process.env });
test('accepted specs are registry specs for npm-package-arg', { skip: npm ? false : 'npm not found' }, () => {
  assert.ok(npm);
  const require = createRequire(npm.cli);
  const npa = require(path.join(path.dirname(path.dirname(npm.cli)), 'node_modules', 'npm-package-arg'));
  const corpus = [
    'tool', 'tool@latest', 'tool@next', 'tool@1.2.3', 'tool@^1.2.0', 'tool@~1.2', 'tool@1.x', 'tool@*', 'tool@>=1 <2',
    'tool@1 || 2', 'tool@1.0.0-beta.1', 'tool@1.0.0+build.5', '@contoso/tool', '@contoso/tool@latest', '@contoso/my.tool@=1.0.0',
    'tool@.', 'tool@..', 'tool@.1', 'tool@a.tgz', 'tool@a.tar', 'tool@a.tar.gz', 'tool@~/x', 'tool@/x', 'tool@C:x', 'tool@file:x',
    'tool@npm:other', 'tool@git+https://x', 'tool@github:a/b', 'tool@https://x', 'tool@a/b', 'tool@a#b', '~tool', '.tool', '-tool',
    'tool@', 'tool@ ', 'tool@-1', 'tool@v1', 'tool@=1', 'tool@<1', 'tool@1.2.3 - 2.3.4', 'tool@x.tgz.bak', 'tool@1.tgz1',
  ];
  let accepted = 0;
  for (const raw of corpus) {
    let ok = false;
    try {
      parseSpec(raw);
      ok = true;
    } catch {
      // rejected
    }
    if (!ok) continue;
    accepted++;
    const parsed = npa(raw);
    assert.equal(parsed.registry, true, `${raw} is accepted but npm treats it as ${parsed.type}`);
  }
  assert.ok(accepted >= 15, `accepted ${accepted}`);
});
