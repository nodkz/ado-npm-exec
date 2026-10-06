// Repository guards for invariants that are easy to break by accident.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNpm } from '../src/npm-cli.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ADO_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.tmp-test') return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

/** Files that end up in the published tarball (per package.json "files"). */
function shippedFiles() {
  const listed = pkg.files.flatMap((/** @type {string} */ f) => walk(path.join(ROOT, f)));
  const always = ['package.json', 'README.md', 'LICENSE'].map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f));
  return [...listed, ...always];
}

test('the bootstrapper never touches stdout or stdin (they belong to the MCP server)', () => {
  for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'bin'))]) {
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /\bconsole\.|process\.stdout|process\.stdin/, path.relative(ROOT, file));
  }
});

test('shipped files contain no tenant IDs, internal URLs or e-mail addresses', () => {
  // The package author's public contact address (package.json "author") is the only one allowed.
  const authorEmail = /<([^>]+)>/.exec(pkg.author ?? '')?.[1]?.toLowerCase();
  for (const file of shippedFiles()) {
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, 'utf8');
    for (const guid of text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []) {
      assert.ok([ADO_RESOURCE_ID, ZERO_GUID].includes(guid.toLowerCase()), `${rel}: unexpected GUID ${guid}`);
    }
    for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+\.(?:visualstudio\.com|azure\.com))(\/[^\s)"'`<>\]]*)?/gi)) {
      const host = m[1].toLowerCase();
      const firstSegment = (m[2] ?? '/').split('/')[1] ?? '';
      if (host.endsWith('.visualstudio.com')) {
        assert.ok(['contoso.pkgs.visualstudio.com', 'app.vssps.visualstudio.com'].includes(host), `${rel}: ${m[0]}`);
      } else if (host === 'pkgs.dev.azure.com' || host === 'dev.azure.com') {
        assert.ok(['', 'contoso'].includes(firstSegment), `${rel}: ${m[0]}`);
      } else {
        assert.fail(`${rel}: unexpected Azure host in ${m[0]}`);
      }
    }
    for (const email of text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io)\b/gi) ?? []) {
      if (email.toLowerCase() === authorEmail) continue;
      assert.ok(/@(contoso\.com|users\.noreply\.github\.com)$/i.test(email), `${rel}: e-mail address ${email}`);
    }
  }
});

test('zero runtime dependencies and no install-time scripts', () => {
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
    assert.equal(pkg[key], undefined, key);
  }
  const lifecycle = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublish', 'prepublishOnly', 'publish', 'postpublish'];
  for (const s of lifecycle) assert.equal(pkg.scripts?.[s], undefined, `scripts.${s}`);
});

test('package.json is ready for a provenance publish', () => {
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.files, ['bin/', 'src/']);
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.publishConfig.provenance, true);
  assert.equal(pkg.publishConfig.access, 'public');
  assert.match(pkg.repository.url, /^git\+https:\/\/github\.com\/[^/]+\/[^/]+\.git$/);
  const bin = path.join(ROOT, pkg.bin['ado-npm-exec']);
  assert.match(fs.readFileSync(bin, 'utf8'), /^#!\/usr\/bin\/env node\n/, 'LF shebang (see .gitattributes)');
});

test('the lockfile only references the public npm registry', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const resolved = Object.values(lock.packages).flatMap((/** @type {any} */ p) => (p.resolved ? [p.resolved] : []));
  assert.ok(resolved.length > 0);
  for (const r of resolved) assert.ok(r.startsWith('https://registry.npmjs.org/'), r);
});

test('no .npmrc is committed anywhere', () => {
  assert.deepEqual(walk(ROOT).filter((f) => path.basename(f) === '.npmrc').map((f) => path.relative(ROOT, f)), []);
});

const npm = resolveNpm({ env: process.env });
test('npm pack ships exactly bin/, src/ and the docs', { skip: npm ? false : 'npm not found' }, () => {
  assert.ok(npm);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-npm-exec-test-'));
  try {
    fs.writeFileSync(path.join(tmp, 'empty.npmrc'), '');
    const r = spawnSync(npm.node, [npm.cli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: tmp,
        USERPROFILE: tmp,
        SystemRoot: process.env.SystemRoot,
        npm_config_cache: path.join(tmp, 'cache'),
        npm_config_userconfig: path.join(tmp, 'empty.npmrc'),
        npm_config_update_notifier: 'false',
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const files = JSON.parse(r.stdout)[0].files.map((/** @type {{ path: string }} */ f) => f.path).sort();
    const expected = [
      'LICENSE',
      ...(fs.existsSync(path.join(ROOT, 'README.md')) ? ['README.md'] : []),
      'bin/ado-npm-exec.js',
      'package.json',
      ...fs.readdirSync(path.join(ROOT, 'src')).map((f) => `src/${f}`),
    ].sort();
    assert.deepEqual(files, expected);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
