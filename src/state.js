/**
 * Small per-user records in `<npm cache>/_ado-npm-exec/` (MCP client sandboxes
 * that allow npm's cache allow it too): resolved versions, installs, session
 * leases, locks and remembered sign-ins, plus the install folders a reinstall
 * or a cleanup moves aside. Never a token. Writes are atomic; a missing or
 * malformed record means "nothing known".
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A session lease stays live this long after its last heartbeat. */
export const LEASE_FRESH_MS = 30 * 60 * 1000;
/** ...or this long while its process is alive on this machine (a laptop that slept). */
export const LEASE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** How often a running session refreshes its lease. */
export const LEASE_HEARTBEAT_MS = 5 * 60 * 1000;
/** A spec nobody started or checked for this long no longer protects its versions. */
export const STATE_UNUSED_MS = 30 * 24 * 60 * 60 * 1000;
/** An install lock of another machine (a shared cache) that nobody refreshed for this long is abandoned. */
export const LOCK_STALE_MS = 15 * 60 * 1000;
/** ...and one of this machine whose processes still run (a laptop that slept, or a reused pid). */
export const LOCK_MAX_MS = 60 * 60 * 1000;
/** A takeover or release takes milliseconds: an older guard was left by a process that died during one. */
const GUARD_STALE_MS = 30 * 1000;
/** A backup of a replaced install is kept this long when its folder is still missing (see restoreBackup). */
const BACKUP_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** ...and this long once the folder is back. */
const BACKUP_DONE_MS = 60 * 60 * 1000;
/** A remembered tenant is asked for again after this long. */
const TENANT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** @param {string} cacheDir */
export function stateDir(cacheDir) {
  return path.join(cacheDir, '_ado-npm-exec');
}

/**
 * @param {string} registryHref
 * @param {string} spec  the package spec as the user wrote it
 * @param {{ defaultTag?: string, before?: string }} [pick]  npm settings that change which version the spec means
 */
