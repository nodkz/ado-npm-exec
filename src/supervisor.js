/**
 * Supervision of the inner npm: stop signals, a parent that vanished without
 * one, the token files, and a staged stop of npm's whole process tree.
 */

import os from 'node:os';
import tty from 'node:tty';
import { killProcessTree } from './proc.js';
import { descendantsOf, isAlive, readProcessTable, signalPid } from './tree.js';

/** A repeated signal earlier than this after the first one is a duplicate. */
const FORCE_REPEAT_MS = 1000;
/** The Windows process lookup waits up to this long, so that servers started together do not run PowerShell at once. */
const LOOKUP_JITTER_MS = 2000;

/** @param {NodeJS.Signals} signal */
export function signalExitCode(signal) {
  return 128 + (os.constants.signals[signal] ?? 0);
}

/**
 * @typedef {object} SupervisorOptions
 * @property {NodeJS.Platform} platform
 * @property {NodeJS.ProcessEnv} env
 * @property {boolean} forwards  this npm passes stop signals on to its child
 * @property {Pick<NodeJS.Process, 'on' | 'off'>} signals
 * @property {number} parentWatchMs  how often to check whether our parent exited (0: never)
 * @property {number} stageMs        after a signal, when to signal the processes npm did not pass it to
 * @property {number} killAfterMs    after a signal, when to SIGKILL whatever is left
 * @property {typeof import('./ancestry.js').resolveTopLaunchShim} topShim
 * @property {() => number} random
 * @property {import('./log.js').Logger} log
 */

/**
 * @typedef {object} Supervisor
 * @property {AbortSignal} signal  aborted by a stop signal that arrives before npm starts
 * @property {Set<import('./npmrc.js').TempNpmrc>} temps  token files: removed first on a stop signal
 * @property {() => NodeJS.Signals | undefined} received
 * @property {(stop: () => void) => void} onStop  work to stop on a stop signal (background checks)
 * @property {(child: import('node:child_process').ChildProcess) => void} attach  npm started
 * @property {() => Promise<void>} settle  after npm exited on a stop signal: wait for the rest of its tree, then kill it
 * @property {() => boolean} dispose  undo everything; false when a token file could not be removed
 */

/**
 * A stop signal before npm starts aborts `signal`. After that, the token
 * files are removed first (the client may follow up with SIGKILL), the
 * background work is stopped, then npm's process tree is stopped in stages:
 *   1. npm, plus its direct children when this npm does not pass signals on
 *      (npm 10 traps SIGINT/SIGTERM and ignores them);
 *   2. after stageMs, every other process of the tree that still runs
 *      (launchers that do not pass signals on, install scripts);
 *   3. after killAfterMs, SIGKILL for whatever is left. A second signal that
 *      comes clearly later does this at once.
 * When our parent exits without a signal (an MCP client killed `npm exec`
 * and npm did not pass the signal on), the same shutdown runs. On Windows the
 * client kills only the top shim of the `npm exec` chain, so that one is
 * watched too.
 *
 * @param {SupervisorOptions} o
 * @returns {Supervisor}
 */
