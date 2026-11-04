import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, redact, addSecret, maskUrlCredentials } from '../src/log.js';
import { validJwt } from '../fixtures/jwt.js';

test('redacts JWTs, auth headers, npmrc credentials and registered secrets', () => {
  const jwt = validJwt();
  assert.doesNotMatch(redact(`token ${jwt} end`), /eyJ/);
  assert.equal(redact('Authorization: Bearer abcdefghijkl'), 'Authorization: Bearer <redacted>');
  assert.equal(redact('Basic OmFiY2RlZmdoaWprbA=='), 'Basic <redacted>');
  assert.equal(redact('//host/path/:_authToken=abc'), '//host/path/:_authToken=<redacted>');
  addSecret('super-secret-value');
  assert.equal(redact('x super-secret-value y'), 'x <redacted> y');
});

test('logger writes prefixed lines and only debugs when verbose', () => {
  /** @type {string[]} */
  const lines = [];
  const quiet = createLogger({ write: (s) => lines.push(s) });
  quiet.debug('hidden');
  quiet.error(`failed with ${validJwt()}`);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ado-npm-exec: failed with <redacted-jwt>\n$/);
  const loud = createLogger({ verbose: true, write: (s) => lines.push(s) });
  loud.debug('shown');
  assert.equal(lines[1], 'ado-npm-exec: shown\n');
});

test('masks the userinfo of a URL up to the last "@", with or without a scheme', () => {
  const feed = 'pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/';
  assert.equal(redact(`GET https://user:fake-pass@${feed} failed`), `GET https://<credentials>@${feed} failed`);
  assert.equal(redact(`GET http://fake-token@${feed}`), `GET http://<credentials>@${feed}`);
  assert.equal(redact('proxy http://user:fake@pass@proxy.example:8080 is set'), 'proxy http://<credentials>@proxy.example:8080 is set');
  assert.equal(redact('//user:fake-pass@host.example/path'), '//<credentials>@host.example/path');
  assert.equal(redact('"https://u:fake@host.example", \'//u:fake@host.example\''), '"https://<credentials>@host.example", \'//<credentials>@host.example\'');
  assert.equal(redact('https://<credentials>@host.example/'), 'https://<credentials>@host.example/', 'masking twice changes nothing');
  assert.equal(maskUrlCredentials('a https://u:fake-pass@host.example b'), 'a https://<credentials>@host.example b');
});

test('leaves package specs, e-mail addresses and npmrc keys alone', () => {
  for (const text of [
    'installing @contoso/tool@1.2.3 and tool@latest',
    'signed in as dev@contoso.com, see https://pkgs.dev.azure.com/contoso/',
    'npm config set //pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/:_authToken=',
    'GET https://pkgs.dev.azure.com/contoso/_packaging/feed@Release/npm/registry/@contoso%2ftool',
  ]) {
    assert.equal(maskUrlCredentials(text), text);
    assert.equal(redact(text), text);
  }
});

test('masks the value of query parameters named like a credential, and only those', () => {
  assert.equal(
    redact('GET https://blob.example/x?sv=2024&sig=fake-sig&se=2030 ok'),
    'GET https://blob.example/x?sv=2024&sig=<redacted>&se=2030 ok',
  );
  assert.equal(redact('"https://host.example/?Token=fake-token" next'), '"https://host.example/?Token=<redacted>" next');
  assert.equal(redact('https://host.example/cb#access_token=fake-token&state=s1'), 'https://host.example/cb#access_token=<redacted>&state=s1');
  const names = ['token', 'access_token', 'auth', 'password', 'pass', 'pwd', 'secret', 'key', 'sig', 'signature', 'code'];
  const query = (/** @type {string} */ value) => `https://host.example/x?${names.map((n) => `${n}=${value}`).join('&')}`;
  assert.equal(maskUrlCredentials(query('fake')), query('<redacted>'));
  const kept = 'https://host.example/x?api-version=7.1&view=Release&response_type=code&tokens=2&keyword=fake';
  assert.equal(maskUrlCredentials(kept), kept);
  assert.equal(redact(kept), kept);
});

test('the logger masks URL credentials', () => {
  /** @type {string[]} */
  const lines = [];
  createLogger({ write: (s) => lines.push(s) }).error('refusing https://user:fake-pass@host.example/x?token=fake-token');
  assert.deepEqual(lines, ['ado-npm-exec: refusing https://<credentials>@host.example/x?token=<redacted>\n']);
});
