import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { classifyWanted, compareVersions, parseRange, parseVersion, pickVersion, satisfies } from '../src/semver.js';
import { resolveNpm } from '../src/npm-cli.js';

/** Seeded PRNG (mulberry32) so generated cases are reproducible. @param {number} seed */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @template T @param {() => number} rand @param {readonly T[]} list @returns {T} */
const pick = (rand, list) => list[Math.floor(rand() * list.length)];

test('parseVersion parses strict SemVer 2.0.0', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [], build: [], version: '1.2.3' });
  assert.deepEqual(parseVersion('  v1.2.3-beta.10.0a.x-y+build.007  '), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: ['beta', 10, '0a', 'x-y'],
    build: ['build', '007'],
    version: '1.2.3-beta.10.0a.x-y',
  });
  assert.equal(parseVersion('0.0.0-0')?.version, '0.0.0-0');
  assert.equal(parseVersion('1.2.3--')?.version, '1.2.3--');
  assert.equal(parseVersion('9007199254740991.0.0')?.major, 9007199254740991);
  // Like node-semver, numeric prerelease identifiers that are not safe integers stay strings.
  assert.deepEqual(parseVersion('1.0.0-9007199254740991.9007199254740990')?.prerelease, ['9007199254740991', 9007199254740990]);
});

test('parseVersion rejects what node-semver rejects in strict mode', () => {
  const invalid = [
    '', ' ', '1', '1.2', '1.2.3.4', '01.2.3', '1.02.3', '1.2.03', '1.2.3-01', '1.2.3-', '1.2.3+', '1.2.3-beta..1', '=1.2.3',
    'vv1.2.3', 'V1.2.3', 'v 1.2.3', '1.2.3beta', '1.2.3 -beta', '-1.2.3', '1.2.-3', 'x.1.2', '1.2.x', '1.2.3_4', '9007199254740992.0.0',
    '1.9007199254740992.0', '1.2.99999999999999999999', 'latest', '^1.2.3', '>=1.2.3',
  ];
  for (const input of invalid) assert.equal(parseVersion(input), undefined, input);
  for (const input of [undefined, null, 1, {}, ['1.2.3']]) assert.equal(parseVersion(input), undefined);
});

test('parseVersion caps the raw input at 256 characters', () => {
  const long = `1.2.3-${'a'.repeat(250)}`;
  assert.equal(long.length, 256);
  assert.equal(parseVersion(long)?.version, long);
  assert.equal(parseVersion(`${long}b`), undefined);
  assert.equal(parseVersion(` ${long}`), undefined, 'the cap applies before trimming, like node-semver');
});

test('parsed versions are frozen and accepted wherever a version is', () => {
  const v = parseVersion('1.2.3-beta');
  assert.ok(v);
  assert.ok(Object.isFrozen(v) && Object.isFrozen(v.prerelease) && Object.isFrozen(v.build));
  assert.equal(parseVersion(v), v);
  assert.equal(compareVersions(v, '1.2.3'), -1);
  assert.equal(satisfies(v, '^1.2.3-alpha'), true);
});

test('compareVersions follows SemVer precedence', () => {
  const ordered = [
    '0.0.0-0', '0.0.0', '0.9.9', '1.0.0-0', '1.0.0-1', '1.0.0-2', '1.0.0-10', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta',
    '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '1.10.0', '2.0.0', '10.0.0',
  ];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      assert.equal(compareVersions(ordered[i], ordered[j]), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
    }
  }
  assert.equal(compareVersions('1.2.3+a', '1.2.3+b'), 0, 'build metadata is ignored');
  assert.equal(compareVersions('v1.2.3', ' 1.2.3 '), 0);
  assert.throws(() => compareVersions('1.2', '1.2.3'), TypeError);
  assert.throws(() => compareVersions('1.2.3', 'latest'), TypeError);
});

test('parseRange accepts the node-semver range syntax', () => {
  const accepted = [
    '', ' ', '*', 'x', 'X', 'x.x.x', '||', '1', '1.2', '1.x', '1.2.x', '1.2.*', '>1', '<=1.2', '>=1.x', '<1.2.3', '>= 1.2.3', '= 1.2.3',
    '=v1.2.3', 'v1.2.3', '~1', '~> 1.2', '~1.2.3-beta.2', '^0.0.3', '^0.2.x', '^1.2.3-pre', '^ 1', '1.2.3 - 2', '1 - 2.3',
    '* - 1', 'v1 - v2.0.0', '>=1.2 <1.4 || 3.x', '1.2.x || >=3.0.0-rc.1 <3.0.1', '>*', '<0.0.0-0', '\t>=1.0.0\n<2 ',
  ];
  for (const r of accepted) assert.ok(parseRange(r), JSON.stringify(r));
  assert.equal(parseRange('  >=  1.2.3 \t <2  ||  ^3 ')?.raw, '>= 1.2.3 <2 || ^3');
});

