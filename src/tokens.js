/**
 * Silent Microsoft Entra ID token acquisition for Azure DevOps:
 * ADO_NPM_EXEC_TOKEN, else az, azd and azureauth, one at a time. Only Entra
 * ID access tokens are accepted, never PATs, and nothing here can prompt.
 */

import { checkEntraToken } from './jwt.js';
import { findOnPath, getEnv, runCapture, safeWorkingDir, withTrustedPath } from './proc.js';
import { ADO_RESOURCE_ID } from './registry.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The per-source timeout from ADO_NPM_EXEC_TIMEOUT_MS (1000 to 120000 ms).
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function timeoutFromEnv(env) {
  const raw = getEnv(env, 'ADO_NPM_EXEC_TIMEOUT_MS');
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 1000 && n <= 120_000 ? n : DEFAULT_TIMEOUT_MS;
}

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

/** @typedef {'az' | 'azd' | 'azureauth'} ToolSource */

/** The order the tools run in when none is remembered for the tenant (see signInMemory). */
const TOOL_ORDER = /** @type {readonly ToolSource[]} */ (Object.freeze(['az', 'azd', 'azureauth']));

/**
 * @typedef {object} Attempt
 * @property {ToolSource} source
 * @property {string} reason
 * @property {boolean} [notFound]  the tool is not installed
 */

/**
 * @typedef {object} AcquiredToken
 * @property {string} token
 * @property {'ADO_NPM_EXEC_TOKEN' | ToolSource} source
 * @property {Record<string, unknown>} claims
 */

/**
 * @typedef {object} AcquireOptions
 * @property {NodeJS.ProcessEnv} env
 * @property {string} [tenant]        tenant GUID, when known
 * @property {boolean} [msa]          the organization is not backed by Entra ID
 * @property {number} [timeoutMs]     per source
 * @property {ToolSource} [prefer]    the tool that gave the last token: it runs first
 * @property {(source: ToolSource) => void} [remember]  told which tool gave the token
 * @property {AbortSignal} [signal]
 * @property {NodeJS.Platform} [platform]
 * @property {() => number} [now]
 * @property {typeof runCapture} [run]
 * @property {typeof findOnPath} [find]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [random]
 * @property {(msg: string) => void} [debug]
 * @property {string} [cwd]           working directory of the tools (default: safeWorkingDir())
 */

/** Environment variables through which azureauth would hand out a PAT. */
const AZUREAUTH_PAT_ENV = ['AZUREAUTH_ADO_PAT', 'SYSTEM_ACCESSTOKEN', 'TF_BUILD'];

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

/**
 * The arguments @azure/identity's AzureDeveloperCliCredential uses.
 *
 * @param {string | undefined} tenant
 */
