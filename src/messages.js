/**
 * The framed notices for problems a person has to act on.
 */

import { azdLoginCommand, azLoginCommands } from './notice.js';

/**
 * Label a lone unlabeled command, so the next labeled one does not read as its continuation.
 *
 * @param {import('./notice.js').NoticeCommand[]} commands
 * @param {string} label
 * @returns {import('./notice.js').NoticeCommand[]}
 */
function withLabel(commands, label) {
  return commands.length === 1 && typeof commands[0] === 'string' ? [{ label, command: commands[0] }] : commands;
}

/**
 * @param {{ feed: string, tenant?: string, attempts: import('./tokens.js').Attempt[], env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform }} info
 * @returns {import('./notice.js').Notice}
 */
export function signInNotice({ feed, tenant, attempts, env, platform }) {
  const nothingInstalled = attempts.length > 0 && attempts.every((a) => a.notFound);
  const tried = attempts.filter((a) => !a.notFound).map((a) => `${a.source}: ${a.reason}`);
  return {
    title: 'Sign-in needed',
    paragraphs: [
      `ado-npm-exec needs a Microsoft Entra ID token to read ${feed}, and none of az, azd or azureauth had one.`,
      ...tried,
      nothingInstalled
        ? 'Install the Azure CLI (https://learn.microsoft.com/cli/azure/install-azure-cli), then sign in once (no subscription prompt) and restart the server:'
        : 'Sign in once (no subscription prompt), then restart the server:',
    ],
    commands: [...withLabel(azLoginCommands({ tenant, env, platform }), 'Azure CLI'), { label: 'Or the Azure Developer CLI', command: azdLoginCommand(tenant) }],
    footnote: 'Run with --verbose for details.',
  };
}

/**
 * @param {{ feed: string, status: number, detail: string, claims?: Record<string, unknown>, tenant?: string,
 *   env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} info
 * @returns {import('./notice.js').Notice}
 */
export function refusedNotice({ feed, status, detail, claims = {}, tenant, env, platform }) {
  const who = [claims.upn, claims.unique_name, claims.preferred_username, claims.appid].find((v) => typeof v === 'string' && v);
  const tid = typeof claims.tid === 'string' ? claims.tid : undefined;
  return {
    title: 'Sign-in refused',
    paragraphs: [
      `${feed} refused the token${who ? ` of ${who}` : ''}${tid ? ` (tenant ${tid})` : ''} with HTTP ${status}${detail ? ` (${detail})` : ''}.`,
      'That account needs the Reader role on the feed (or on the feed view in the URL). Ask the feed owner for access, or sign in with an account that has it:',
    ],
    commands: azLoginCommands({ tenant: tenant ?? tid, env, platform }),
    footnote: 'Run with --verbose for details.',
  };
}

/**
 * @param {{ hint: string }} info
 * @returns {import('./notice.js').Notice}
 */
export function unsupportedOrgNotice({ hint }) {
  return { title: 'Organization not supported', paragraphs: [hint] };
}
