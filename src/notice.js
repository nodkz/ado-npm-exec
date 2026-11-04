/**
 * A notice a person must act on ("Sign-in needed"), framed so that it stands
 * out in an MCP client's server log, with the exact commands to copy (never
 * wrapped). All text is redacted and stripped of terminal control sequences.
 */

import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { redact } from './log.js';
import { getEnv } from './proc.js';
import { isGuid, ZERO_GUID } from './tenant.js';

/** @typedef {string | { label: string, command: string }} NoticeCommand */

/**
 * @typedef {object} Notice
 * @property {string} title
 * @property {readonly string[]} paragraphs
 * @property {readonly NoticeCommand[]} [commands]  a label starts a group; unlabeled commands join the one before
 * @property {readonly string[]} [after]            paragraphs after the commands
 * @property {string} [footnote]
 */

/**
 * @typedef {object} NoticeStyle
 * @property {boolean} color   ANSI colors
 * @property {string} prefix   at the start of every line
 * @property {number} width    frame width in columns, not counting the prefix
 */

const PREFIX = 'ado-npm-exec: ';
const MAX_WIDTH = 78;
const MIN_WIDTH = 40;

const FRAME = '\x1b[33m';
const TITLE = '\x1b[1;33m';
const COMMAND = '\x1b[1;36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** Whitespace, except no-break spaces. */
const BREAK = /[^\S\u00a0\u2007\u202f]+/;

/**
 * How to draw a notice on `stream`. Anything but a terminal is most likely an
 * MCP client's log: no escape codes (FORCE_COLOR cannot turn them on there),
 * and a prefix that keeps every line attributable.
 *
 * @param {{ isTTY?: boolean, columns?: number }} stream
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NoticeStyle}
 */
export function noticeStyle(stream, env = process.env) {
  if (!stream.isTTY) return { color: false, prefix: PREFIX, width: MAX_WIDTH };
  const { columns } = stream;
  // One column short of the edge: a full last column makes some terminals wrap.
  const fits = typeof columns === 'number' && columns > 0 ? Math.floor(columns) - 1 : MAX_WIDTH;
  const forceColor = getEnv(env, 'FORCE_COLOR');
  const color = !getEnv(env, 'NO_COLOR') && getEnv(env, 'TERM') !== 'dumb' && forceColor !== '0' && forceColor !== 'false';
  return { color, prefix: '', width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, fits)) };
}