test('parseRange rejects invalid and unsupported ranges', () => {
  const rejected = [
    '>>1', '1.2.3.4', '^^1', 'latest', 'abc', '1 -2', '1- 2', '1 - 2 - 3', '- 1', '>=', '~', '=>1', '==1.2.3', 'v 1.2.3', 'v=1.2.3',
    '1 | 2', '1 ||| 2', '01', '1.2.3-01', '>9007199254740991', '<=9007199254740991', '9007199254740991.x', '~1.9007199254740991',
    // Valid for node-semver, deliberately unsupported (some releases disagree, or the syntax is exotic):
    'x.1', '1.x.2', '^x.1', '1.2+build', '>=1.2.3+build', '1.2.x-beta', '^=1.2.3', 'v=1.2', '==1', '> =1.2.3', '~>=1.2.3',
    '1.2.3 - =2', `>=1.0.0 ${'<2.0.0 '.repeat(43)}`,
  ];
  for (const r of rejected) assert.equal(parseRange(r), undefined, JSON.stringify(r));
  for (const r of [undefined, null, 1, {}]) assert.equal(parseRange(r), undefined);
});

test('satisfies desugars ranges like node-semver', () => {
  /** @type {[string, string[], string[]][]} */
  const cases = [
    ['', ['0.0.0', '1.2.3', '99.0.0'], ['1.2.3-beta']],
    ['*', ['0.0.0', '1.2.3'], ['1.0.0-rc.1']],
    ['1.x', ['1.0.0', '1.9.9'], ['0.9.9', '2.0.0', '1.5.0-beta']],
    ['>1', ['2.0.0'], ['1.9.9', '2.0.0-0']],
    ['>1.2', ['1.3.0'], ['1.2.9']],
    ['<=1.2', ['1.2.9', '0.0.0'], ['1.3.0', '1.3.0-0']],
    ['<1.2.3-beta', ['1.2.3-alpha', '1.2.2'], ['1.2.3-beta', '1.2.3', '1.2.2-alpha']],
    ['~1', ['1.0.0', '1.9.0'], ['2.0.0', '0.9.0']],
    ['~0.2', ['0.2.0', '0.2.9'], ['0.3.0', '0.1.9']],
    ['~1.2.3-beta.2', ['1.2.3-beta.2', '1.2.3-beta.10', '1.2.3', '1.2.9'], ['1.2.3-beta.1', '1.2.4-beta', '1.3.0']],
    ['^1.2.3', ['1.2.3', '1.9.0'], ['2.0.0', '1.2.2', '2.0.0-0']],
    ['^0.2.3', ['0.2.3', '0.2.9'], ['0.3.0', '0.2.2']],
    ['^0.0.3', ['0.0.3'], ['0.0.4', '0.0.2']],
    ['^0.2.x', ['0.2.0', '0.2.9'], ['0.3.0']],
    ['^0', ['0.0.0', '0.9.9'], ['1.0.0']],
    ['^1.2.3-pre', ['1.2.3-pre', '1.2.3-pre.1', '1.2.3', '1.5.0'], ['1.2.3-alpha', '1.5.0-pre', '2.0.0']],
    ['1.2.3 - 2', ['1.2.3', '2.9.9'], ['1.2.2', '3.0.0']],
    ['1 - 2.3', ['1.0.0', '2.3.9'], ['2.4.0', '0.9.9']],
    ['1.2 - 2.3.4', ['1.2.0', '2.3.4'], ['2.3.5', '1.1.9']],
    ['>=1.2 <1.4 || 3.x', ['1.2.0', '1.3.9', '3.1.0'], ['1.4.0', '2.0.0', '4.0.0']],
    ['1.2.x || >=3.0.0-rc.1 <3.0.1', ['1.2.5', '3.0.0-rc.1', '3.0.0-rc.2', '3.0.0'], ['3.0.1', '3.0.0-beta', '3.0.1-rc.1']],
    ['=1.2.3', ['1.2.3'], ['1.2.4']],
    ['v1.2.3', ['1.2.3'], ['1.2.4']],
    ['>= 1.2.3', ['1.2.3'], ['1.2.2']],
    ['>*', [], ['1.0.0']],
    ['* || >=1.0.0-beta', ['1.0.0'], ['1.0.0-beta'], ],
  ];
  for (const [range, inside, outside] of cases) {
    for (const v of inside) assert.equal(satisfies(v, range), true, `${v} in ${range}`);
    for (const v of outside) assert.equal(satisfies(v, range), false, `${v} not in ${range}`);
  }
});

test('satisfies with includePrerelease', () => {
  assert.equal(satisfies('1.5.0-beta', '^1.2.3', { includePrerelease: true }), true);
  assert.equal(satisfies('2.0.0-beta', '^1.2.3', { includePrerelease: true }), false);
  assert.equal(satisfies('1.0.0-beta', '*', { includePrerelease: true }), true);
  assert.equal(satisfies('22.0.0-rc.1', '>=20', { includePrerelease: true }), true);
  assert.equal(satisfies('1.2.1-beta', '~1.2', { includePrerelease: true }), true);
  assert.equal(satisfies('1.2.4-0', '1.2.3 - 1.2.3', { includePrerelease: true }), false);
});

