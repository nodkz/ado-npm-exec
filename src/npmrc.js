/**
 * The short-lived npm config that carries the token to the inner npm.
 *
 * It lives in a fresh mkdtemp directory (0700) as `.npmrc` (0600, created
 * exclusively), is handed to npm via `npm_config_userconfig`, and is removed
 * as soon as the session ends. The token never appears in argv.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isJwtShaped } from './jwt.js';

// The allowlist in registry.js decides which hosts are acceptable; these
// checks only guarantee nothing can break out of an ini line.
const SAFE_HREF_RE = /^https?:\/\/[A-Za-z0-9.:-]+\/[A-Za-z0-9._~%@/-]*\/$/;
const SAFE_NERF_RE = /^\/\/[A-Za-z0-9.:-]+\/[A-Za-z0-9._~%@/-]*\/$/;
const SAFE_SCOPE_RE = /^[a-z0-9~-][a-z0-9._~-]*$/;

/**
 * @param {{ registry: { href: string, nerfDart: string }, token: string, scope?: string }} input
 * @returns {string}
 */
export function renderNpmrc({ registry, token, scope }) {
  if (!SAFE_HREF_RE.test(registry.href) || !SAFE_NERF_RE.test(registry.nerfDart)) {
    throw new Error('refusing to write an unsafe registry URL to npmrc');
  }
  if (!isJwtShaped(token)) throw new Error('refusing to write a token that is not a JWT to npmrc');
  if (scope !== undefined && !SAFE_SCOPE_RE.test(scope)) throw new Error('refusing to write an unsafe scope to npmrc');
  const lines = [`registry=${registry.href}`];
  if (scope) lines.push(`@${scope}:registry=${registry.href}`);
  lines.push(`${registry.nerfDart}:_authToken=${token}`);
  return `${lines.join('\n')}\n`;
}

/**
 * @typedef {object} TempNpmrc
 * @property {string} dir   private temp directory, also used as npm's --prefix
 * @property {string} file  the .npmrc inside it
 * @property {() => boolean} cleanup  synchronous and idempotent; true once removed
 */

export const TEMP_PREFIX = 'ado-npm-exec-';

export class UnsafeTempError extends Error {
  name = 'UnsafeTempError';
}

/**
 * @typedef {object} FsLike
 * @property {(p: string) => { uid: number, gid: number, mode: number, isDirectory(): boolean }} stat
 * @property {(p: string) => string} realpath
 */

/** @type {FsLike} */
const realFs = { stat: (p) => fs.statSync(p), realpath: (p) => fs.realpathSync(p) };

/**
 * A directory is trusted when it and every ancestor is owned by root or by us
 * and cannot be written by other users. npm looks for
 * `<ancestor>/node_modules/.bin/<spec>` above its --prefix, so a shared,
 * world-writable ancestor such as /tmp would let another user plant a program
 * that runs instead of the package (and can read the token file).
 *
 * @param {string} dir
 * @param {{ uid: number, gid: number, fs?: FsLike }} who
 */
export function isTrustedDir(dir, { uid, gid, fs: f = realFs }) {
  let current;
  try {
    current = f.realpath(dir);
    if (!f.stat(current).isDirectory()) return false;
  } catch {
    return false;
  }
  for (;;) {
    let st;
    try {
      st = f.stat(current);
    } catch {
      return false;
    }
    if (st.uid !== 0 && st.uid !== uid) return false;
    if (st.mode & 0o002) return false;
    if (st.mode & 0o020 && st.gid !== gid) return false;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

/**
 * Where to create the temp directory. Windows uses the per-user %TEMP%. On
 * POSIX the first trusted candidate wins: the OS temp dir (per-user on
 * macOS), $XDG_RUNTIME_DIR, then ~/.cache (created 0700 if missing).
 *
 * @param {{ platform?: NodeJS.Platform, tmpdir?: string, env?: NodeJS.ProcessEnv,
 *   homedir?: string, uid?: number, gid?: number, fs?: FsLike,
 *   mkdir?: (p: string) => void }} [opts]
 * @returns {string}
 */
export function chooseBaseDir({
  platform = process.platform,
  tmpdir = os.tmpdir(),
  env = process.env,
  homedir = os.homedir(),
  uid = process.getuid?.() ?? -1,
  gid = process.getgid?.() ?? -1,
  fs: f = realFs,
  mkdir = (p) => fs.mkdirSync(p, { recursive: true, mode: 0o700 }),
} = {}) {
  if (platform === 'win32') return tmpdir;
  const cache = path.join(homedir, '.cache');
  const candidates = [tmpdir, env.XDG_RUNTIME_DIR, cache].filter((c) => typeof c === 'string' && path.isAbsolute(c));
  for (const dir of /** @type {string[]} */ (candidates)) {
    if (dir === cache) {
      try {
        mkdir(dir);
      } catch {
        continue;
      }
    }
    if (isTrustedDir(dir, { uid, gid, fs: f })) return dir;
  }
  throw new UnsafeTempError(
    `no private directory for temporary files: ${candidates.join(', ')} (or a parent) can be written by other users. ` +
      'Set TMPDIR to a directory only you can write to.',
  );
}

/**
 * The file npm would run instead of fetching `binName` from the feed:
 * `<dir or an ancestor>/node_modules/.bin/<binName>` (see libnpmexec).
 *
 * @param {string} startDir
 * @param {string} binName  the spec as passed to npm exec
 * @param {(p: string) => boolean} [exists]
 * @returns {string | undefined}
 */
export function findShadowingBin(startDir, binName, exists = (p) => fs.existsSync(p)) {
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.resolve(current, 'node_modules', '.bin', binName);
    if (exists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Best-effort removal of our own temp directories older than `maxAgeMs`, left
 * behind when a previous run was killed with SIGKILL. Their tokens have long
 * expired. Symlinks and directories owned by other users are never touched.
 *
 * @param {string} baseDir
 * @param {{ nowMs?: number, maxAgeMs?: number, uid?: number }} [opts]
 * @returns {number} how many were removed
 */
export function sweepStaleTempDirs(baseDir, { nowMs = Date.now(), maxAgeMs = 2 * 60 * 60 * 1000, uid = process.getuid?.() ?? -1 } = {}) {
  let removed = 0;
  let names;
  try {
    names = fs.readdirSync(baseDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX) || !/^[A-Za-z0-9]{6}$/.test(name.slice(TEMP_PREFIX.length))) continue;
    const dir = path.join(baseDir, name);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (uid !== -1 && st.uid !== uid) continue;
      if (nowMs - st.mtimeMs < maxAgeMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // gone or not ours
    }
  }
  return removed;
}

/**
 * @param {string} content
 * @param {{ tmpdir?: string }} [opts]
 * @returns {TempNpmrc}
 */
export function createTempNpmrc(content, { tmpdir = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpdir, TEMP_PREFIX));
  const file = path.join(dir, '.npmrc');
  let removed = false;
  const cleanup = () => {
    if (removed) return true;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      removed = true;
    } catch {
      // keep false so a later call can retry
    }
    return removed;
  };
  try {
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
    fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    cleanup();
    throw error;
  }
  return { dir, file, cleanup };
}
