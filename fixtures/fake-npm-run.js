// A fake runCapture for npm: records each call (arguments, working folder,
// what the token file held), then does what npm would: `view` prints the
// version, `install --package-lock-only` writes the lockfile into its
// folder, and `exec --package=<spec>` installs into npm's exec cache and
// caches the registry metadata (the full form when npm's `before` setting is
// on, like pacote). It reports FAKE_NPM_PID as the started process.
import fs from 'node:fs';
import path from 'node:path';
import { seedNpxInstall, seedPackument } from './npm-cache.js';

export const FAKE_NPM_PID = 2_000_000_001;

/** @param {string} spec */
const nameOf = (spec) => {
  const at = spec.indexOf('@', 1);
  return at > 0 ? spec.slice(0, at) : spec;
};

/**
 * @typedef {object} FakeNpmBehavior
 * @property {string} [feed]        the registry the install comes from (default: --registry)
 * @property {number} [code]        exit code
 * @property {string} [stderr]
 * @property {boolean} [aborted]
 * @property {boolean} [timedOut]
 * @property {boolean} [complete]   whether the install completes
 * @property {boolean} [packument]  whether the install caches the registry metadata (default true)
 * @property {string} [resolvesTo]  the version `view` and `install` pick (default 0.0.0)
 * @property {string} [installs]    the version `exec --package` installs (default: the one asked for)
 * @property {(args: readonly string[], signal?: AbortSignal) => unknown} [during]  runs while "npm" runs
 */

/**
 * @param {string} cacheDir
 * @param {FakeNpmBehavior} [behave]
 */
export function fakeNpmRun(cacheDir, behave = {}) {
  /** @type {{ args: readonly string[], cwd?: string, npmrc?: string, env: NodeJS.ProcessEnv }[]} */
  const calls = [];
  /** @type {import('../src/proc.js').runCapture} */
  const run = async (_file, args, { env, cwd, signal, onSpawn }) => {
    const rc = env.npm_config_userconfig;
    calls.push({ args, cwd, env, npmrc: rc && fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : undefined });
    onSpawn?.(FAKE_NPM_PID);
    await behave.during?.(args, signal);
    const aborted = !!behave.aborted || !!signal?.aborted;
    const failed = aborted || !!behave.timedOut || (behave.code ?? 0) !== 0;
    /** @param {string} [stdout] */
    const result = (stdout = '') => ({
      code: aborted ? null : (behave.code ?? 0),
      signal: null,
      stdout,
      stderr: behave.stderr ?? '',
      timedOut: !!behave.timedOut,
      aborted,
    });
    if (failed) return result();
    const flag = (/** @type {string} */ n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
    if (args[1] === 'view') return result(`${behave.resolvesTo ?? '0.0.0'}\n`);
    if (args[1] === 'install') {
      const name = nameOf(/** @type {string} */ (args.at(-1)));
      const lock = { lockfileVersion: 3, packages: { '': {}, [`node_modules/${name}`]: { version: behave.resolvesTo ?? '0.0.0' } } };
      fs.writeFileSync(path.join(/** @type {string} */ (cwd), 'package-lock.json'), JSON.stringify(lock));
      return result();
    }
    const pkg = flag('package') ?? '';
    const name = pkg.slice(0, pkg.lastIndexOf('@'));
    const registry = /** @type {string} */ (flag('registry'));
    seedNpxInstall(cacheDir, { spec: pkg, name, version: behave.installs ?? pkg.slice(pkg.lastIndexOf('@') + 1), complete: behave.complete ?? true, registry: behave.feed ?? registry });
    if (behave.packument !== false) seedPackument(cacheDir, registry, name, env.npm_config_before ? { accept: 'application/json' } : {});
    return result();
  };
  return { calls, run };
}
