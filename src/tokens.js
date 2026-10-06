/**
 * Silent Microsoft Entra ID token acquisition for Azure DevOps.
 *
 * Order: ADO_NPM_EXEC_TOKEN, then Azure CLI, then azureauth. Only Entra ID
 * access tokens (JWTs for the Azure DevOps resource) are ever accepted:
 * personal access tokens are deliberately not supported, so azureauth's own
 * PAT-from-environment paths are switched off and a "Basic" answer from it
 * is rejected. Nothing here can prompt: stdin is closed, az never prompts,
 * and azureauth runs with AZUREAUTH_NO_USER=1.
 */

import { checkEntraToken } from './jwt.js';
import { findOnPath, getEnv, runCapture, withoutNodeModulesBins } from './proc.js';
import { ADO_RESOURCE_ID } from './registry.js';

export const DEFAULT_TIMEOUT_MS = 10_000;

export class TokenError extends Error {
  name = 'TokenError';
  /**
   * @param {string} message
   * @param {{ attempts?: Attempt[], hint?: string }} [details]
   */
  constructor(message, { attempts = [], hint = '' } = {}) {
    super(message);
    this.attempts = attempts;
    this.hint = hint;
  }
}

export class AbortedError extends Error {
  name = 'AbortedError';
}

/**
 * @typedef {object} Attempt
 * @property {'az' | 'azureauth'} source
 * @property {string} reason
 * @property {boolean} [notFound]
 */

/**
 * @typedef {object} AcquiredToken
 * @property {string} token
 * @property {'ADO_NPM_EXEC_TOKEN' | 'az' | 'azureauth'} source
 * @property {Record<string, unknown>} claims
 */

/**
 * @typedef {object} AcquireOptions
 * @property {NodeJS.ProcessEnv} env
 * @property {string} [tenant]        tenant GUID, when known
 * @property {boolean} [msa]          the organization is not backed by Entra ID
 * @property {number} [timeoutMs]     per provider
 * @property {AbortSignal} [signal]
 * @property {NodeJS.Platform} [platform]
 * @property {() => number} [now]
 * @property {typeof runCapture} [run]
 * @property {typeof findOnPath} [find]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [random]
 * @property {(msg: string) => void} [debug]
 */

/** Environment variables through which azureauth would hand out a PAT. */
export const AZUREAUTH_PAT_ENV = ['AZUREAUTH_ADO_PAT', 'SYSTEM_ACCESSTOKEN', 'TF_BUILD'];

/** @param {string | undefined} tenant */
export function azArgs(tenant) {
  return [
    'account',
    'get-access-token',
    '--resource',
    ADO_RESOURCE_ID,
    '--query',
    'accessToken',
    '--output',
    'tsv',
    ...(tenant ? ['--tenant', tenant] : []),
  ];
}

/** @param {string | undefined} tenant */
export function azureauthArgs(tenant) {
  // No --mode: "broker" is rejected by older releases on macOS/Linux, and where
  // it is accepted it replaces the cached-account lookup. With
  // AZUREAUTH_NO_USER=1 the default mode is silent: the cached account
  // everywhere, plus Integrated Windows Auth on Windows.
  // --timeout is in minutes; our own timer enforces the real limit.
  return ['ado', 'token', '--output', 'headervalue', '--timeout', '1', ...(tenant ? ['--tenant', tenant] : [])];
}

/**
 * Environment for az: workspace `node_modules/.bin` entries removed from PATH.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} [platform]
 */
export function azEnv(env, platform) {
  return withoutNodeModulesBins(env, platform);
}

/**
 * azureauth's environment: silent only, without the variables it would read
 * a PAT from, and without workspace `node_modules/.bin` entries on PATH.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} [platform]
 * @returns {NodeJS.ProcessEnv}
 */
export function azureauthEnv(env, platform) {
  const blocked = new Set(AZUREAUTH_PAT_ENV.map((k) => k.toLowerCase()));
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [k, v] of Object.entries(withoutNodeModulesBins(env, platform))) {
    const lower = k.toLowerCase();
    if (blocked.has(lower) || lower === 'azureauth_no_user') continue;
    out[k] = v;
  }
  out.AZUREAUTH_NO_USER = '1';
  return out;
}

