import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, UsageError } from '../src/args.js';

const FEED = 'https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/';

test('--registry form with -- separator and passthrough args', () => {
  const r = parseArgs(['--registry', FEED, '--', '@contoso/tool@latest', 'serve', '--port', '1']);
  assert.equal(r.registry, FEED);
  assert.equal(r.spec, '@contoso/tool@latest');
  assert.deepEqual(r.args, ['serve', '--port', '1']);
});

test('--registry=value form without --', () => {
  const r = parseArgs([`--registry=${FEED}`, 'tool', '-x']);
  assert.equal(r.registry, FEED);
  assert.equal(r.spec, 'tool');
  assert.deepEqual(r.args, ['-x']);
});

test('positional form', () => {
  const r = parseArgs([FEED, '@contoso/tool', '--help', '--', 'x']);
  assert.equal(r.registry, FEED);
  assert.equal(r.spec, '@contoso/tool');
  assert.deepEqual(r.args, ['--help', '--', 'x'], 'flags after the spec belong to the package');
  assert.equal(r.help, false);
});

test('positional form after -- separator', () => {
  const r = parseArgs(['--verbose', '--', FEED, 'tool']);
  assert.equal(r.verbose, true);
  assert.equal(r.registry, FEED);
  assert.equal(r.spec, 'tool');
});

test('--tenant and --verbose are parsed before the spec', () => {
  const r = parseArgs(['--verbose', '--tenant', 'abc', '--registry', FEED, 'tool']);
  assert.equal(r.verbose, true);
  assert.equal(r.tenant, 'abc');
  const r2 = parseArgs(['--tenant=def', FEED, 'tool']);
  assert.equal(r2.tenant, 'def');
});

test('help and version short-circuit', () => {
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--help', 'whatever']).help, true);
  assert.equal(parseArgs(['-v']).version, true);
  assert.equal(parseArgs(['--version']).version, true);
});

test('usage errors', () => {
  assert.throws(() => parseArgs([]), UsageError);
  assert.throws(() => parseArgs([FEED]), /missing package spec/);
  assert.throws(() => parseArgs(['--registry', FEED]), /missing package spec/);
  assert.throws(() => parseArgs(['--registry', FEED, '--']), /missing package spec/);
  assert.throws(() => parseArgs(['--registry']), /requires a value/);
  assert.throws(() => parseArgs(['--registry', '--', 'x']), /requires a value/);
  assert.throws(() => parseArgs(['--nope', FEED, 'x']), /unknown option --nope/);
  assert.throws(() => parseArgs(['--verbose=1', FEED, 'x']), /does not take a value/);
});

test('--always-fresh, --fresh and the offline fallback switches', () => {
  assert.equal(parseArgs(['--always-fresh', FEED, 'tool']).alwaysFresh, true);
  assert.equal(parseArgs(['--fresh', FEED, 'tool']).alwaysFresh, true);
  assert.equal(parseArgs([FEED, 'tool', '--fresh']).alwaysFresh, false, 'after the spec it belongs to the package');
  assert.equal(parseArgs([FEED, 'tool']).offlineFallback, undefined);
  assert.equal(parseArgs(['--no-offline-fallback', FEED, 'tool']).offlineFallback, false);
  assert.equal(parseArgs(['--offline-fallback', FEED, 'tool']).offlineFallback, true);
  assert.throws(() => parseArgs(['--fresh=1', FEED, 'tool']), /does not take a value/);
});

test('actions: --login, --prewarm and --doctor', () => {
  const login = parseArgs(['--login', '--tenant', 'abc', FEED]);
  assert.equal(login.action, 'login');
  assert.equal(login.registry, FEED);
  assert.equal(login.spec, undefined);
  assert.throws(() => parseArgs(['--login']), /missing feed URL/);
  assert.throws(() => parseArgs(['--login', FEED, 'tool']), /only the feed URL/);

  const prewarm = parseArgs(['--prewarm', FEED, '@contoso/a@latest', '@contoso/b@^1']);
  assert.equal(prewarm.action, 'prewarm');
  assert.equal(prewarm.spec, '@contoso/a@latest');
  assert.deepEqual(prewarm.args, ['@contoso/b@^1']);
  assert.throws(() => parseArgs(['--prewarm', FEED]), /missing package spec/);

  assert.deepEqual(
    [parseArgs(['--doctor']).registry, parseArgs(['--doctor']).spec],
    [undefined, undefined],
  );
  const doctor = parseArgs(['--doctor', FEED, '@contoso/a']);
  assert.equal(doctor.action, 'doctor');
  assert.equal(doctor.registry, FEED);
  assert.equal(doctor.spec, '@contoso/a');
  assert.equal(parseArgs(['--doctor', '--registry', FEED, 'x']).spec, 'x');
  assert.throws(() => parseArgs(['--doctor', FEED, 'a', 'b']), /at most/);
  assert.throws(() => parseArgs(['--doctor', '--login', FEED]), /cannot be combined/);
});