export function stateKey(registryHref, spec, { defaultTag, before } = {}) {
  const tag = defaultTag && defaultTag !== 'latest' ? `\ntag=${defaultTag}` : '';
  return crypto
    .createHash('sha256')
    .update(`${registryHref}\n${spec}${tag}${before ? `\nbefore=${before}` : ''}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * @typedef {object} SpecState
 * @property {1} v
 * @property {string} registry
 * @property {string} spec              as the user wrote it
 * @property {string} name
 * @property {string} [version]         the exact version a start runs
 * @property {string} [previous]        the version before it
 * @property {string[]} [installed]     versions npm installed for this tool, oldest first
 * @property {number} [usedAt]          last start
 * @property {number} [checkedAt]       last successful lookup on the feed
 * @property {number} [checkStartedAt]  a lookup in progress
 * @property {number} [failures]        consecutive failed lookups
 * @property {number} [nextCheckAt]     no lookup before this time
 * @property {number} [offlineFailedAt] a start from npm's cache failed quickly
 * @property {number} [missingAt]       the feed said the spec has no version (any more)
 */

/** The largest time a Date can hold. */
const MAX_TIME = 8.64e15;
/** @param {unknown} v @returns {v is number} */
const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_TIME;
/** @param {unknown} v @returns {v is string} */
const isVersion = (v) => typeof v === 'string' && v.length <= 256 && VERSION_RE.test(v);
/** @param {unknown} error */
const errorCode = (error) => /** @type {NodeJS.ErrnoException} */ (error)?.code;

/**
 * Keep only well-formed fields of a record read from disk.
 *
 * @param {any} raw
 * @returns {SpecState | undefined}
 */
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return undefined;
  if (typeof raw.registry !== 'string' || typeof raw.spec !== 'string' || typeof raw.name !== 'string') return undefined;
  /** @type {SpecState} */
  const out = { v: 1, registry: raw.registry, spec: raw.spec, name: raw.name };
  if (isVersion(raw.version)) out.version = raw.version;
  if (isVersion(raw.previous)) out.previous = raw.previous;
  if (Array.isArray(raw.installed)) out.installed = [...new Set(raw.installed.filter(isVersion))].slice(-50);
  for (const k of /** @type {const} */ (['usedAt', 'checkedAt', 'checkStartedAt', 'nextCheckAt', 'offlineFailedAt', 'missingAt'])) {
    if (isTime(raw[k])) out[k] = raw[k];
  }
  if (Number.isInteger(raw.failures) && raw.failures > 0) out.failures = Math.min(raw.failures, 100);
  return out;
}

/** @param {string} dir */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** @param {string} file */
function removeFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // a leftover file is harmless
  }
}

/**
 * @param {string} file
 * @param {unknown} value
 * @returns {boolean}
 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    removeFile(tmp);
    return false;
  }
}

/** @param {string} file @returns {any} */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** @param {string} dir @param {string} key */
function stateFile(dir, key) {
  return path.join(dir, 'specs', `${key}.json`);
}

/**
 * @param {string} dir  see stateDir()
 * @param {string} key  see stateKey()
 * @returns {SpecState | undefined}
 */
export function readState(dir, key) {
  return normalizeState(readJson(stateFile(dir, key)));
}

/**
 * @param {string} dir
 * @param {string} key
 * @param {SpecState} state
 * @returns {boolean} whether it was written
 */
export function writeState(dir, key, state) {
  return writeJsonAtomic(stateFile(dir, key), state);
}

/**
 * Read, change and write back one record. Concurrent writers of the same
 * record can lose each other's change; every field tolerates that.
 *
 * @param {string} dir
 * @param {string} key
 * @param {Omit<SpecState, 'v'>} base  identity fields for a record that does not exist yet
 * @param {(state: SpecState) => void} mutate
 * @returns {SpecState}
 */
export function updateState(dir, key, base, mutate) {
  const state = readState(dir, key) ?? { v: 1, ...base };
  mutate(state);
  writeState(dir, key, state);
  return state;
}

/**
 * Record the version a spec now runs, after the feed was asked.
 *
 * @param {string} dir
 * @param {string} key
 * @param {Omit<SpecState, 'v'>} base
 * @param {string} version
 * @param {{ now: number, created: boolean, repaired: boolean, used?: boolean }} how
 *   created: npm created the folder for this tool, which may remove it later;
 *   repaired: a copy that failed at start was installed again (or there was
 *   none), so the next start may use npm's cache again; used: a start runs it now
 * @returns {SpecState}
 */
export function recordVersion(dir, key, base, version, { now, created, repaired, used = false }) {
  return updateState(dir, key, base, (s) => {
    const changed = s.version !== version;
    if (s.version && changed) s.previous = s.version;
    s.version = version;
    if (created) s.installed = [...(s.installed ?? []).filter((v) => v !== version), version];
    if (used) s.usedAt = now;
    s.checkedAt = now;
    if (changed || repaired) delete s.offlineFailedAt;
    delete s.failures;
    delete s.nextCheckAt;
    delete s.checkStartedAt;
    delete s.missingAt;
  });
}

/**
 * Every record, with its key.
 *
 * @param {string} dir
 * @returns {{ key: string, state: SpecState }[]}
 */
export function listStates(dir) {
  let names;
  try {
    names = fs.readdirSync(path.join(dir, 'specs'));
  } catch {
    return [];
  }
  /** @type {{ key: string, state: SpecState }[]} */
  const out = [];
  for (const n of names) {
    const m = /^([0-9a-f]{32})\.json$/.exec(n);
    if (!m) continue;
    const state = readState(dir, m[1]);
    if (state) out.push({ key: m[1], state });
  }
  return out;
}

/** @param {string} dir @param {string} key */
export function removeState(dir, key) {
  removeFile(stateFile(dir, key));
}

/**
 * Remove a record only if it still is `expected`: another process may have
 * used or updated it since it was read.
 *
 * @param {string} dir
 * @param {string} key
 * @param {SpecState} expected
 * @returns {boolean} whether it was removed
 */
export function removeStateIf(dir, key, expected) {
  if (JSON.stringify(readState(dir, key)) !== JSON.stringify(normalizeState(expected))) return false;
  removeState(dir, key);
  return true;
}

/** The sign-in tools whose use is remembered. */
const SIGN_IN_TOOLS = new Set(['az', 'azd', 'azureauth']);
/** At most this many tenants are remembered; the ones used longest ago go first. */
export const SIGN_IN_MAX_TENANTS = 50;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * @typedef {object} SignInMemory
 * @property {import('./tokens.js').ToolSource} [prefer]  the tool that gave the last token for the tenant
 * @property {(source: import('./tokens.js').ToolSource) => void} [remember]  record the tool that gave a token
 */

/**
 * Which sign-in tool gave the last token, per tenant (`*` when the tenant is
 * unknown), so that the next acquisition reuses that one sign-in. Only the
 * tool's name is stored, in `<state>/sign-in.json`. Spread the result into
 * acquireToken's options.
 *
 * @param {string | undefined} dir  see stateDir(); undefined remembers nothing
 * @param {string | undefined} tenant
 * @param {{ now?: () => number }} [opts]
 * @returns {SignInMemory}
 */
export function signInMemory(dir, tenant, { now = Date.now } = {}) {
  const key = tenant ? tenant.toLowerCase() : '*';
  if (!dir || !(key === '*' || GUID_RE.test(key))) return {};
  const file = path.join(dir, 'sign-in.json');
  const valid = (/** @type {string} */ k, /** @type {any} */ v) => (k === '*' || GUID_RE.test(k)) && SIGN_IN_TOOLS.has(v?.source) && isTime(v?.at);
  const read = () => readMap(file, 'tenants', valid);
  const prefer = /** @type {import('./tokens.js').ToolSource | undefined} */ (read().get(key)?.source);
  return {
    ...(prefer ? { prefer } : {}),
    remember: (source) => {
      if (!SIGN_IN_TOOLS.has(source) || source === prefer) return;
      const tenants = read();
      tenants.set(key, { source, at: now() });
      writeMap(file, 'tenants', tenants, SIGN_IN_MAX_TENANTS);
    },
  };
}

/**
 * The Entra ID tenant of a feed's organization, from an earlier tenant
 * discovery, so that a start can skip that request. Kept for a week, in
 * `<state>/tenants.json`.
 *
 * @param {string | undefined} dir  see stateDir(); undefined remembers nothing
 * @param {string} org  the organization (any case)
 * @param {{ now?: () => number }} [opts]
 * @returns {{ tenant?: string, remember: (tenant: string) => void, forget: () => void }}
 */
export function tenantMemory(dir, org, { now = Date.now } = {}) {
  const key = org.toLowerCase();
  if (!dir || !key) return { remember: () => {}, forget: () => {} };
  const file = path.join(dir, 'tenants.json');
  const valid = (/** @type {string} */ k, /** @type {any} */ v) => k.length <= 256 && GUID_RE.test(v?.tenant) && isTime(v?.at);
  const read = () => readMap(file, 'orgs', valid);
  const entry = read().get(key);
  const tenant = entry && now() - entry.at < TENANT_MAX_AGE_MS ? entry.tenant : undefined;
  return {
    ...(tenant ? { tenant } : {}),
    remember: (t) => {
      const lower = t.toLowerCase();
      if (!GUID_RE.test(lower) || lower === tenant) return;
      const orgs = read();
      orgs.set(key, { tenant: lower, at: now() });
      writeMap(file, 'orgs', orgs, SIGN_IN_MAX_TENANTS);
    },
    forget: () => {
      const orgs = read();
      if (orgs.delete(key)) writeMap(file, 'orgs', orgs, SIGN_IN_MAX_TENANTS);
    },
  };
}

/**
 * @param {string} file
 * @param {string} field
 * @param {(key: string, value: any) => boolean} valid
 * @returns {Map<string, any>}
 */
function readMap(file, field, valid) {
  const raw = readJson(file);
  const entries = raw?.v === 1 && raw[field] && typeof raw[field] === 'object' ? Object.entries(raw[field]) : [];
  return new Map(entries.filter(([k, v]) => valid(k, v)));
}

/**
 * Write the newest `max` entries (by `at`).
 *
 * @param {string} file
 * @param {string} field
 * @param {Map<string, { at: number }>} map
 * @param {number} max
 */
function writeMap(file, field, map, max) {
  const kept = [...map].sort((a, b) => b[1].at - a[1].at).slice(0, max);
  writeJsonAtomic(file, { v: 1, [field]: Object.fromEntries(kept) });
}

/**
 * @typedef {object} Lease
 * @property {string} file
 * @property {() => void} heartbeat
 * @property {(pid: number) => void} addPid  another process that uses the version (npm, the server's parent)
 * @property {() => void} release
 */

/** @param {unknown} pid @returns {pid is number} */
const isPid = (pid) => Number.isInteger(pid) && /** @type {number} */ (pid) > 1;

/**
 * Claim the exact version a running session (or an install in progress)
 * uses, so cleanup keeps its folder. `pids` are other processes that use it:
 * the lease stays live while any of them runs, also after this one was killed.
 *
 * @param {string} dir
 * @param {{ name: string, version: string, pid?: number, host?: string, pids?: number[] }} claim
 * @returns {Lease | undefined}
 */
export function writeLease(dir, { name, version, pid = process.pid, host = os.hostname(), pids = [] }) {
  const file = path.join(dir, 'sessions', `${pid}-${crypto.randomBytes(4).toString('hex')}.json`);
  const others = pids.filter(isPid);
  const write = () => writeJsonAtomic(file, { v: 1, name, version, pid, host, ...(others.length ? { pids: others } : {}) });
  if (!write()) return undefined;
  return {
    file,
    heartbeat: () => {
      try {
        const t = new Date();
        fs.utimesSync(file, t, t);
      } catch {
        // Cleanup removed a lease it judged dead: write it again.
        write();
      }
    },
    addPid: (p) => {
      if (!isPid(p) || others.includes(p)) return;
      others.push(p);
      write();
    },
    release: () => removeFile(file),
  };
}

/**
 * Whether this process can write session leases at all. Cleanup removes
 * nothing when it cannot: a running session could not have written its
 * lease either. The probe is as large as a lease (a full disk may still
 * take an empty file).
 *
 * @param {string} dir
 */
export function canWriteLeases(dir) {
  const probe = path.join(dir, 'sessions', `.probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    ensureDir(path.dirname(probe));
    fs.writeFileSync(probe, JSON.stringify({ v: 1, name: '@probe/probe-package-name', version: '0.0.0-probe', pid: process.pid, host: os.hostname() }), {
      mode: 0o600,
      flag: 'wx',
    });
    return true;
  } catch {
    return false;
  } finally {
    removeFile(probe);
  }
}