test('satisfies is undecided where node-semver releases disagree (includePrerelease only)', () => {
  // `~1.2` has a -0 lower bound only since node-semver 7.8.5; `^0.1.2` lost its -0 in 7.8.3.
  assert.equal(satisfies('1.2.0-beta', '~1.2', { includePrerelease: true }), undefined);
  assert.equal(satisfies('0.1.2-beta', '^0.1.2', { includePrerelease: true }), undefined);
  assert.equal(satisfies('0.1.0-beta', '~0.1 || ^0.1.0', { includePrerelease: true }), undefined);
  assert.equal(satisfies('1.2.0-beta', '~1.2'), false);
  assert.equal(satisfies('0.1.2-beta', '^0.1.2'), false);
  assert.equal(satisfies('1.2.0', '~1.2', { includePrerelease: true }), true);
});

test('satisfies returns undefined for what it cannot parse, and never throws', () => {
  assert.equal(satisfies('1.2', '*'), undefined);
  assert.equal(satisfies('1.2.3', '>>1'), undefined);
  assert.equal(satisfies('1.2.3', 'x.1'), undefined);
  assert.equal(satisfies('1.2.3', Object.freeze({ raw: '*' })), undefined, 'only parseRange results are ranges');
  // @ts-expect-error: not a version
  assert.equal(satisfies(null, '*'), undefined);
  const range = parseRange('^1');
  assert.ok(range);
  assert.equal(satisfies('1.2.3', range), true);
});

test('classifyWanted mirrors npm-package-arg for decidable specs', () => {
  assert.deepEqual(classifyWanted(''), { type: 'range', range: '*' });
  assert.deepEqual(classifyWanted('  '), { type: 'range', range: '*' });
  assert.deepEqual(classifyWanted('1.2.3'), { type: 'version', version: '1.2.3' });
  assert.deepEqual(classifyWanted(' v1.2.3+build '), { type: 'version', version: '1.2.3' });
  assert.deepEqual(classifyWanted('^1.2'), { type: 'range', range: '^1.2' });
  assert.deepEqual(classifyWanted(' >=1 <2 '), { type: 'range', range: '>=1 <2' });
  assert.deepEqual(classifyWanted('=1.2.3'), { type: 'range', range: '=1.2.3' });
  assert.deepEqual(classifyWanted('*'), { type: 'range', range: '*' });
  assert.deepEqual(classifyWanted('vx'), { type: 'range', range: 'vx' });
  for (const tag of ['latest', 'next', 'beta-1', 'Release_2.0', 'V1.2.3', 'canary.0', 'constructor']) {
    assert.deepEqual(classifyWanted(tag), { type: 'tag', tag });
  }
  // Undecided: could be a loose range or version for npm, or is not a valid tag at all.
  for (const wanted of ['x1', 'vxy', 'v1.2.3.4', '1.2.3beta', '01.2.3', '=v=1', 'xyz', '-tag', '_tag', '.tag', 'a b', 'a%20b', 'ta@g', 'x.1']) {
    assert.equal(classifyWanted(wanted), undefined, wanted);
  }
  assert.equal(classifyWanted(undefined), undefined);
});

/** @param {string} version @param {Record<string, unknown>} [extra] */
const manifest = (version, extra = {}) => ({ name: 'pkg', version, ...extra });
/** @param {ReturnType<typeof manifest>[]} list @param {Record<string, unknown>} [distTags] */
const packument = (list, distTags = {}) => ({
  name: 'pkg',
  'dist-tags': distTags,
  versions: Object.fromEntries(list.map((m) => [m.version, m])),
});
const env = { nodeVersion: 'v20.11.1', npmVersion: '10.8.2' };

test('pickVersion: latest wins when it satisfies the range', () => {
  const p = packument(
    ['0.9.0', '1.0.0', '1.1.0', '1.2.0', '2.0.0-rc.1', '2.0.0', '2.1.0', '3.0.0-beta.1'].map((v) => manifest(v)),
    { latest: '2.0.0', next: '3.0.0-beta.1' },
  );
  assert.equal(pickVersion(p, '', env), '2.0.0', 'a bare name is "*"');
  assert.equal(pickVersion(p, '*', env), '2.0.0');
  assert.equal(pickVersion(p, '>=1', env), '2.0.0');
  assert.equal(pickVersion(p, '^2', env), '2.0.0', 'latest even though 2.1.0 is higher');
  assert.equal(pickVersion(p, '^1', env), '1.2.0');
  assert.equal(pickVersion(p, '~2.1', env), '2.1.0');
  assert.equal(pickVersion(p, '^3', env), null);
  assert.equal(pickVersion(p, '^3.0.0-beta.0', env), '3.0.0-beta.1');
  assert.equal(pickVersion(p, '>=2.0.0-rc.0 <2.0.0', env), '2.0.0-rc.1');
  assert.equal(pickVersion(p, 'next', env), '3.0.0-beta.1');
  assert.equal(pickVersion(p, 'beta', env), null, 'missing tag');
  assert.equal(pickVersion(p, '1.1.0', env), '1.1.0');
  assert.equal(pickVersion(p, 'v1.1.0+build', env), '1.1.0');
  assert.equal(pickVersion(p, '1.1.1', env), null);
  assert.equal(pickVersion(p, '', { ...env, defaultTag: 'next' }), '3.0.0-beta.1', 'npm --tag next');
});