/** Most useful single line of a CLI's stderr. @param {string} text */
function summarize(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.find((l) => /error|AADSTS|login|denied|expired/i.test(l)) ?? lines[0] ?? '';
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/**
 * @param {AcquireOptions} opts
 * @returns {Promise<AcquiredToken>}
 */
export async function acquireToken(opts) {
  const {
    env,
    tenant,
    msa = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    platform = process.platform,
    now = Date.now,
    run = runCapture,
    find = findOnPath,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    random = Math.random,
    debug = () => {},
  } = opts;

  const explicit = getEnv(env, 'ADO_NPM_EXEC_TOKEN')?.trim();
  if (explicit) {
    const check = checkEntraToken(explicit, { tenant, nowMs: now() });
    if (!check.ok) {
      throw new TokenError(`ADO_NPM_EXEC_TOKEN is not usable: ${check.reason}.`, {
        hint: 'Unset it to let ado-npm-exec use az/azureauth, or provide a fresh Microsoft Entra ID access token for Azure DevOps.',
      });
    }
    debug('using the token from ADO_NPM_EXEC_TOKEN');
    return { token: explicit, source: 'ADO_NPM_EXEC_TOKEN', claims: check.claims };
  }

  /** @type {Attempt[]} */
  const attempts = [];
  const assertNotAborted = () => {
    if (signal?.aborted) throw new AbortedError('token acquisition was interrupted');
  };

  /** @returns {Promise<AcquiredToken | undefined>} */
  const tryAz = async () => {
    const file = find('az', { env, platform });
    if (!file) {
      attempts.push({ source: 'az', reason: 'Azure CLI (az) was not found on PATH', notFound: true });
      return undefined;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = now();
      debug(`running ${file} ${azArgs(tenant).join(' ')}`);
      const r = await run(file, azArgs(tenant), { env: azEnv(env, platform), timeoutMs, signal });
      assertNotAborted();
      let reason;
      if (r.error) reason = `failed to start: ${r.error.message}`;
      else if (r.timedOut) reason = `timed out after ${timeoutMs} ms`;
      else if (r.code === 0) {
        const token = r.stdout.trim();
        const check = checkEntraToken(token, { tenant, nowMs: now() });
        if (check.ok) return { token, source: 'az', claims: check.claims };
        reason = `returned an unusable token: ${check.reason}`;
      } else {
        reason = summarize(r.stderr) || `exited with code ${r.code}`;
        // A fast, non-login failure is usually contention on the shared MSAL
        // token cache when several MCP servers start at once: retry once.
        const loginProblem = /az login|AADSTS|interaction|expired|not logged/i.test(r.stderr);
        if (attempt === 1 && !loginProblem && now() - started < timeoutMs / 2) {
          debug(`az failed (${reason}); retrying once`);
          await sleep(200 + Math.floor(random() * 400));
          assertNotAborted();
          continue;
        }
      }
      attempts.push({ source: 'az', reason });
      return undefined;
    }
    return undefined;
  };

  /** @returns {Promise<AcquiredToken | undefined>} */
  const tryAzureauth = async () => {
    const file = find('azureauth', { env, platform });
    if (!file) {
      attempts.push({ source: 'azureauth', reason: 'azureauth was not found on PATH', notFound: true });
      return undefined;
    }
    debug(`running ${file} ${azureauthArgs(tenant).join(' ')}`);
    const r = await run(file, azureauthArgs(tenant), { env: azureauthEnv(env, platform), timeoutMs, signal });
    assertNotAborted();
    let reason;
    if (r.error) reason = `failed to start: ${r.error.message}`;
    else if (r.timedOut) reason = `timed out after ${timeoutMs} ms`;
    else if (r.code !== 0) reason = summarize(r.stderr) || `exited with code ${r.code}`;
    else {
      const out = r.stdout.trim();
      const bearer = /^Bearer\s+(\S+)$/.exec(out);
      if (/^Basic\s/i.test(out)) reason = 'returned a PAT, which is not supported';
      else if (!bearer) reason = 'returned output that is not a Bearer token';
      else {
        const check = checkEntraToken(bearer[1], { tenant, nowMs: now() });
        if (check.ok) return { token: bearer[1], source: 'azureauth', claims: check.claims };
        reason = `returned an unusable token: ${check.reason}`;
      }
    }
    attempts.push({ source: 'azureauth', reason });
    return undefined;
  };

  for (const provider of [tryAz, tryAzureauth]) {
    assertNotAborted();
    const result = await provider();
    if (result) {
      debug(`acquired a token via ${result.source}`);
      return result;
    }
    debug(`${attempts[attempts.length - 1].source}: ${attempts[attempts.length - 1].reason}`);
  }

  throw new TokenError('could not acquire a Microsoft Entra ID token for Azure DevOps.', {
    attempts,
    hint: buildHint({ attempts, tenant, msa }),
  });
}

/**
 * @param {{ attempts: Attempt[], tenant?: string, msa?: boolean }} info
 * @returns {string}
 */
export function buildHint({ attempts, tenant, msa }) {
  if (msa) {
    return (
      'This Azure DevOps organization is not connected to Microsoft Entra ID. ' +
      'Only Entra ID tokens are supported; PATs are deliberately not used.'
    );
  }
  const login = `az login${tenant ? ` --tenant ${tenant}` : ''} --allow-no-subscriptions`;
  if (attempts.length > 0 && attempts.every((a) => a.notFound)) {
    return `Install Azure CLI (https://learn.microsoft.com/cli/azure/install-azure-cli), run \`${login}\`, then try again.`;
  }
  return `Run \`${login}\` and try again. Use --verbose for details.`;
}
