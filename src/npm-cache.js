/**
 * Read-only knowledge of npm's cache, to start a package npm already
 * installed with no token and no request. It mirrors npm's on-disk formats
 * (the same in npm 10 and 11; tests run real npm against them): libnpmexec's
 * `_npx/<hash>` folders, Arborist's hidden lockfile, and cacache's index of
 * make-fetch-happen's HTTP cache.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEnv } from './proc.js';
import { parseVersion } from './semver.js';

/**
 * npm's cache folder, found the way npm finds it: `npm_config_cache` (the
 * outer `npm exec` always exports it; `~/` and relative paths resolved like
 * npm does), else `~/.npm` (`%LOCALAPPDATA%\npm-cache` on Windows). Every
 * inner npm gets it as `--cache`, so this is the folder npm uses. Undefined
 * only when it cannot be determined.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ platform?: NodeJS.Platform, homedir?: string, cwd?: string }} [opts]
 *   homedir: the home folder (default: HOME or USERPROFILE, else the OS's); cwd: the current folder
 * @returns {string | undefined}
 */
export function npmCacheDir(env, { platform = process.platform, homedir, cwd } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const home = () => {
    let h = homedir;
    if (h === undefined) {
      h = getEnv(env, platform === 'win32' ? 'USERPROFILE' : 'HOME');
      if (!h) {
        try {
          h = os.homedir();
        } catch {
          h = '';
        }
      }
    }
    return h && p.isAbsolute(h) ? h : undefined;
  };
  /** @param {string} value */
  const resolve = (value) => {
    if ((platform === 'win32' ? /^~[\\/]/ : /^~\//).test(value)) {
      const h = home();
      return h ? p.resolve(h, value.slice(2)) : undefined;
    }
    if (p.isAbsolute(value)) return p.resolve(value);
    const base = cwd ?? process.cwd();
    return p.isAbsolute(base) ? p.resolve(base, value) : undefined;
  };
  const configured = getEnv(env, 'npm_config_cache');
  if (configured !== undefined && configured !== '') return resolve(configured);
  const local = platform === 'win32' ? getEnv(env, 'LOCALAPPDATA') : undefined;
  if (local) return resolve(p.join(local, 'npm-cache'));
  const h = home();
  return h ? p.join(h, platform === 'win32' ? 'npm-cache' : '.npm') : undefined;
}

/**
 * The folder `npm exec` installs `packages` into (libnpmexec: sha512 of the
 * sorted list joined by newlines, first 16 hex characters).
 *
 * @param {string} cacheDir
 * @param {readonly string[]} packages  package specs exactly as passed to npm
 * @returns {string}
 */
export function npxInstallDir(cacheDir, packages) {
  const list = [...packages].sort((a, b) => a.localeCompare(b, 'en')).join('\n');
  const hash = crypto.createHash('sha512').update(list).digest('hex').slice(0, 16);
  return path.join(cacheDir, '_npx', hash);
}

/** @param {string} file @returns {any} */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * @typedef {object} NpxInstall
 * @property {string} dir        the `_npx/<hash>` folder
 * @property {boolean} exists    the folder exists
 * @property {boolean} complete  npm finished installing into it
 * @property {string} [version]  the installed version of the package
 * @property {string} [resolved] where npm downloaded it from (the hidden lockfile's `resolved`)
 */

/**
 * What `npm exec -- <spec>` would find in its cache for package `name`.
 *
 * @param {string} cacheDir
 * @param {string} spec  e.g. `@contoso/tool@1.2.3`
 * @param {string} name  e.g. `@contoso/tool`
 * @param {{ platform?: NodeJS.Platform }} [opts]
 * @returns {NpxInstall}
 */
export function readNpxInstall(cacheDir, spec, name, { platform = process.platform } = {}) {
  const dir = npxInstallDir(cacheDir, [spec]);
  if (!fs.existsSync(dir)) return { dir, exists: false, complete: false };
  const target = path.join(dir, 'node_modules', ...name.split('/'));
  const manifest = readJson(path.join(target, 'package.json'));
  const version = typeof manifest?.version === 'string' && manifest.name === name ? manifest.version : undefined;
  const entry = lockedEntry(readJson(path.join(dir, 'node_modules', '.package-lock.json')), dir, target, name);
  // Without its command linked here, npm would look the command up on PATH
  // and could run a workspace's node_modules/.bin/<command> instead.
  const binDir = path.join(dir, 'node_modules', '.bin');
  const linked = binNames(manifest, name).every((b) => isRunnable(path.join(binDir, b), platform));
  const complete = typeof entry?.version === 'string' && entry.version === version && linked;
  const resolved = typeof entry?.resolved === 'string' ? entry.resolved : undefined;
  return { dir, exists: true, complete, ...(version ? { version } : {}), ...(resolved ? { resolved } : {}) };
}

/**
 * Whether npm can run a linked command: through its `.cmd` shim on Windows,
 * elsewhere as an executable.
 *
 * @param {string} file  `<.bin>/<command>`
 * @param {NodeJS.Platform} platform
 */
function isRunnable(file, platform) {
  if (platform === 'win32') return fs.existsSync(`${file}.cmd`);
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The commands npm links for a package (as npm-normalize-package-bin names
 * them: a string `bin` gets the package's name without its scope; object keys
 * are reduced to their base name).
 *
 * @param {any} manifest
 * @param {string} name
 * @returns {string[]}
 */
function binNames(manifest, name) {
  const bin = manifest?.bin;
  if (typeof bin === 'string') return [name.split('/').pop() ?? name];
  if (!bin || typeof bin !== 'object' || Array.isArray(bin)) return [];
  return Object.keys(bin)
    .map((k) => path.posix.basename(k.replace(/\\/g, '/')))
    .filter((k) => k !== '' && k !== '.' && k !== '..');
}

/**
 * Whether npm downloaded an install from the feed's organization. The exec
 * cache folder is keyed by the spec string alone, so `name@1.2.3` from
 * another registry (a manual `npx name@1.2.3`) lands in the same folder, and
 * npm would run it. Azure Artifacts tarball URLs may name the feed by its id,
 * and an organization has two host names: so for Azure Artifacts the check is
 * the protocol and the organization; for other registries (tests) the
 * protocol and the host.
 *
 * @param {string} registryHref
 * @param {string | undefined} resolved
 */
export function isFromFeedOrg(registryHref, resolved) {
  if (!resolved) return false;
  let feed;
  let url;
  try {
    feed = new URL(registryHref);
    url = new URL(resolved);
  } catch {
    return false;
  }
  if (url.protocol !== feed.protocol || url.port !== feed.port || url.username || url.password) return false;
  const org = azureOrg(feed);
  return org ? azureOrg(url) === org : url.host === feed.host;
}

/**
 * The organization of an Azure Artifacts URL: `pkgs.dev.azure.com/<org>/...`
 * or `<org>.pkgs.visualstudio.com/...`.
 *
 * @param {URL} u
 * @returns {string | undefined}
 */
function azureOrg(u) {
  const host = u.hostname.toLowerCase();
  if (host === 'pkgs.dev.azure.com') return u.pathname.split('/')[1]?.toLowerCase() || undefined;
  return /^([a-z0-9][a-z0-9-]*)\.pkgs\.visualstudio\.com$/.exec(host)?.[1];
}

/**
 * Where an install was downloaded from, for messages: the host only.
 *
 * @param {NpxInstall} inst
 */
export function installOrigin(inst) {
  try {
    return (inst.resolved && new URL(inst.resolved).host) || 'an unknown registry';
  } catch {
    return 'an unknown registry';
  }
}

/**
 * Whether `npm exec --offline <name>@<version>` can start: the install is
 * usable (see isInstalledFromFeed) and npm has the package's registry
 * metadata cached.
 *
 * @param {string} cacheDir
 * @param {string} registryHref
 * @param {string} name
 * @param {string} version
 * @param {{ fullMetadata?: boolean }} [opts]  see isCached
 */
export function isReadyToStart(cacheDir, registryHref, name, version, opts) {
  return isInstalledFromFeed(cacheDir, registryHref, name, version) && isCached(cacheDir, packumentCacheKey(registryHref, name), opts);
}

/**
 * Whether npm completed the install of `name@version` in its exec cache,
 * from the feed's organization.
 *
 * @param {string} cacheDir
 * @param {string} registryHref
 * @param {string} name
 * @param {string} version
 */
export function isInstalledFromFeed(cacheDir, registryHref, name, version) {
  return isUsableInstall(readNpxInstall(cacheDir, `${name}@${version}`, name), registryHref, version);
}

/**
 * An install npm completed, of `version`, downloaded from the feed's organization.
 *
 * @param {NpxInstall} inst
 * @param {string} registryHref
 * @param {string} version
 */
export function isUsableInstall(inst, registryHref, version) {
  return inst.complete && sameVersion(inst.version, version) && isFromFeedOrg(registryHref, inst.resolved);
}

/** @param {string | undefined} a @param {string} b */
function sameVersion(a, b) {
  const x = parseVersion(a ?? '');
  return !!x && x.version === parseVersion(b)?.version;
}

/**
 * The hidden lockfile's entry for the top-level `name`. Its key is
 * `node_modules/<name>`, except when the cache path goes through a symlink
 * (macOS: /var is /private/var): Arborist then writes a path relative to the
 * folder as given, through the real location (`../../private/var/...`).
 *
 * @param {any} lock
 * @param {string} dir
 * @param {string} target  `<dir>/node_modules/<name>`
 * @param {string} name
 * @returns {{ version?: unknown, resolved?: unknown } | undefined}
 */
function lockedEntry(lock, dir, target, name) {
  const packages = lock?.packages;
  if (!packages || typeof packages !== 'object') return undefined;
  const suffix = `node_modules/${name}`;
  if (packages[suffix]) return packages[suffix];
  /** @type {string | undefined} */
  let real;
  for (const [key, entry] of Object.entries(packages)) {
    if (!key.endsWith(`/${suffix}`)) continue;
    try {
      real ??= fs.realpathSync(target);
      if (fs.realpathSync(path.resolve(dir, key)) === real) return entry;
    } catch {
      // not there: not this one
    }
  }
  return undefined;
}

/**
 * Whether `dir` is an `npm exec` install of exactly `name` and nothing else,
 * so removing it can only cost a re-download.
 *
 * @param {string} dir
 * @param {string} name
 */
export function isSinglePackageNpxDir(dir, name) {
  const pkg = readJson(path.join(dir, 'package.json'));
  const deps = pkg && typeof pkg === 'object' ? pkg.dependencies : undefined;
  if (!deps || typeof deps !== 'object') return false;
  const keys = Object.keys(deps);
  if (keys.length !== 1 || keys[0] !== name) return false;
  const npx = pkg._npx?.packages;
  return npx === undefined || (Array.isArray(npx) && npx.length === 1 && typeof npx[0] === 'string' && npx[0].startsWith(`${name}@`));
}

/**
 * make-fetch-happen's cache key for the packument npm requests for `name`
 * from `registryHref` (pacote: the registry without trailing slashes, a
 * slash, and the name with its scope slash written as `%2f`).
 *
 * @param {string} registryHref
 * @param {string} name
 */
export function packumentCacheKey(registryHref, name) {
  const url = new URL(`${registryHref.replace(/\/+$/, '')}/${name.replace('/', '%2f')}`);
  return `make-fetch-happen:request-cache:${url.href}`;
}

/** ssri's algorithm order, weakest first. */
const SRI_PRIORITY = ['md5', 'whirlpool', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha3', 'sha3-256', 'sha3-384', 'sha3-512'];

/**
 * cacache's content file for an integrity string (its strongest hash).
 *
 * @param {string} cacacheDir
 * @param {string} integrity
 * @returns {string | undefined}
 */
export function contentPath(cacacheDir, integrity) {
  let best;
  for (const part of integrity.trim().split(/\s+/)) {
    const m = /^([a-z0-9-]+)-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$/.exec(part);
    if (!m) continue;
    const rank = SRI_PRIORITY.indexOf(m[1]);
    if (rank !== -1 && (!best || rank > best.rank)) best = { algorithm: m[1], digest: m[2], rank };
  }
  if (!best) return undefined;
  const hex = Buffer.from(best.digest, 'base64').toString('hex');
  if (hex.length < 8) return undefined;
  return path.join(cacacheDir, 'content-v2', best.algorithm, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

/** What npm asks for: the short form of the registry metadata, or (with npm's `before` setting) the full one. */
const SHORT_ACCEPT = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';
const FULL_ACCEPT = 'application/json';

/**
 * The media types an Accept header asks for, in the order npm's negotiator
 * gives them (by q, then as written), without those with q=0.
 *
 * @param {unknown} accept
 */
function mediaTypes(accept) {
  if (typeof accept !== 'string') return '*/*';
  return accept
    .split(',')
    .map((part, i) => {
      const [type = '', ...params] = part.split(';').map((s) => s.trim());
      const q = params.map((p) => /^q=([0-9.]+)$/i.exec(p)?.[1]).find((v) => v !== undefined);
      return { type: type.toLowerCase(), q: q === undefined ? 1 : Number(q), i };
    })
    .filter((t) => /^[^\s/]+\/[^\s/]+$/.test(t.type) && t.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map((t) => t.type)
    .join(', ');
}

/**
 * Whether a cache entry answers the request npm makes, as make-fetch-happen
 * decides it: the same negotiated media types, no other host, compression on.
 *
 * @param {any} metadata
 * @param {string} accept
 */
function answersRequest(metadata, accept) {
  const headers = metadata?.reqHeaders;
  if (!headers || typeof headers !== 'object' || headers.host !== undefined) return false;
  if (metadata.options?.compress === false) return false;
  return mediaTypes(headers.accept) === mediaTypes(accept);
}

/**
 * Whether npm's HTTP cache can answer npm's offline request for `key`. Like
 * make-fetch-happen: the newest entry that answers the request decides, and
 * its content file must be there. Entries make-fetch-happen skips (no
 * content and no status, a wrong size) are skipped. npm asks for the full
 * metadata when its `before` setting is on (`fullMetadata`).
 *
 * @param {string} cacheDir  npm's cache folder (the one holding `_cacache`)
 * @param {string} key
 * @param {{ fullMetadata?: boolean }} [opts]
 */
export function isCached(cacheDir, key, { fullMetadata = false } = {}) {
  const accept = fullMetadata ? FULL_ACCEPT : SHORT_ACCEPT;
  const cacache = path.join(cacheDir, '_cacache');
  const hashed = crypto.createHash('sha256').update(key).digest('hex');
  const bucket = path.join(cacache, 'index-v5', hashed.slice(0, 2), hashed.slice(2, 4), hashed.slice(4));
  let text;
  try {
    text = fs.readFileSync(bucket, 'utf8');
  } catch {
    return false;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const json = line.slice(tab + 1);
    if (crypto.createHash('sha1').update(json).digest('hex') !== line.slice(0, tab)) continue;
    let entry;
    try {
      entry = JSON.parse(json);
    } catch {
      continue;
    }
    if (entry?.key !== key) continue;
    const metadata = entry.metadata;
    const integrity = typeof entry.integrity === 'string' && entry.integrity ? entry.integrity : undefined;
    if ((!integrity && !metadata?.status) || (metadata?.size && entry.size !== metadata.size)) continue;
    if (!answersRequest(metadata, accept)) continue;
    // A cached answer without content, or other than 200, is no metadata.
    if (!integrity || (metadata.status !== undefined && metadata.status !== 200)) return false;
    const file = contentPath(cacache, integrity);
    return !!file && fs.existsSync(file);
  }
  return false;
}

/**
 * A start that npm can serve from its cache alone: the exact version (or the
 * one the spec resolved to last time) is ready to start (see isReadyToStart).
 *
 * @param {{ cacheDir: string, registry: { href: string }, spec: { name: string },
 *   exact?: string, state?: { version?: string } }} info
 * @returns {{ runSpec: string, version: string } | undefined}
 */
export function findCachedStart({ cacheDir, registry, spec, exact, state }) {
  const version = exact ?? state?.version;
  if (!version || !isReadyToStart(cacheDir, registry.href, spec.name, version)) return undefined;
  return { runSpec: `${spec.name}@${version}`, version };
}
