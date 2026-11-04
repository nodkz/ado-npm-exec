/**
 * Cleanup of npm exec cache folders this tool installed: each exact version
 * gets its own `_npx/<hash>` folder, so old ones pile up. A running server
 * loads code lazily, long after it started, so a folder in use must never
 * disappear.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isSinglePackageNpxDir, npxInstallDir } from './npm-cache.js';
import {
  canWriteLeases,
  emptyTrash,
  installLockName,
  listStates,
  moveToTrash,
  readLeases,
  removeStateIf,
  STATE_UNUSED_MS,
  sweepBackups,
  tryLock,
  updateState,
} from './state.js';

/**
 * Remove the folders of versions this tool installed for the packages
 * `names` that nothing uses any more: no spec started or checked in the last
 * STATE_UNUSED_MS has it as its current or previous version, and no running
 * session holds a lease on it. Each folder leaves under its install lock (a
 * start takes it too), after the leases were read again: it is renamed into
 * the trash, which is deleted afterwards, so that a deletion cut off by a
 * sleep cannot hit a folder another process claimed since. Nothing is
 * removed while a lease cannot be read or written. A record nobody used for
 * STATE_UNUSED_MS goes too, once its folders are gone and if nobody changed
 * it meanwhile. Old backups of interrupted reinstalls go to the trash too.
 *
 * @param {{ cacheDir: string, dir: string, names: readonly string[], now?: number, debug?: (msg: string) => void }} opts
 * @returns {Promise<string[]>} the removed `name@version` specs
 */
export async function collectGarbage({ cacheDir, dir, names, now = Date.now(), debug = () => {} }) {
  const wanted = new Set(names);
  const states = listStates(dir).filter((s) => wanted.has(s.state.name));
  if (states.length === 0) return [];
  if (!canWriteLeases(dir)) {
    debug(`not removing old versions: leases cannot be written in ${dir}`);
    return [];
  }
  const leased = () => {
    const { leases, complete } = readLeases(dir, { now });
    return complete ? new Set(leases.map((l) => `${l.name}@${l.version}`)) : undefined;
  };
  const keep = leased();
  if (!keep) {
    debug('not removing old versions: a session lease cannot be read');
    return [];
  }
  /** @type {Set<string>} */
  const unused = new Set();
  for (const { key, state } of states) {
    const active = Math.max(state.usedAt ?? -Infinity, state.checkedAt ?? -Infinity);
    // A record that says neither when it was started nor checked is kept.
    if (!Number.isFinite(active) || now - active < STATE_UNUSED_MS) {
      for (const v of [state.version, state.previous]) if (v) keep.add(`${state.name}@${v}`);
    } else {
      unused.add(key);
    }
  }

  /** @type {Set<string>} */
  const removed = new Set();
  for (const spec of new Set(states.flatMap(({ state }) => (state.installed ?? []).map((v) => `${state.name}@${v}`)))) {
    if (keep.has(spec)) continue;
    const name = spec.slice(0, spec.lastIndexOf('@'));
    const folder = npxInstallDir(cacheDir, [spec]);
    if (fs.existsSync(path.join(folder, 'package.json')) && !isSinglePackageNpxDir(folder, name)) {
      debug(`not removing ${folder}: it holds more than ${name}`);
      continue;
    }
    const lock = tryLock(dir, installLockName(spec), { now });
    if (!lock) {
      debug(`not removing ${spec}: another process installs, starts or removes it`);
      continue;
    }
    try {
      const inUse = leased();
      if (!inUse || inUse.has(spec)) {
        debug(`not removing ${spec}: a running session may use it`);
        continue;
      }
      // The last check that the lock is still ours (a sleep can take it away).
      if (!lock.refresh()) continue;
      if (fs.existsSync(folder)) moveToTrash(dir, folder);
      removed.add(spec);
      debug(`removed ${spec} from npm's exec cache`);
    } catch (error) {
      debug(`could not remove ${folder}: ${/** @type {Error} */ (error).message}`);
    } finally {
      lock.release();
    }
  }

  for (const { key, state } of states) {
    const left = (state.installed ?? []).filter((v) => !removed.has(`${state.name}@${v}`));
    if (unused.has(key) && left.length === 0) {
      if (!removeStateIf(dir, key, state)) debug(`kept the record of ${state.spec}: it changed meanwhile`);
    } else if (left.length !== (state.installed ?? []).length) {
      updateState(dir, key, state, (s) => {
        s.installed = (s.installed ?? []).filter((v) => !removed.has(`${s.name}@${v}`));
      });
    }
  }
  sweepBackups(dir, path.join(cacheDir, '_npx'), now);
  await emptyTrash(dir);
  return [...removed];
}
