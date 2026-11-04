/**
 * `--login`: one interactive sign-in (az, or azd when only azd is installed)
 * for the feed's tenant, then a check that a token now comes silently. The
 * tool is remembered, so the next start reuses this sign-in. Terminal only:
 * from an MCP client, a sign-in would open a browser nobody expects.
 */

import { spawn } from 'node:child_process';
import { signInNotice, unsupportedOrgNotice } from './messages.js';
import { writeNotice } from './notice.js';
import { buildCommand, findOnPath, getEnv, safeWorkingDir, withTrustedPath } from './proc.js';
import { signInMemory } from './state.js';
import { timeoutFromEnv, TokenError } from './tokens.js';

/**
 * @typedef {object} LoginOptions
 * @property {import('./registry.js').Registry} registry
 * @property {string | undefined} tenant
 * @property {NodeJS.ProcessEnv} env
 * @property {NodeJS.Platform} platform
 * @property {import('./log.js').Logger} log
 * @property {{ write: (s: string) => void, isTTY: boolean, columns?: number }} noticeStream
 * @property {typeof import('./tenant.js').discoverTenant} discover
 * @property {typeof import('./tokens.js').acquireToken} acquire
 * @property {string} [dir]  state folder (see stateDir), to remember the sign-in tool
 * @property {boolean} stdinIsTTY
 * @property {boolean} stderrIsTTY
 * @property {typeof findOnPath} [find]
 * @property {(command: string, args: string[], options: import('node:child_process').SpawnOptions) => import('node:child_process').ChildProcess} [spawnImpl]
 */

/**
 * The command that signs in, for the tool that is installed.
 *
 * @param {{ tool: 'az' | 'azd', tenant?: string }} info
 * @returns {string[]}
 */
export function loginArgs({ tool, tenant }) {
  if (tool === 'azd') return ['auth', 'login', ...(tenant ? ['--tenant-id', tenant] : [])];
  return ['login', ...(tenant ? ['--tenant', tenant] : []), '--allow-no-subscriptions'];
}

/**
 * @param {LoginOptions} o
 * @returns {Promise<number>} exit code
 */
export async function runLogin(o) {
  const { registry, env, platform, log, find = findOnPath, spawnImpl = spawn } = o;
  if (!o.stdinIsTTY || !o.stderrIsTTY) {
    log.error('--login signs in interactively, so it needs a terminal. Run it in a terminal, not from an MCP client configuration.');
    return 2;
  }
  let tenant = o.tenant;
  if (!tenant) {
    const found = await o.discover(registry.href);
    if (found.msa) {
      writeNotice(o.noticeStream, unsupportedOrgNotice({ hint: 'This Azure DevOps organization is not connected to Microsoft Entra ID. Only Entra ID tokens are supported; PATs are deliberately not used.' }), env);
      return 3;
    }
    tenant = found.tenant;
    if (tenant) log.info(`the feed belongs to tenant ${tenant}`);
    else log.info(`could not discover the feed's tenant${found.error ? ` (${found.error})` : ''}; signing in to your home tenant. Pass --tenant <guid> to choose one.`);
  }

  const az = find('az', { env, platform });
  const azd = az ? undefined : find('azd', { env, platform });
  if (!az && !azd) {
    writeNotice(
      o.noticeStream,
      signInNotice({ feed: registry.href, tenant, env, platform, attempts: [{ source: 'az', reason: 'not found', notFound: true }, { source: 'azd', reason: 'not found', notFound: true }] }),
      env,
    );
    return 3;
  }
  const tool = az ? 'az' : 'azd';
  const file = /** @type {string} */ (az ?? azd);
  const args = loginArgs({ tool, tenant });
  /** @type {NodeJS.ProcessEnv} */
  // az without its subscription prompt.
  const toolEnv = { ...withTrustedPath(env, platform), ...(tool === 'az' ? { AZURE_CORE_LOGIN_EXPERIENCE_V2: 'off' } : {}) };
  log.info(`running ${tool} ${args.join(' ')}`);
  const code = await new Promise((resolve) => {
    let cmd;
    try {
      cmd = buildCommand(file, args, platform);
    } catch (error) {
      log.error(/** @type {Error} */ (error).message);
      resolve(1);
      return;
    }
    // The tool's stdout (az prints the account list there) goes to our stderr:
    // stdout stays clean even in an action.
    const child = spawnImpl(cmd.command, cmd.args, { stdio: ['inherit', 2, 'inherit'], env: toolEnv, cwd: safeWorkingDir(platform, env), shell: cmd.shell });
    child.once('error', (error) => {
      log.error(`could not start ${tool}: ${error.message}`);
      resolve(1);
    });
    child.once('exit', (c, signal) => resolve(signal ? 1 : (c ?? 1)));
  });
  if (code !== 0) {
    log.error(`${tool} sign-in did not finish (exit code ${code}).`);
    return 3;
  }

  try {
    // The check is about the tools' sign-in: ADO_NPM_EXEC_TOKEN would answer instead of them.
    const checkEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k.toLowerCase() !== 'ado_npm_exec_token'));
    const acquired = await o.acquire({
      env: checkEnv,
      tenant,
      platform,
      timeoutMs: timeoutFromEnv(env),
      debug: (m) => log.debug(m),
      ...signInMemory(o.dir, tenant),
      prefer: tool,
    });
    const c = acquired.claims;
    const who = [c.upn, c.unique_name, c.preferred_username, c.appid].find((v) => typeof v === 'string' && v);
    log.info(
      `signed in${who ? ` as ${who}` : ''} (tenant ${c.tid ?? 'unknown'}): ${acquired.source} now gives a token silently. ` +
        `Restart the server; if ${registry.href} still refuses access, the account needs the Reader role on the feed.`,
    );
    if (getEnv(env, 'ADO_NPM_EXEC_TOKEN')) log.info('note: ADO_NPM_EXEC_TOKEN is set, and it takes precedence over this sign-in.');
    return 0;
  } catch (error) {
    if (!(error instanceof TokenError)) throw error;
    log.error(`signed in, but still no usable token: ${error.message}`);
    for (const a of error.attempts) log.error(`  ${a.source}: ${a.reason}`);
    return 3;
  }
}