/** @param {number} pid */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

/**
 * Whether a process runs, or (POSIX) a process of the group it leads: an
 * install npm runs in its own group, with its scripts.
 *
 * @param {number} pid
 */
function defaultIsAlive(pid) {
  return isPid(pid) && (processAlive(pid) || (process.platform !== 'win32' && processAlive(-pid)));
}

/**
 * @typedef {object} Leases
 * @property {{ name: string, version: string }[]} leases
 * @property {boolean} complete  false when a lease could not be read: then
 *   anything may be in use, and callers remove nothing
 */

/**
 * What running sessions use (see writeLease). A lease of this machine is
 * live while one of its processes runs (at most LEASE_MAX_MS without a
 * heartbeat: a laptop that slept); one of another machine (a shared cache)
 * while its heartbeat is newer than LEASE_FRESH_MS. Other leases, and files
 * that are not leases, are deleted on the way; a lease that cannot be read
 * (an I/O error) is kept.
 *
 * @param {string} dir
 * @param {{ now?: number, host?: string, isAlive?: (pid: number) => boolean, exclude?: (string | undefined)[] }} [opts]
 *   exclude: lease files of our own
 * @returns {Leases}
 */
export function readLeases(dir, { now = Date.now(), host = os.hostname(), isAlive = defaultIsAlive, exclude = [] } = {}) {
  const skip = new Set(exclude.filter(Boolean));
  const sessions = path.join(dir, 'sessions');
  let names;
  try {
    names = fs.readdirSync(sessions);
  } catch (error) {
    return { leases: [], complete: errorCode(error) === 'ENOENT' };
  }
  /** @type {{ name: string, version: string }[]} */
  const leases = [];
  let complete = true;
  for (const n of names) {
    if (!/^\d+-[0-9a-f]{8}\.json$/.test(n)) continue;
    const file = path.join(sessions, n);
    if (skip.has(file)) continue;
    let mtimeMs;
    let text;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      // ENOENT: released meanwhile.
      if (errorCode(error) !== 'ENOENT') complete = false;
      continue;
    }
    /** @type {any} */
    let lease;
    try {
      lease = JSON.parse(text);
    } catch {
      lease = undefined;
    }
    const age = now - mtimeMs;
    const valid = typeof lease?.name === 'string' && isVersion(lease.version) && isPid(lease.pid);
    const pids = valid ? [lease.pid, ...(Array.isArray(lease.pids) ? lease.pids.filter(isPid) : [])] : [];
    const live = valid && (lease.host === host ? age < LEASE_MAX_MS && pids.some((p) => p === process.pid || isAlive(p)) : age < LEASE_FRESH_MS);
    if (live) leases.push({ name: lease.name, version: lease.version });
    else removeFile(file);
  }
  return { leases, complete };
}