/**
 * Greedy word wrap on whitespace, with "\n" as a hard break. A word longer
 * than `width` (a URL) gets a line of its own, uncut. Blank lines stay single
 * and never lead or trail.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
export function wrap(text, width) {
  /** @type {string[]} */
  const lines = [];
  for (const hard of String(text).split('\n')) {
    let line = '';
    for (const word of hard.split(BREAK)) {
      if (!word) continue;
      if (line && line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line || (lines.length > 0 && lines[lines.length - 1] !== '')) lines.push(line);
  }
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Redacted text without terminal escape sequences and without control
 * characters other than "\n" (CRLF becomes "\n", a tab becomes a space).
 *
 * @param {unknown} text
 * @returns {string}
 */
function clean(text) {
  if (text === undefined || text === null) return '';
  // Redact before and after: removing characters can both hide the shape of a secret and complete it.
  const plain = stripVTControlCharacters(redact(text))
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
  return redact(plain);
}

/** @param {unknown} text */
function oneLine(text) {
  return clean(text).replace(/\s+/g, ' ').trim();
}

/**
 * The notice as text: a leading newline, then a frame without a right edge
 * (a long command would break it), every line prefixed with `style.prefix`.
 * Empty sections are left out. Never narrower than 40 columns.
 *
 * @param {Notice} notice
 * @param {NoticeStyle} style
 * @returns {string}
 */
export function renderNotice(notice, style) {
  const width = Number.isFinite(style.width) ? Math.max(MIN_WIDTH, Math.floor(style.width)) : MAX_WIDTH;
  const paint = (/** @type {string} */ code, /** @type {string} */ text) => (style.color && text ? `${code}${text}${RESET}` : text);
  const bar = paint(FRAME, '│');
  const prose = (/** @type {string} */ text) => (text ? `${bar}  ${text}` : bar);
  const wrapped = (/** @type {unknown} */ text) => wrap(clean(text), width - 3);

  /** @type {string[][]} */
  const blocks = (notice.paragraphs ?? []).map((p) => wrapped(p).map(prose));
  /** @type {string[]} */
  let group = [];
  for (const entry of notice.commands ?? []) {
    const { label, command } = typeof entry === 'string' ? { label: '', command: entry } : entry;
    const lines = clean(command)
      .split('\n')
      .map((l) => l.trimEnd())
      .filter(Boolean);
    if (lines.length === 0) continue;
    const heading = oneLine(label);
    if (heading) {
      blocks.push(group);
      group = [prose(`${heading}:`)];
    }
    group.push(...lines.map((l) => `${bar}    ${paint(COMMAND, l)}`));
  }
  blocks.push(group);
  for (const p of notice.after ?? []) blocks.push(wrapped(p).map(prose));
  blocks.push(wrapped(notice.footnote).map((l) => prose(paint(DIM, l))));

  const title = oneLine(notice.title);
  const top = title
    ? `${paint(FRAME, '┌─')} ${paint(TITLE, title)} ${paint(FRAME, '─'.repeat(Math.max(3, width - title.length - 4)))}`
    : paint(FRAME, `┌${'─'.repeat(width - 1)}`);
  const bottom = paint(FRAME, `└${'─'.repeat(width - 1)}`);
  const lines = [top, bar, ...blocks.filter((b) => b.length > 0).flatMap((b) => [...b, bar]), bottom];
  return `\n${lines.map((l) => `${style.prefix}${l}`).join('\n')}\n`;
}

/**
 * Draw `notice` for `stream` (see noticeStyle) and write it there. Never
 * throws: a closed pipe only means nobody is left to read it.
 *
 * @param {{ write(chunk: string): unknown, isTTY?: boolean, columns?: number }} stream
 * @param {Notice} notice
 * @param {NodeJS.ProcessEnv} [env]
 */
export function writeNotice(stream, notice, env = process.env) {
  try {
    stream.write(renderNotice(notice, noticeStyle(stream, env)));
  } catch {
    // already the diagnostics channel: there is nowhere else to report this
  }
}

/**
 * The shell a person will paste a command into: ADO_NPM_EXEC_SHELL (an
 * override), else SHELL. Other Windows hints (PROMPT, PSModulePath) are not
 * used: they are unreliable when a `.cmd` shim runs from PowerShell.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {'posix' | 'powershell' | 'cmd' | undefined}
 */
export function shellKind(env = process.env, platform = process.platform) {
  const shell = getEnv(env, 'ADO_NPM_EXEC_SHELL')?.trim() || getEnv(env, 'SHELL')?.trim();
  if (!shell) return undefined;
  const name = (platform === 'win32' ? path.win32 : path.posix).parse(shell).name.toLowerCase();
  // Side-by-side installs such as pwsh-preview are PowerShell too.
  if (/^(?:pwsh|powershell)(?:-[\w.]+)?$/.test(name)) return 'powershell';
  if (name === 'cmd') return 'cmd';
  return name ? 'posix' : undefined;
}

/**
 * A tenant that is safe to put in a command: a GUID, never other text. The
 * zero GUID stands for personal Microsoft accounts, not for a tenant.
 *
 * @param {unknown} tenant
 * @returns {string | undefined}
 */
function safeTenant(tenant) {
  return isGuid(tenant) && tenant !== ZERO_GUID ? tenant : undefined;
}

/**
 * The `az login` that leaves a lasting, silent session for this tool, in the
 * syntax of the user's shell, with AZURE_CORE_LOGIN_EXPERIENCE_V2=off (every
 * az version reads it) to turn off the interactive subscription picker.
 * Without a shell signal, Windows gets both the PowerShell and the cmd.exe
 * form, labeled.
 *
 * @param {{ tenant?: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [opts]
 * @returns {NoticeCommand[]}
 */
export function azLoginCommands({ tenant, env = process.env, platform = process.platform } = {}) {
  const t = safeTenant(tenant);
  const login = `az login${t ? ` --tenant ${t}` : ''} --allow-no-subscriptions`;
  const forms = {
    posix: `AZURE_CORE_LOGIN_EXPERIENCE_V2=off ${login}`,
    powershell: `$env:AZURE_CORE_LOGIN_EXPERIENCE_V2='off'; ${login}`,
    // No space before "&&": cmd would keep it as part of the value.
    cmd: `set AZURE_CORE_LOGIN_EXPERIENCE_V2=off&& ${login}`,
  };
  const kind = shellKind(env, platform);
  if (kind) return [forms[kind]];
  if (platform !== 'win32') return [forms.posix];
  return [
    { label: 'PowerShell', command: forms.powershell },
    { label: 'Command Prompt (cmd.exe)', command: forms.cmd },
  ];
}

/**
 * Sign-in for the Azure Developer CLI (azd). The same in every shell.
 *
 * @param {string} [tenant]
 * @returns {string}
 */
export function azdLoginCommand(tenant) {
  const t = safeTenant(tenant);
  return t ? `azd auth login --tenant-id ${t}` : 'azd auth login';
}
