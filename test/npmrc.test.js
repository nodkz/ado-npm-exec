import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderNpmrc, createTempNpmrc } from '../src/npmrc.js';
import { validateRegistryUrl } from '../src/registry.js';
import { validJwt } from '../fixtures/jwt.js';

const registry = validateRegistryUrl('https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/');

test('renders registry, scope registry and a path-scoped token', () => {
  const token = validJwt();
  assert.equal(
    renderNpmrc({ registry, token, scope: 'contoso' }),
    'registry=https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/\n' +
      '@contoso:registry=https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/\n' +
      `//pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/:_authToken=${token}\n`,
  );
  assert.doesNotMatch(renderNpmrc({ registry, token }), /@/);
});

test('refuses anything that could inject ini lines', () => {
  const token = validJwt();
  assert.throws(() => renderNpmrc({ registry, token: `${token}\n_auth=x` }), /not a JWT/);
  assert.throws(() => renderNpmrc({ registry, token: 'not-a-jwt' }), /not a JWT/);
  assert.throws(() => renderNpmrc({ registry: { ...registry, href: `${registry.href}\nx=y/` }, token }), /unsafe registry/);
  assert.throws(() => renderNpmrc({ registry: { ...registry, nerfDart: '//h/p;x/' }, token }), /unsafe registry/);
  assert.throws(() => renderNpmrc({ registry, token, scope: 'a\nb' }), /unsafe scope/);
});

test('creates a private temp dir and an exclusive 0600 file, and cleans up idempotently', () => {
  const t = createTempNpmrc('registry=x\n');
  try {
    assert.equal(path.basename(t.file), '.npmrc');
    assert.equal(path.dirname(t.file), t.dir);
    assert.ok(path.basename(t.dir).startsWith('ado-npm-exec-'));
    assert.equal(path.dirname(t.dir), os.tmpdir());
    assert.equal(fs.readFileSync(t.file, 'utf8'), 'registry=x\n');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(t.dir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(t.file).mode & 0o777, 0o600);
    }
  } finally {
    assert.equal(t.cleanup(), true);
  }
  assert.equal(fs.existsSync(t.dir), false);
  assert.equal(t.cleanup(), true);
});

test('honours a custom tmpdir and removes the dir if writing fails', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-npm-exec-test-'));
  try {
    const t = createTempNpmrc('a\n', { tmpdir: base });
    assert.equal(path.dirname(t.dir), base);
    t.cleanup();
    assert.throws(() => createTempNpmrc('a\n', { tmpdir: path.join(base, 'missing') }));
    assert.deepEqual(fs.readdirSync(base), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