/**
 * The lock every process holds while it installs, replaces, removes or
 * starts the exec cache folder of `spec` (`name@version`).
 *
 * @param {string} spec
 */
export function installLockName(spec) {
  return `install-${crypto.createHash('sha256').update(spec).digest('hex').slice(0, 16)}`;
}

/**
 * @typedef {object} Lock
 * @property {() => boolean} refresh     keeps the lock fresh; false once it is no longer ours
 * @property {(pid: number) => boolean} addPid  a process that works for the owner (npm): the lock is held while it runs
 * @property {() => void} release        removes the lock, only while it is ours
 */

/** @param {string} dir @param {string} name */
function lockPath(dir, name) {
  return path.join(dir, 'locks', `${name}.lock`);
}

/**
 * @typedef {{ now: number, host: string, isAlive: (pid: number) => boolean }} LockClock
 */

/**
 * A lock that nobody will release. One of this machine: none of its
 * processes runs (its owner and the npm it started), or it was not refreshed
 * for LOCK_MAX_MS. One of another machine: not refreshed for LOCK_STALE_MS.
 *
 * @param {string} lock
 * @param {LockClock} opts
 */
function isAbandoned(lock, { now, host, isAlive }) {
  let age;
  try {
    age = now - fs.statSync(lock).mtimeMs;
  } catch {
    return false;
  }
  const owner = readJson(path.join(lock, 'owner.json'));
  if (owner?.host !== host || !isPid(owner?.pid)) return age >= LOCK_STALE_MS;
  const pids = [owner.pid, ...(Array.isArray(owner.pids) ? owner.pids.filter(isPid) : [])];
  return age >= LOCK_MAX_MS || !pids.some((p) => p === process.pid || isAlive(p));
}

