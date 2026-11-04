// Fake npm-cli.js, used via npm_execpath in tests. Four kinds of calls:
// - `exec ... -- <spec> [args]` runs the package: the call is recorded in
//   FAKE_NPM_RECORD, then the fake behaves as the FAKE_NPM_* variables say;
// - `exec ... --package=<name>@<version> --call=exit 0` installs into npm's
//   exec cache (--cache) like npm, from --registry (or
//   FAKE_NPM_INSTALL_REGISTRY), and caches the registry metadata;
// - `install --package-lock-only <spec>` writes the version npm picks
//   (FAKE_NPM_RESOLVES, default 1.0.0) into the lockfile in --prefix;
// - `view <name>@<tag> version` prints that version.
// The last three exit with FAKE_NPM_INSTALL_EXIT, printing
// FAKE_NPM_INSTALL_STDERR, and are appended to `${FAKE_NPM_RECORD}.steps`,
// one JSON per line.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedNpxInstall, seedPackument } from '../npm-cache.js';

const recordFile = /** @type {string} */ (process.env.FAKE_NPM_RECORD);
const rc = process.env.npm_config_userconfig;
const argv = process.argv.slice(2);
/** @param {string} name */
const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const installStep = (argv[0] === 'exec' && !!flag('package') && !!flag('call')) || (argv[0] === 'install' && argv.includes('--package-lock-only')) || argv[0] === 'view';
if (installStep) {
  fs.appendFileSync(`${recordFile}.steps`, `${JSON.stringify({ argv, cwd: process.cwd(), npmrc: rc && fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : null })}\n`);
  const code = Number(process.env.FAKE_NPM_INSTALL_EXIT ?? 0);
  if (process.env.FAKE_NPM_INSTALL_STDERR) process.stderr.write(process.env.FAKE_NPM_INSTALL_STDERR);
  if (code === 0) {
    const registry = process.env.FAKE_NPM_INSTALL_REGISTRY || /** @type {string} */ (flag('registry'));
    if (argv[0] === 'view') {
      process.stdout.write(`${process.env.FAKE_NPM_RESOLVES ?? '1.0.0'}\n`);
    } else if (argv[0] === 'install') {
      const spec = /** @type {string} */ (argv.at(-1));
      const at = spec.indexOf('@', 1);
      const name = at > 0 ? spec.slice(0, at) : spec;
      const lock = { lockfileVersion: 3, packages: { '': {}, [`node_modules/${name}`]: { version: process.env.FAKE_NPM_RESOLVES ?? '1.0.0' } } };
      fs.writeFileSync(path.join(/** @type {string} */ (flag('prefix')), 'package-lock.json'), JSON.stringify(lock));
    } else {
      const spec = /** @type {string} */ (flag('package'));
      const at = spec.lastIndexOf('@');
      const cache = /** @type {string} */ (flag('cache'));
      seedNpxInstall(cache, { spec, name: spec.slice(0, at), version: spec.slice(at + 1), registry });
      seedPackument(cache, /** @type {string} */ (flag('registry')), spec.slice(0, at));
    }
  }
  process.exit(code);
}

/** @type {Record<string, unknown>} */
const record = {
  argv,
  env: Object.fromEntries(
    Object.entries(process.env).filter(([k]) => /^(npm_config_|ado_npm_exec_|azureauth_|system_accesstoken|tf_build)/i.test(k)),
  ),
  cwd: process.cwd(),
  npmrc: null,
};
if (rc && fs.existsSync(rc)) {
  record.npmrc = fs.readFileSync(rc, 'utf8');
  record.npmrcMode = fs.statSync(rc).mode & 0o777;
  record.dirMode = fs.statSync(path.dirname(rc)).mode & 0o777;
}
const save = () => fs.writeFileSync(recordFile, JSON.stringify(record));
save();

if (process.env.FAKE_NPM_STDOUT) process.stdout.write(process.env.FAKE_NPM_STDOUT);

if (process.env.FAKE_NPM_KILL_SELF) {
  process.kill(process.pid, 'SIGKILL');
} else if (process.env.FAKE_NPM_SERVER_PID) {
  // Like npm running a bin: the server (optionally behind a launcher) is a
  // child of this process. FAKE_NPM_IGNORE_SIGNALS mimics npm 10, which traps
  // SIGINT/SIGTERM without forwarding them.
  if (process.env.FAKE_NPM_IGNORE_SIGNALS) {
    for (const sig of /** @type {NodeJS.Signals[]} */ (['SIGTERM', 'SIGINT'])) {
      process.on(sig, () => {
        record.npmSignals = [...(/** @type {string[]} */ (record.npmSignals ?? [])), sig];
        save();
      });
    }
  }
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const server = [path.join(dir, '..', 'fake-server.js'), process.env.FAKE_NPM_SERVER_PID, /** @type {string} */ (process.env.FAKE_NPM_SERVER_EVENTS), process.env.FAKE_NPM_SERVER_MODE ?? ''];
  const args = process.env.FAKE_NPM_LAUNCHER ? [path.join(dir, '..', 'fake-launcher.js'), ...server] : server;
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(signal ? 143 : (code ?? 0)));
} else if (process.env.FAKE_NPM_READ_STDIN) {
  /** @type {Buffer[]} */
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    record.stdin = Buffer.concat(chunks).toString('utf8');
    save();
  });
} else if (process.env.FAKE_NPM_WAIT) {
  for (const sig of /** @type {NodeJS.Signals[]} */ (['SIGTERM', 'SIGINT'])) {
    process.on(sig, () => {
      record.gotSignal = sig;
      record.npmrcExistsAtSignal = !!rc && fs.existsSync(rc);
      save();
      process.exit(Number(process.env.FAKE_NPM_SIGNAL_EXIT ?? 0));
    });
  }
  fs.writeFileSync(process.env.FAKE_NPM_WAIT, 'ready');
  setInterval(() => {}, 1000);
} else if (process.env.FAKE_NPM_SLEEP_MS) {
  // A server that runs for a while, then exits on its own.
  setTimeout(() => process.exit(Number(process.env.FAKE_NPM_EXIT ?? 0)), Number(process.env.FAKE_NPM_SLEEP_MS));
} else {
  process.exitCode = Number(process.env.FAKE_NPM_EXIT ?? 0);
}
