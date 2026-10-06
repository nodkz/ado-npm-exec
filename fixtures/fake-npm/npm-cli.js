// Fake npm-cli.js: records what ado-npm-exec handed to "npm", then behaves
// as instructed by FAKE_NPM_* variables. Used via npm_execpath in tests.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const recordFile = /** @type {string} */ (process.env.FAKE_NPM_RECORD);
const rc = process.env.npm_config_userconfig;

/** @type {Record<string, unknown>} */
const record = {
  argv: process.argv.slice(2),
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
} else {
  process.exitCode = Number(process.env.FAKE_NPM_EXIT ?? 0);
}