/** @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding the lock's guard. Every takeover, release and owner
 * change takes it, so an old owner cannot remove or rewrite a lock that
 * another process took over in between.
 *
 * @template T
 * @param {string} lock
 * @param {() => T} fn
 * @param {{ waitMs?: number }} [opts]
 * @returns {{ ran: true, value: T } | { ran: false }}  ran: false when the guard stayed busy
 */
function withGuard(lock, fn, { waitMs = 0 } = {}) {
  const guard = `${lock}.guard`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(guard, { mode: 0o700 });
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') return { ran: false };
    }
    try {
      if (Date.now() - fs.statSync(guard).mtimeMs >= GUARD_STALE_MS) {
        fs.rmdirSync(guard);
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() >= deadline) return { ran: false };
    sleepSync(5);
  }
  try {
    return { ran: true, value: fn() };
  } finally {
    try {
      fs.rmdirSync(guard);
    } catch {
      // gone already
    }
  }
}

/**
 * Remove an abandoned lock, checking again under the guard.
 *
 * @param {string} lock
 * @param {LockClock} opts
 */
function takeOver(lock, opts) {
  const r = withGuard(lock, () => {
    if (!isAbandoned(lock, opts)) return false;
    const aside = `${lock}.${crypto.randomBytes(4).toString('hex')}.stale`;
    fs.renameSync(lock, aside);
    try {
      fs.rmSync(aside, { recursive: true, force: true });
    } catch {
      // a leftover folder is harmless
    }
    return true;
  });
  return r.ran && r.value;
}

