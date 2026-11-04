// A stand-in for az, azd and azureauth, run through the wrappers that
// installFakeTools() writes (the tool name comes first). Every call is
// appended to FAKE_TOOL_LOG as one JSON line. A token request prints
// FAKE_<TOOL>_TOKEN in the tool's own format, or fails like a tool without a
// sign-in when that is unset. `az login` / `azd auth login` print a
// subscription list to stdout, report what they read from stdin on stderr,
// and exit with FAKE_LOGIN_EXIT (default 0).
import fs from 'node:fs';

const [tool = '', ...args] = process.argv.slice(2);
const login = (tool === 'az' && args[0] === 'login') || (tool === 'azd' && args[0] === 'auth' && args[1] === 'login');
/** @type {string | undefined} */
let stdin;
if (login) {
  try {
    stdin = fs.readFileSync(0, 'utf8');
  } catch {
    stdin = undefined;
  }
}
const log = process.env.FAKE_TOOL_LOG;
if (log) {
  const env = Object.fromEntries(
    ['PATH', 'Path', 'AZURE_CORE_LOGIN_EXPERIENCE_V2', 'AZUREAUTH_NO_USER'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]),
  );
  const label = process.env.FAKE_TOOL_LABEL ?? '';
  fs.appendFileSync(log, `${JSON.stringify({ tool, label, args, cwd: process.cwd(), env, ...(login ? { stdin } : {}) })}\n`);
}

if (login) {
  process.stdout.write('[ { "name": "FAKE SUBSCRIPTION LIST" } ]\n');
  process.stderr.write(`fake ${tool} login read ${JSON.stringify(stdin)} from stdin\n`);
  process.exit(Number(process.env.FAKE_LOGIN_EXIT ?? 0));
}

const token = process.env[`FAKE_${tool.toUpperCase()}_TOKEN`];
if (!token) {
  const noSignIn = {
    az: "ERROR: Please run 'az login' to setup account.",
    azd: 'ERROR: not logged in, run `azd auth login` to login',
    azureauth: 'no account',
  };
  process.stderr.write(`${noSignIn[/** @type {'az' | 'azd' | 'azureauth'} */ (tool)] ?? 'unknown tool'}\n`);
  process.exit(1);
}
if (tool === 'azd') process.stdout.write(`${JSON.stringify({ token, expiresOn: '2099-01-01T00:00:00Z' })}\n`);
else if (tool === 'azureauth') process.stdout.write(`${'Bear' + 'er'} ${token}\n`);
else process.stdout.write(`${token}\n`);