test('pickVersion: prerelease latest only shortcuts "*" and a bare name', () => {
  const p = packument([manifest('1.0.0'), manifest('1.1.0'), manifest('2.0.0-beta.1')], { latest: '2.0.0-beta.1' });
  assert.equal(pickVersion(p, '', env), '2.0.0-beta.1');
  assert.equal(pickVersion(p, '*', env), '2.0.0-beta.1');
  assert.equal(pickVersion(p, 'x', env), '1.1.0');
  assert.equal(pickVersion(p, '>=0.0.0', env), '1.1.0');
});

test('pickVersion: a deprecated latest falls back to the highest non-deprecated version', () => {
  const p = packument([manifest('1.0.0'), manifest('1.1.0'), manifest('1.2.0', { deprecated: 'broken' })], { latest: '1.2.0' });
  assert.equal(pickVersion(p, '', env), '1.1.0');
  assert.equal(pickVersion(p, '^1.2', env), '1.2.0', 'the only match is used even if deprecated');
  assert.equal(pickVersion(p, 'latest', env), '1.2.0', 'tags ignore deprecation and engines');
  assert.equal(pickVersion(p, '1.2.0', env), '1.2.0');
});

test('pickVersion: an engine-incompatible latest falls back to the highest compatible version', () => {
  const p = packument(
    [
      manifest('1.0.0', { engines: { node: '>=14' } }),
      manifest('1.1.0', { engines: { node: '>=18', npm: '>=11' } }),
      manifest('1.2.0', { engines: { node: '>=22' } }),
      manifest('1.3.0', { engines: { node: '>=22' }, deprecated: 'x' }),
    ],
    { latest: '1.2.0' },
  );
  assert.equal(pickVersion(p, '', { nodeVersion: 'v20.11.1', npmVersion: '11.0.0' }), '1.1.0');
  assert.equal(pickVersion(p, '', { nodeVersion: 'v22.1.0', npmVersion: '11.0.0' }), '1.2.0');
  assert.equal(pickVersion(p, '', { nodeVersion: 'v20.11.1', npmVersion: '10.9.0' }), '1.0.0', 'engines.npm');
  assert.equal(pickVersion(p, '', { nodeVersion: 'v20.11.1' }), undefined, 'unknown npm: see the next test');
  assert.equal(pickVersion(p, '', { nodeVersion: 'v22.1.0' }), '1.2.0', 'unknown npm, but a usable latest');
  assert.equal(pickVersion(p, '', { nodeVersion: '', npmVersion: '11.0.0' }), '1.2.0', 'no node version: no node check');
  assert.equal(pickVersion(p, '', { nodeVersion: 'not-a-version', npmVersion: '11.0.0' }), '1.2.0', 'an invalid version fails every engine');
});

test('pickVersion: npm before 10.8.2 takes the default tag without checking it', () => {
  const p = packument(
    [manifest('1.0.0'), manifest('1.1.0'), manifest('1.2.0', { deprecated: 'broken', engines: { node: 'node >= 99' } })],
    { latest: '1.2.0' },
  );
  assert.equal(pickVersion(p, '', { nodeVersion: 'v20.11.1', npmVersion: '10.8.1' }), '1.2.0');
  assert.equal(pickVersion(p, '^1', { nodeVersion: 'v20.11.1', npmVersion: '9.6.4' }), '1.2.0');
  assert.equal(pickVersion(p, '<1.2', { nodeVersion: 'v20.11.1', npmVersion: '9.6.4' }), '1.1.0');
  assert.equal(pickVersion(p, '', { nodeVersion: 'v20.11.1', npmVersion: '10.8.2' }), '1.1.0');
  assert.equal(pickVersion(p, '', { nodeVersion: 'v20.11.1' }), undefined, 'unknown npm and the behaviours differ');
  const only = packument([manifest('1.0.0'), manifest('1.1.0', { deprecated: 'x' })], { latest: '1.1.0' });
  assert.equal(pickVersion(only, '~1.1', { nodeVersion: 'v20.11.1' }), '1.1.0', 'unknown npm, but both behaviours agree');
});

test('pickVersion sorts like npm-pick-manifest: usable, then engine-ok, then not deprecated, then highest', () => {
  const versions = [
    manifest('1.0.0', { engines: { node: '>=99' } }),
    manifest('1.1.0', { deprecated: 'x' }),
    manifest('1.2.0', { deprecated: 'x', engines: { node: '>=99' } }),
  ];
  assert.equal(pickVersion(packument(versions), '^1', env), '1.1.0');
  assert.equal(pickVersion(packument([versions[0], versions[2]]), '^1', env), '1.0.0');
  assert.equal(pickVersion(packument([versions[2], manifest('1.3.0', { deprecated: 'y', engines: { node: '>=99' } })]), '^1', env), '1.3.0');
  assert.equal(pickVersion(packument([...versions, manifest('0.1.0')]), '^1 || ^0.1', env), '0.1.0');
});

