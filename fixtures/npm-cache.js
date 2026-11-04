// Builds what npm leaves in its cache after `npm exec <spec>`: the `_npx`
// install folder (with the hidden lockfile npm writes last) and the cacache
// index entry plus content file of the package's registry metadata.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { npxInstallDir, packumentCacheKey } from '../src/npm-cache.js';

/** @param {string} s @param {string} algo */
const hash = (s, algo) => crypto.createHash(algo).update(s).digest('hex');

/**
 * @param {string} cacheDir
 * @param {{ spec: string, name: string, version: string, complete?: boolean, extraDeps?: Record<string, string>, registry?: string }} what
 *   `registry`: the feed the install was downloaded from (its tarball URL)
 * @returns {string} the install folder
 */
export function seedNpxInstall(cacheDir, { spec, name, version, complete = true, extraDeps = {}, registry = 'https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/' }) {
  const dir = npxInstallDir(cacheDir, [spec]);
  const pkgDir = path.join(dir, 'node_modules', ...name.split('/'));
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { [name]: `^${version}`, ...extraDeps }, _npx: { packages: [spec] } }));
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version, bin: { tool: 'bin.js' } }));
  if (complete) {
    // npm links the package's command into node_modules/.bin: a .cmd shim on Windows.
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    if (process.platform === 'win32') fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'tool.cmd'), '');
    else fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'tool'), '', { mode: 0o755 });
    fs.writeFileSync(
      path.join(dir, 'node_modules', '.package-lock.json'),
      JSON.stringify({
        name: path.basename(dir),
        lockfileVersion: 3,
        requires: true,
        packages: { [`node_modules/${name}`]: { version, resolved: `${registry}${name}/-/${name.split('/').pop()}-${version}.tgz` } },
      }),
    );
  }
  return dir;
}

/** What `npm exec` asks for: the short form of the registry metadata. */
export const EXEC_ACCEPT = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';

/**
 * Append an entry for the package's registry metadata to npm's HTTP cache,
 * as make-fetch-happen writes it.
 *
 * @param {string} cacheDir
 * @param {string} registryHref
 * @param {string} name
 * @param {{ content?: string, deleted?: boolean, writeContent?: boolean, accept?: string, status?: number }} [opts]
 *   deleted: a null integrity; accept: the request's Accept header (default: what npm exec sends)
 */
export function seedPackument(cacheDir, registryHref, name, { content = '{"name":"x"}', deleted = false, writeContent = true, accept = EXEC_ACCEPT, status } = {}) {
  const key = packumentCacheKey(registryHref, name);
  const data = Buffer.from(content);
  const digest = crypto.createHash('sha512').update(data).digest('base64');
  const hex = Buffer.from(digest, 'base64').toString('hex');
  const contentFile = path.join(cacheDir, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  if (writeContent) {
    fs.mkdirSync(path.dirname(contentFile), { recursive: true });
    fs.writeFileSync(contentFile, data);
  }
  const time = Date.now();
  const metadata = {
    time,
    url: key.slice('make-fetch-happen:request-cache:'.length),
    reqHeaders: { accept },
    resHeaders: { 'content-type': 'application/json' },
    options: { compress: true },
    ...(status === undefined ? {} : { status }),
  };
  const entry = JSON.stringify({ key, integrity: deleted ? null : `sha512-${digest}`, time, size: data.length, metadata });
  const b = hash(key, 'sha256');
  const bucket = path.join(cacheDir, '_cacache', 'index-v5', b.slice(0, 2), b.slice(2, 4), b.slice(4));
  fs.mkdirSync(path.dirname(bucket), { recursive: true });
  fs.appendFileSync(bucket, `\n${hash(entry, 'sha1')}\t${entry}`);
  return { key, contentFile, bucket };
}
