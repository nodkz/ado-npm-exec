import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, redact, addSecret } from '../src/log.js';
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