test('pickVersion: engines values that node-semver cannot satisfy are decided, unparseable ones are not', () => {
  const p = packument(
    [
      manifest('1.0.0'),
      manifest('1.1.0', { engines: { node: 18 } }),
      manifest('1.2.0', { engines: 'node >= 99' }),
      manifest('1.3.0', { engines: { node: '' } }),
      manifest('1.4.0', { engines: { node: 'node >= 18' } }),
    ],
    { latest: '1.4.0' },
  );
  assert.equal(pickVersion(p, '', env), undefined, 'latest has an unparseable engines.node');
  assert.equal(pickVersion(p, 'latest', env), '1.4.0');
  assert.equal(pickVersion(p, '1.4.0', env), '1.4.0');
  assert.equal(pickVersion(p, '<1.4', env), '1.3.0', 'a non-string engines.node fails, a string engines and "" pass');
  assert.equal(pickVersion(p, '<1.2', env), '1.0.0');
  assert.equal(pickVersion(p, '^1', env), undefined, 'the default tag has an unparseable engines.node');
  const sorted = packument([
    manifest('0.9.0', { engines: { node: 'node >= 18' } }),
    manifest('1.0.0'),
    manifest('1.1.0', { engines: { node: 'node >= 18' } }),
  ]);
  assert.equal(pickVersion(sorted, '<1.1', env), '1.0.0', '0.9.0 cannot win whatever its engines say');
  assert.equal(pickVersion(sorted, '^1', env), undefined, '1.1.0 wins only if its engines accept node');
});

test('pickVersion: includePrerelease disagreements between node-semver releases are undecided', () => {
  const p = packument([manifest('1.0.0'), manifest('1.1.0', { engines: { node: '~22.0' } })], { latest: '1.1.0' });
  assert.equal(pickVersion(p, '', { nodeVersion: 'v22.0.0-rc.1', npmVersion: '11.0.0' }), undefined);
  assert.equal(pickVersion(p, '', { nodeVersion: 'v22.0.1-rc.1', npmVersion: '11.0.0' }), '1.1.0');
  assert.equal(pickVersion(p, '', { nodeVersion: 'v22.0.0', npmVersion: '11.0.0' }), '1.1.0');
  assert.equal(pickVersion(p, '', { nodeVersion: 'v23.0.0', npmVersion: '11.0.0' }), '1.0.0');
});

test('pickVersion refuses keys npm would read differently', () => {
  const loose = { name: 'pkg', 'dist-tags': {}, versions: { '1.0.0': manifest('1.0.0'), '1.1.0beta': manifest('1.1.0beta'), junk: {} } };
  assert.equal(pickVersion(loose, '^1', env), undefined, 'npm parses "1.1.0beta" loosely');
  assert.equal(pickVersion(loose, '1.0.0', env), '1.0.0');
  const prefixed = { name: 'pkg', 'dist-tags': { latest: 'v1.1.0' }, versions: { '1.0.0': manifest('1.0.0'), 'v1.1.0': manifest('1.1.0') } };
  assert.equal(pickVersion(prefixed, '^1', env), undefined, '"v1.1.0" satisfies, but name@v1.1.0 would read "1.1.0"');
  assert.equal(pickVersion(prefixed, '<1.1', env), '1.0.0');
  assert.equal(pickVersion(prefixed, 'latest', env), undefined);
  const junk = { name: 'pkg', 'dist-tags': {}, versions: { '1.0.0': manifest('1.0.0'), junk: {}, '1.2': {}, '1.2.3.4': {} } };
  assert.equal(pickVersion(junk, '^1', env), '1.0.0', 'keys no node-semver mode parses are ignored');
  const huge = packument([manifest('1.0.0-9007199254740993'), manifest('1.0.0-9007199254740992')]);
  assert.equal(pickVersion(huge, '>=1.0.0-0', env), undefined);
});

