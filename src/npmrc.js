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

/**
 * @param {string} content
 * @param {{ tmpdir?: string }} [opts]
 * @returns {TempNpmrc}
 */
export function createTempNpmrc(content, { tmpdir = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpdir, 'ado-npm-exec-'));
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