export function createSupervisor({ platform, env, forwards, signals, parentWatchMs, stageMs, killAfterMs, topShim, random, log }) {
  const abort = new AbortController();
  /** @type {Set<import('./npmrc.js').TempNpmrc>} */
  const temps = new Set();
  /** @type {Set<() => void>} */
  const stops = new Set();
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  /** @type {NodeJS.Signals | undefined} */
  let received;
  let shutdownAt = 0;
  /** @type {Set<number>} */
  const tracked = new Set();
  /** @type {NodeJS.Timeout[]} */
  const timers = [];

  const cleanupTemps = () => {
    let ok = true;
    for (const t of temps) {
      if (t.cleanup()) temps.delete(t);
      else ok = false;
    }
    return ok;
  };
  const stopWork = () => {
    for (const stop of stops) stop();
  };
  const snapshot = () => {
    const pid = child?.pid;
    if (pid === undefined) return { direct: /** @type {number[]} */ ([]), all: /** @type {number[]} */ ([]) };
    const tree = descendantsOf(pid, readProcessTable(platform));
    tracked.add(pid);
    for (const p of tree.all) tracked.add(p);
    return tree;
  };
  const killTracked = () => {
    snapshot();
    for (const pid of tracked) if (isAlive(pid)) signalPid(pid, 'SIGKILL');
  };
  const othersAlive = () => [...tracked].some((p) => p !== child?.pid && isAlive(p));
  /** @param {NodeJS.Signals} sig @param {boolean} alreadyDelivered */
  const stopChild = (sig, alreadyDelivered) => {
    const pid = child?.pid;
    // Windows has no POSIX signals: Ctrl+C reaches npm through the console,
    // and only a vanished parent needs the tree killed (see the watchdog).
    if (pid === undefined || platform === 'win32') return;
    const term = sig === 'SIGHUP' ? 'SIGTERM' : sig;
    const tree = snapshot();
    const firstWave = new Set([pid, ...tree.direct]);
    if (!alreadyDelivered) {
      if (child?.exitCode === null && child.signalCode === null) signalPid(pid, term);
      if (!forwards) for (const p of tree.direct) signalPid(p, term);
    }
    // Measured from the signal, not from now: the snapshot above can be slow.
    timers.push(
      setTimeout(
        () => {
          snapshot();
          for (const p of tracked) if (!firstWave.has(p) && isAlive(p)) signalPid(p, term);
        },
        Math.max(0, shutdownAt + stageMs - Date.now()),
      ),
      setTimeout(killTracked, Math.max(0, shutdownAt + killAfterMs - Date.now())),
    );
  };
  /** @param {NodeJS.Signals} sig */
  const onSignal = (sig) => {
    cleanupTemps();
    stopWork();
    if (received) {
      // The same signal often arrives twice within milliseconds (an outer npm
      // that passes it on, a process-group kill, a terminal's Ctrl+C). Only a
      // signal that comes clearly later means "stop now".
      if (child && platform !== 'win32' && Date.now() - shutdownAt >= FORCE_REPEAT_MS) killTracked();
      return;
    }
    received = sig;
    shutdownAt = Date.now();
    if (!child) {
      abort.abort();
      return;
    }
    // A terminal's Ctrl+C has already reached every process in our group.
    stopChild(sig, sig === 'SIGINT' && tty.isatty(0));
  };
  /** @type {NodeJS.Signals[]} */
  const handled = platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const s of handled) signals.on(s, onSignal);
  const exitHook = () => cleanupTemps();
  process.on('exit', exitHook);

  const parentPid = process.ppid;
  /** @type {number | undefined} */
  let topShimPid;
  const watchdog =
    parentWatchMs > 0 && parentPid > 1
      ? setInterval(() => {
          const gone =
            platform === 'win32' ? !isAlive(parentPid) || (topShimPid !== undefined && !isAlive(topShimPid)) : process.ppid !== parentPid;
          if (!gone) return;
          clearInterval(watchdog);
          log.debug('the parent process exited; shutting down');
          if (platform !== 'win32') return onSignal('SIGTERM');
          cleanupTemps();
          stopWork();
          received ??= 'SIGTERM';
          if (child) killProcessTree(child, env);
          else abort.abort();
        }, parentWatchMs)
      : undefined;
  watchdog?.unref();
  // Aborted when we finish: PowerShell must not keep a quick exit waiting.
  const lookup = new AbortController();
  if (watchdog && platform === 'win32') {
    const t = setTimeout(() => {
      void topShim(process.pid, { platform, env, signal: lookup.signal }).then(
        (pid) => {
          if (pid !== undefined && pid !== parentPid) {
            topShimPid = pid;
            log.debug(`watching the top launch process ${pid}`);
          }
        },
        () => {},
      );
    }, Math.floor(random() * LOOKUP_JITTER_MS));
    t.unref();
    timers.push(t);
  }

  return {
    signal: abort.signal,
    temps,
    received: () => received,
    onStop: (stop) => void stops.add(stop),
    attach: (c) => {
      child = c;
    },
    settle: async () => {
      if (!received || platform === 'win32') return;
      const deadline = shutdownAt + killAfterMs + 250;
      while (Date.now() < deadline && othersAlive()) await new Promise((r) => setTimeout(r, 100));
      // The timers are cleared by dispose(): whatever still runs is killed now.
      if (othersAlive()) killTracked();
    },
    dispose: () => {
      const ok = cleanupTemps();
      for (const t of timers) clearTimeout(t);
      if (watchdog) clearInterval(watchdog);
      lookup.abort();
      for (const s of handled) signals.off(s, onSignal);
      process.off('exit', exitHook);
      return ok;
    },
  };
}