test('pickVersion edge cases', () => {
  const p = packument([manifest('1.0.0')], { latest: '1.0.0' });
  assert.equal(pickVersion({ name: 'pkg' }, '^1', env), null, 'no versions');
  assert.equal(pickVersion({ name: 'pkg' }, 'latest', env), null);
  // @ts-expect-error: malformed manifest
  assert.equal(pickVersion({ name: 'pkg', versions: { '1.0.0': null } }, '1.0.0', env), null);
  assert.equal(pickVersion({ name: 'pkg', 'dist-tags': { latest: 5 }, versions: {} }, '', env), undefined);
  // @ts-expect-error: malformed manifest
  assert.equal(pickVersion({ name: 'pkg', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': 'x' } }, '', env), undefined);
  assert.equal(pickVersion(p, 'x1', env), undefined, 'undecided spec');
  assert.equal(pickVersion(p, 'constructor', env), null, 'inherited properties are not dist-tags');
  // @ts-expect-error: invalid arguments
  assert.equal(pickVersion(null, '', env), undefined);
  // @ts-expect-error: invalid arguments
  assert.equal(pickVersion(p, '', {}), undefined);
  assert.equal(pickVersion(p, '', { ...env, defaultTag: ' latest' }), undefined);
  assert.equal(pickVersion(p, '', { ...env, defaultTag: '1.0.0' }), undefined);
});

// ---------------------------------------------------------------------------
// Differential tests against the node-semver and npm-pick-manifest bundled with npm.

const npm = resolveNpm({ env: process.env });
/** @param {string} rel  a path inside npm's install directory @returns {any} */
function fromNpm(rel) {
  if (!npm) return undefined;
  try {
    return createRequire(npm.cli)(path.join(path.dirname(path.dirname(npm.cli)), rel));
  } catch {
    return undefined;
  }
}
const semver = fromNpm('node_modules/semver');
const pickManifest = fromNpm('node_modules/npm-pick-manifest');
/** @type {string | undefined} */
const npmOwnVersion = fromNpm('package.json')?.version;

const RANGES = [
  // any, partials and x-ranges
  '', ' ', '*', 'x', 'X', 'x.x', 'x.x.x', 'X.*.x', '*.*', '||', ' || ', '* || 1.2.3', '1.2.3 || *', '1', '1.2', '1.x', '1.X', '1.*',
  '1.2.x', '1.2.X', '1.2.*', '1.x.x', '0', '0.x', '0.0', '0.0.x', '10', '9007199254740990', '9007199254740991.x',
  // primitives and x-ranges with operators
  '1.2.3', 'v1.2.3', '=1.2.3', '= 1.2.3', '=v1.2.3', '1.2.3-beta', 'v1.2.3-rc.1', '1.2.3-0', '>1', '>1.2', '>1.2.3', '>=1', '>=1.2',
  '>=1.x', '>=1.2.3', '>= 1.2.3', '>=  1.2.3', '>=v1.2.3', '>= v1.2.3', '<1', '<1.2', '<1.2.3', '<1.2.3-beta', '<=1', '<=1.2',
  '<=1.2.x', '<=1.2.3', '< 1.2.3', '<= 1.2.3', '>*', '<*', '>=*', '<=*', '=*', '>x', '<=x', '>=0.0.0', '>=0.0.0-0', '>=0', '>=0.0',
  'v0.0.0', '>=1.0.0-rc.1', '>9007199254740990.1', '<9007199254740991',
  // tilde
  '~1', '~1.x', '~1.2', '~1.2.x', '~1.2.3', '~1.2.3-beta.2', '~0', '~0.2', '~0.2.3', '~0.0.1', '~>1', '~>1.2', '~>1.2.3', '~> 1.2.3',
  '~ 1.2.3', '~v1.2.3', '~*', '~x', '~1.2.0-0',
  // caret
  '^1', '^1.x', '^1.2', '^1.2.x', '^1.2.3', '^1.2.3-beta', '^1.2.3-pre', '^0', '^0.x', '^0.0', '^0.0.x', '^0.1', '^0.2.x', '^0.2.3',
  '^0.0.3', '^0.0.3-beta', '^0.1.2-beta', '^ 1.2.3', '^v1.2.3', '^*', '^0.0.0', '^0.0.0-0', '^9007199254740990',
  // hyphens
  '1.2.3 - 2.3.4', '1.2 - 2.3.4', '1.2.3 - 2.3', '1.2.3 - 2', '1 - 2', '1 - 2.3', '1.x - 2.x', '* - 2', '1 - *', '* - *',
  'v1.2.3 - v2.3.4', '1.2.3-beta - 2.0.0-rc.1', '0.0.0 - 1', '1.2.3 - 1.2.3', '1.2.3  -  2',
  // sets
  '>=1.2.3 <2.0.0', '>=1.2 <1.4 || 3.x', '1.2.x || >=3.0.0-rc.1 <3.0.1', '>1.2.3 <=2.0.0-rc.1', '<1.0.0 || >=2.0.0 <3', '^1 || ^2 || ^3',
  '~1.2.3 || ~2.0', '>=1.0.0-beta <1.0.0', '1.2.3 1.2.4', '>=1 <1', '<0.0.0-0', '<0.0.0-0 || 1.x', '>=1 || <0.0.0-0', '* || >=1.0.0-beta',
  '>=0.0.0 || >=1.0.0-beta', 'x || 1.2.3-beta', '>=1.2.3-beta.2 <1.2.4 || ^2.0.0-rc.1', '~0.1 || ^0.1.0', '\t^1.2\n|| ~ 2.0 ',
  // invalid
  '>>1', '1.2.3.4', '^^1', 'latest', 'abc', '1 -2', '1- 2', '1 - 2 - 3', '- 1', '1 -', '>=', '<', '~', '^', '=>1', '=<1', '==1.2.3',
  '>==1.2.3', 'v 1.2.3', 'v=1.2.3', '1.2.3 | 1.2.4', '1.2.3 ||| 1.2.4', '!1', '1.2.3-', '1.2.3-01', 'x1', 'V1.2.3', '1.2.3.', '.1',
  '1..2', '>01', '~01.2', '9007199254740992', '>9007199254740991', '1.2.3 >', '<=9007199254740991', 'x.1', '1.x.2', '*.1',
  // valid but unsupported
  '1.2+build', '>=1.2.3+build', '1.2.x-beta', '^=1.2.3', 'v=1.2', '==1', '> =1.2.3', '~>=1.2.3', '1.2.3 - =2', '^x.1',
];

const VERSIONS = [
  '0.0.0', '0.0.0-0', '0.0.0-beta', '0.0.1', '0.0.1-0', '0.0.2', '0.0.3', '0.0.3-beta', '0.0.4-0', '0.1.0', '0.1.0-beta', '0.1.2',
  '0.1.2-beta', '0.2.0', '0.2.3', '0.2.3-beta', '0.3.0', '1.0.0', '1.0.0-0', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-rc.1', '1.0.1',
  '1.1.0', '1.2.0', '1.2.0-beta', '1.2.0-0', '1.2.2', '1.2.3', '1.2.3-0', '1.2.3-beta', '1.2.3-beta.2', '1.2.3-beta.10', '1.2.3-rc.1',
  '1.2.3-alpha.beta', '1.2.3-0a', '1.2.3--', '1.2.3-pre', '1.2.4', '1.2.4-0', '1.3.0', '1.3.0-0', '1.9.9', '2.0.0', '2.0.0-0',
  '2.0.0-rc.1', '2.0.1', '2.3.4', '2.3.5-0', '3.0.0', '3.0.0-rc.1', '3.0.0-rc.2', '3.0.1', '3.1.0', '9.9.9', '10.0.0',
  '10.0.0-beta', '11.0.0', '9007199254740990.0.0', '9007199254740991.0.0', '9007199254740990.1.0', '1.2.3-9007199254740993',
];

/** Random ranges from the supported grammar (plus junk), to reach corners the corpus misses. @param {number} count */
function generatedRanges(count) {
  const rand = rng(20261103);
  const nums = ['0', '0', '1', '1', '2', '3', '10', '9007199254740990'];
  const pres = ['', '', '-0', '-beta', '-beta.2', '-rc.1', '-alpha.beta', '--'];
  const partial = () => {
    const parts = [pick(rand, nums)];
    for (let i = 1; i < 3 && rand() < 0.7; i++) parts.push(rand() < 0.2 || /[xX*]/.test(parts[i - 1]) ? pick(rand, ['x', 'X', '*']) : pick(rand, nums));
    if (rand() < 0.1) parts[0] = pick(rand, ['x', '*']);
    const text = parts.join('.');
    return pick(rand, ['', '', '', 'v']) + text + (parts.length === 3 && !/[xX*]/.test(text) ? pick(rand, pres) : '');
  };
  const set = () =>
    rand() < 0.15
      ? `${partial()} - ${partial()}`
      : Array.from({ length: 1 + Math.floor(rand() * 3) }, () => `${pick(rand, ['', '', '=', '<', '<=', '>', '>=', '~', '~>', '^', '^'])}${partial()}`).join(' ');
  return Array.from({ length: count }, () => {
    const r = Array.from({ length: 1 + Math.floor(rand() * 2) }, set).join(pick(rand, [' || ', '||']));
    return rand() < 0.1 ? r.replace(/ /, pick(rand, ['  ', '>', 'x', '-', ' - ', '+1'])) : r;
  });
}

test('differential: corpus size', () => {
  assert.ok(RANGES.length >= 120, `${RANGES.length} ranges`);
  assert.ok(VERSIONS.length >= 60, `${VERSIONS.length} versions`);
});

test('differential: parseRange and satisfies agree with node-semver', { skip: semver ? false : 'node-semver not found' }, () => {
  let accepted = 0;
  let undecided = 0;
  let pairs = 0;
  for (const r of [...RANGES, ...generatedRanges(400)]) {
    const parsed = parseRange(r);
    if (semver.validRange(r) === null) assert.equal(parsed, undefined, `node-semver rejects ${JSON.stringify(r)}`);
    if (!parsed) continue;
    accepted++;
    const plain = new semver.Range(r);
    const loose = new semver.Range(r, { loose: true });
    /** @type {any} */
    let inc = null;
    try {
      inc = new semver.Range(r, { includePrerelease: true });
    } catch {
      // node-semver's satisfies() returns false for a range it cannot build
    }
    for (const v of VERSIONS) {
      pairs++;
      const mine = satisfies(v, parsed);
      assert.equal(mine, plain.test(v), `${v} in ${JSON.stringify(r)}`);
      assert.equal(mine, loose.test(v), `${v} in ${JSON.stringify(r)} (loose, as npm-pick-manifest parses)`);
      const mineInc = satisfies(v, parsed, { includePrerelease: true });
      if (mineInc === undefined) {
        undecided++;
        assert.ok(parseVersion(v)?.prerelease.length, `undecided only for prereleases: ${v} in ${JSON.stringify(r)}`);
      } else {
        assert.equal(mineInc, !!inc?.test(v), `${v} in ${JSON.stringify(r)} (includePrerelease)`);
      }
    }
  }
  assert.ok(accepted >= 300, `accepted ${accepted} ranges`);
  assert.ok(undecided < pairs / 100, `${undecided} of ${pairs} includePrerelease pairs undecided`);
});

test('differential: compareVersions agrees with semver.compare', { skip: semver ? false : 'node-semver not found' }, () => {
  for (const a of VERSIONS) {
    for (const b of VERSIONS) assert.equal(compareVersions(a, b), semver.compare(a, b), `${a} vs ${b}`);
  }
});

test('differential: classifyWanted agrees with npm-package-arg', { skip: npm ? false : 'npm not found' }, () => {
  const npa = fromNpm('node_modules/npm-package-arg');
  assert.ok(npa);
  let decided = 0;
  for (const wanted of [...RANGES, ...VERSIONS, 'latest', 'next', 'beta-1', 'V1.2.3', 'x1', ' 1.2.3 ', '1.2.3+b', 'v1.2.3']) {
    const mine = classifyWanted(wanted);
    if (!mine || wanted.trim() === '') continue;
    decided++;
    const spec = npa.resolve('pkg', wanted);
    // npa calls "=1.2.3" a version; as a range it selects exactly the same manifest.
    if (mine.type === 'range' && spec.type === 'version') assert.match(wanted.trim(), /^=/, wanted);
    else assert.equal(mine.type, spec.type, wanted);
  }
  assert.ok(decided > 200, `${decided} decided`);
});

/** @param {() => number} rand */
function generatedPackument(rand) {
  const pool = [
    '0.1.0', '0.1.1', '0.2.0-beta', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '1.2.0-beta.1', '1.2.0', '1.2.1', '2.0.0-alpha', '2.0.0',
    '2.1.0', '2.1.1', '3.0.0-rc.1', '3.0.0',
  ];
  const engines = [
    undefined, undefined, undefined, undefined, { node: '>=18' }, { node: '>=22' }, { node: '^20 || ^22' }, { node: '>=99' }, { npm: '>=11' },
    { node: '>=18', npm: '>=10' }, { node: 18 }, { node: '' }, 'node >= 99', { node: '~22.0' }, { node: '>=22.0.0-0' }, { node: 'node >= 18' },
    { node: '^0.1.2 || >=20' },
  ];
  /** @type {Record<string, Record<string, unknown>>} */
  const versions = {};
  for (const v of pool) {
    if (rand() < 0.3) continue;
    const e = pick(rand, engines);
    versions[v] = { name: 'pkg', version: v, ...(rand() < 0.25 ? { deprecated: 'old' } : {}), ...(e === undefined ? {} : { engines: e }) };
  }
  const keys = Object.keys(versions);
  /** @type {Record<string, string>} */
  const distTags = {};
  if (keys.length && rand() < 0.85) distTags.latest = rand() < 0.1 ? '9.9.9' : pick(rand, keys);
  if (keys.length && rand() < 0.5) distTags.next = pick(rand, keys);
  return { name: 'pkg', 'dist-tags': distTags, versions };
}

test('differential: pickVersion agrees with npm-pick-manifest', { skip: pickManifest && npmOwnVersion ? false : 'npm-pick-manifest not found' }, () => {
  const rand = rng(42);
  const wanted = [
    '', 'latest', 'next', 'beta', '*', 'x', '^1', '~1.2', '1.x', '>=1.0.0-rc.0', '^2.0.0-alpha', '1 - 2', '<2 || >=3', '>=0.0.0', '1.0.0',
    'v1.2.0', '=1.1.0', '2.0.0-alpha', '9.9.9', '^0.1', '^3.0.0-rc.0', ' ^1 ', '<0.0.0-0', '>=1.2.0-beta.1 <1.2.0', '^0.1.1', '~2',
  ];
  // Like npm itself, pass the version of the npm whose npm-pick-manifest is under test.
  const envs = [
    { nodeVersion: 'v20.11.1', npmVersion: npmOwnVersion },
    { nodeVersion: 'v22.12.0', npmVersion: npmOwnVersion },
    { nodeVersion: 'v22.0.0-rc.1', npmVersion: npmOwnVersion },
    { nodeVersion: 'v0.1.2-beta' },
  ];
  let decided = 0;
  let total = 0;
  for (let i = 0; i < 60; i++) {
    const p = generatedPackument(rand);
    for (const w of wanted) {
      for (const e of envs) {
        total++;
        const mine = pickVersion(p, w, e);
        if (mine === undefined) continue;
        decided++;
        let theirs = null;
        try {
          theirs = pickManifest(structuredClone(p), w.trim(), { nodeVersion: e.nodeVersion, npmVersion: e.npmVersion }).version;
        } catch (err) {
          const { code } = /** @type {{ code?: string }} */ (err);
          assert.ok(code === 'ETARGET' || code === 'ENOVERSIONS', String(err));
        }
        assert.equal(mine, theirs, `${JSON.stringify(w)} with ${JSON.stringify(e)} in ${JSON.stringify(p)}`);
      }
    }
  }
  assert.ok(decided > total * 0.6, `${decided} of ${total} decided`);
});