/**
 * A lock against two of our processes installing, starting or removing the
 * same exec cache folder at once (npm 10 has no lock for it; npm 11 locks
 * only its own install). Never waits (see waitForLock). An abandoned lock is
 * taken over. The owner file inside the lock lets a process whose lock was
 * taken over (after a laptop slept) notice it.
 *
 * @param {string} dir
 * @param {string} name  lock name (file-name safe)
 * @param {{ now?: number, host?: string, isAlive?: (pid: number) => boolean }} [opts]
 * @returns {Lock | undefined}
 */
export function tryLock(dir, name, { now = Date.now(), host = os.hostname(), isAlive = defaultIsAlive } = {}) {
  const lock = lockPath(dir, name);
  const ownerFile = path.join(lock, 'owner.json');
  const nonce = crypto.randomBytes(8).toString('hex');
  try {
    ensureDir(path.dirname(lock));
  } catch {
    return undefined;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST' || !takeOver(lock, { now, host, isAlive })) return undefined;
      continue;
    }
    /** @type {number[]} */
    const pids = [];
    const owner = () => ({ v: 1, nonce, pid: process.pid, host, ...(pids.length ? { pids } : {}) });
    try {
      fs.writeFileSync(ownerFile, JSON.stringify(owner()), { mode: 0o600, flag: 'wx' });
    } catch {
      try {
        fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        // nothing else to do
      }
      return undefined;
    }
    const mine = () => readJson(ownerFile)?.nonce === nonce;
    /** @param {number} [attempts] */
    const release = (attempts = 0) => {
      const r = withGuard(lock, () => {
        if (mine()) fs.rmSync(lock, { recursive: true, force: true });
      }, { waitMs: 100 });
      // A busy guard: someone takes over or checks right now. Try again soon.
      if (!r.ran && attempts < 400) setTimeout(() => release(attempts + 1), 100).unref();
    };
    return {
      refresh: () => {
        if (!mine()) return false;
        try {
          const t = new Date();
          fs.utimesSync(lock, t, t);
          return true;
        } catch {
          return false;
        }
      },
      addPid: (pid) => {
        if (!isPid(pid)) return false;
        const r = withGuard(lock, () => {
          if (!mine()) return false;
          pids.push(pid);
          return writeJsonAtomic(ownerFile, owner());
        }, { waitMs: 1000 });
        return r.ran && r.value;
      },
      release: () => {
        try {
          release();
        } catch {
          // already gone
        }
      },
    };
  }
  return undefined;
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * tryLock, waiting while another process holds the lock (it installs the
 * same folder; its work is ours too).
 *
 * @param {string} dir
 * @param {string} name
 * @param {{ timeoutMs: number, signal?: AbortSignal, pollMs?: number }} opts
 * @returns {Promise<{ lock: Lock } | { busy: true } | { unavailable: true } | { stopped: true }>}
 *   busy: still held after timeoutMs; unavailable: locks cannot be created here
 */
export async function waitForLock(dir, name, { timeoutMs, signal, pollMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) return { stopped: true };
    const lock = tryLock(dir, name);
    if (lock) return { lock };
    if (!fs.existsSync(lockPath(dir, name))) {
      // Not held a moment ago: try once more, then give up (an unwritable state folder).
      const again = tryLock(dir, name);
      if (again) return { lock: again };
      if (!fs.existsSync(lockPath(dir, name))) return { unavailable: true };
    }
    if (Date.now() >= deadline) return { busy: true };
    await sleep(pollMs, signal);
  }
}