export function azdArgs(tenant) {
  return ['auth', 'token', '--output', 'json', '--no-prompt', '--scope', `${ADO_RESOURCE_ID}/.default`, ...(tenant ? ['--tenant-id', tenant] : [])];
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
  for (const [k, v] of Object.entries(withTrustedPath(env, platform))) {
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

const LOGIN_PROBLEM_RE = /az login|azd auth login|AADSTS|interaction|expired|not logged in|no account|run .*login/i;

/**
 * The token from `azd auth token --output json`: `{ "token": "...", "expiresOn": "..." }`.
 *
 * @param {string} stdout
 * @returns {string | undefined}
 */
export function parseAzdToken(stdout) {
  const text = stdout.trim();
  const candidates = [text];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start > 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const value = JSON.parse(c);
      if (value && typeof value === 'object' && typeof value.token === 'string') return value.token.trim();
    } catch {
      // try the next candidate
    }
  }
  return undefined;
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
    prefer,
    remember,
    signal,
    platform = process.platform,
    now = Date.now,
    run = runCapture,
    find = findOnPath,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    random = Math.random,
    debug = () => {},
  } = opts;
  const cwd = opts.cwd ?? safeWorkingDir(platform, env);

  const explicit = getEnv(env, 'ADO_NPM_EXEC_TOKEN')?.trim();
  if (explicit) {
    const check = checkEntraToken(explicit, { tenant, nowMs: now() });
    if (!check.ok) {
      throw new TokenError(`ADO_NPM_EXEC_TOKEN is not usable: ${check.reason}.`, {
        hint: 'Unset it to let ado-npm-exec use az/azd/azureauth, or provide a fresh Microsoft Entra ID access token for Azure DevOps.',
      });
    }
    debug('using the token from ADO_NPM_EXEC_TOKEN');
    return { token: explicit, source: 'ADO_NPM_EXEC_TOKEN', claims: check.claims };
  }
  if (signal?.aborted) throw new AbortedError('token acquisition was interrupted');

  /**
   * @param {ToolSource} source
   * @param {string} token
   * @returns {AcquiredToken | Attempt}
   */
  const checked = (source, token) => {
    const check = checkEntraToken(token, { tenant, nowMs: now() });
    return check.ok ? { token, source, claims: check.claims } : { source, reason: `returned an unusable token: ${check.reason}` };
  };

  /**
   * One run of a tool, with the reason it failed.
   *
   * @param {ToolSource} source
   * @param {string} file
   * @param {string[]} args
   * @param {NodeJS.ProcessEnv} toolEnv
   * @param {AbortSignal} toolSignal
   * @param {(stdout: string) => AcquiredToken | Attempt} parse
   * @returns {Promise<{ result: AcquiredToken | Attempt, retryable: boolean }>}
   */
  const runTool = async (source, file, args, toolEnv, toolSignal, parse) => {
    const started = now();
    debug(`running ${file} ${args.join(' ')}`);
    const r = await run(file, args, { env: toolEnv, timeoutMs, signal: toolSignal, cwd });
    if (toolSignal.aborted) return { result: { source, reason: 'stopped' }, retryable: false };
    if (r.error) return { result: { source, reason: `failed to start: ${r.error.message}` }, retryable: false };
    if (r.timedOut) return { result: { source, reason: `timed out after ${timeoutMs} ms` }, retryable: false };
    if (r.code === 0) return { result: parse(r.stdout), retryable: false };
    const reason = summarize(r.stderr) || `exited with code ${r.code}`;
    // A fast failure that is not about the sign-in is usually contention on
    // the shared MSAL token cache when several MCP servers start at once.
    const retryable = !LOGIN_PROBLEM_RE.test(r.stderr) && now() - started < timeoutMs / 2;
    return { result: { source, reason }, retryable };
  };

  /** @type {Record<ToolSource, (s: AbortSignal) => Promise<AcquiredToken | Attempt>>} */
  const providers = {
    az: async (s) => {
      const file = find('az', { env, platform });
      if (!file) return { source: 'az', reason: 'Azure CLI (az) was not found on PATH', notFound: true };
      const toolEnv = withTrustedPath(env, platform);
      const parse = (/** @type {string} */ out) => checked('az', out.trim());
      let { result, retryable } = await runTool('az', file, azArgs(tenant), toolEnv, s, parse);
      if (retryable && !s.aborted) {
        debug(`az failed (${'reason' in result ? result.reason : ''}); retrying once`);
        await sleep(200 + Math.floor(random() * 400));
        if (!s.aborted) ({ result } = await runTool('az', file, azArgs(tenant), toolEnv, s, parse));
      }
      return result;
    },
    azd: async (s) => {
      const file = find('azd', { env, platform });
      if (!file) return { source: 'azd', reason: 'Azure Developer CLI (azd) was not found on PATH', notFound: true };
      const parse = (/** @type {string} */ out) => {
        const token = parseAzdToken(out);
        return token ? checked('azd', token) : { source: /** @type {const} */ ('azd'), reason: 'returned output without a token' };
      };
      return (await runTool('azd', file, azdArgs(tenant), withTrustedPath(env, platform), s, parse)).result;
    },
    azureauth: async (s) => {
      const file = find('azureauth', { env, platform });
      if (!file) return { source: 'azureauth', reason: 'azureauth was not found on PATH', notFound: true };
      const parse = (/** @type {string} */ out) => {
        const text = out.trim();
        const bearer = /^Bearer\s+(\S+)$/.exec(text);
        if (/^Basic\s/i.test(text)) return { source: /** @type {const} */ ('azureauth'), reason: 'returned a PAT, which is not supported' };
        if (!bearer) return { source: /** @type {const} */ ('azureauth'), reason: 'returned output that is not a bearer token' };
        return checked('azureauth', bearer[1]);
      };
      return (await runTool('azureauth', file, azureauthArgs(tenant), azureauthEnv(env, platform), s, parse)).result;
    },
  };

  /** @type {ToolSource[]} */
  const order = prefer && TOOL_ORDER.includes(prefer) ? [prefer, ...TOOL_ORDER.filter((t) => t !== prefer)] : [...TOOL_ORDER];
  const toolSignal = signal ?? new AbortController().signal;
  /** @type {Attempt[]} */
  const attempts = [];
  for (const source of order) {
    const result = await providers[source](toolSignal);
    if (signal?.aborted) throw new AbortedError('token acquisition was interrupted');
    if ('token' in result) {
      debug(`acquired a token via ${result.source}`);
      try {
        remember?.(source);
      } catch (error) {
        debug(`could not remember the sign-in tool: ${/** @type {Error} */ (error)?.message || error}`);
      }
      return result;
    }
    attempts.push(result);
    debug(`${result.source}: ${result.reason}`);
  }
  throw new TokenError('could not acquire a Microsoft Entra ID token for Azure DevOps.', { attempts, hint: buildHint({ attempts, tenant, msa }) });
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
  const signIn =
    'sign in once in a terminal: `ado-npm-exec --login <feed-url>`, or ' +
    `\`az login${tenant ? ` --tenant ${tenant}` : ''} --allow-no-subscriptions\` with AZURE_CORE_LOGIN_EXPERIENCE_V2=off, ` +
    `or \`azd auth login${tenant ? ` --tenant-id ${tenant}` : ''}\``;
  if (attempts.length > 0 && attempts.every((a) => a.notFound)) {
    return `Install the Azure CLI (https://learn.microsoft.com/cli/azure/install-azure-cli), then ${signIn}.`;
  }
  return `To fix it, ${signIn}. Use --verbose for details.`;
}