/** @param {string} dir */
const trashDir = (dir) => path.join(dir, 'trash');
/** @param {string} dir */
const backupDir = (dir) => path.join(dir, 'replaced');
const randomSuffix = () => crypto.randomBytes(4).toString('hex');

/**
 * Move an install folder into `<state>/trash/`, to be deleted later (see
 * emptyTrash). The rename is atomic: a removal that is cut off (a sleep, a
 * kill) cannot delete a folder that another process installs or claims again.
 *
 * @param {string} dir  state folder
 * @param {string} folder
 */
export function moveToTrash(dir, folder) {
  ensureDir(trashDir(dir));
  fs.renameSync(folder, path.join(trashDir(dir), `${path.basename(folder)}.${randomSuffix()}`));
}

/**
 * Delete what is in `<state>/trash/`.
 *
 * @param {string} dir
 */
export async function emptyTrash(dir) {
  let names;
  try {
    names = await fs.promises.readdir(trashDir(dir));
  } catch {
    return;
  }
  for (const n of names) {
    await fs.promises.rm(path.join(trashDir(dir), n), { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {});
  }
}

/**
 * Move an install folder into `<state>/replaced/` before it is installed
 * again, so that it can be put back when the reinstall fails or is cut off
 * (see restoreBackup). Throws when it cannot be moved.
 *
 * @param {string} dir
 * @param {string} folder
 * @returns {string} where it is now
 */
export function backUp(dir, folder) {
  ensureDir(backupDir(dir));
  const target = path.join(backupDir(dir), `${path.basename(folder)}.${randomSuffix()}`);
  fs.renameSync(folder, target);
  const t = new Date();
  fs.utimesSync(target, t, t);
  return target;
}

/**
 * The backups of `folder` (see backUp), newest first.
 *
 * @param {string} dir
 * @param {string} folder
 * @returns {string[]}
 */
function backupsOf(dir, folder) {
  const prefix = `${path.basename(folder)}.`;
  let names;
  try {
    names = fs.readdirSync(backupDir(dir));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(prefix) && /^[0-9a-f]{8}$/.test(n.slice(prefix.length)))
    .flatMap((n) => {
      const p = path.join(backupDir(dir), n);
      try {
        return [{ p, t: fs.statSync(p).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.t - a.t)
    .map((b) => b.p);
}

/**
 * @param {string} dir
 * @param {string} folder
 */
export function hasBackup(dir, folder) {
  return backupsOf(dir, folder).length > 0;
}

/**
 * Put a backup of `folder` back when `folder` is missing: a reinstall was cut
 * off after it moved the copy aside. A backup that `isUsable` rejects once it
 * is back goes to the trash, and the next one is tried, newest first. Call it
 * while holding the folder's install lock.
 *
 * @param {string} dir
 * @param {string} folder
 * @param {() => boolean} isUsable  checks `folder`
 * @returns {boolean} whether a usable backup is back
 */
export function restoreBackup(dir, folder, isUsable) {
  if (fs.existsSync(folder)) return false;
  for (const backup of backupsOf(dir, folder)) {
    try {
      fs.renameSync(backup, folder);
    } catch {
      continue;
    }
    if (isUsable()) return true;
    try {
      moveToTrash(dir, folder);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Move backups that nobody needs into the trash: those whose folder is back
 * for at least an hour (the reinstall finished or was undone), and all older
 * than a week.
 *
 * @param {string} dir
 * @param {string} npxRoot  npm's `_npx` folder
 * @param {number} now
 */
export function sweepBackups(dir, npxRoot, now) {
  let names;
  try {
    names = fs.readdirSync(backupDir(dir));
  } catch {
    return;
  }
  for (const n of names) {
    const p = path.join(backupDir(dir), n);
    const m = /^([0-9a-f]{16})\.[0-9a-f]{8}$/.exec(n);
    try {
      const age = now - fs.statSync(p).mtimeMs;
      const back = !!m && fs.existsSync(path.join(npxRoot, m[1]));
      if (!m || age >= BACKUP_MAX_MS || (back && age >= BACKUP_DONE_MS)) moveToTrash(dir, p);
    } catch {
      // gone meanwhile
    }
  }
}
