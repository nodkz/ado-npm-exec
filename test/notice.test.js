import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { addSecret } from '../src/log.js';
import { azdLoginCommand, azLoginCommands, noticeStyle, renderNotice, shellKind, wrap, writeNotice } from '../src/notice.js';
import { ZERO_GUID } from '../src/tenant.js';
import { TENANT, validJwt } from '../fixtures/jwt.js';

/** @typedef {import('../src/notice.js').Notice} Notice */

const PIPED = { color: false, prefix: 'ado-npm-exec: ', width: 78 };
const PLAIN_40 = { color: false, prefix: '', width: 40 };
const TOP_T_40 = `┌─ T ${'─'.repeat(35)}`;
const BOTTOM_40 = `└${'─'.repeat(39)}`;
/** Only the codes the notice paints with. */
const OUR_CODES = /\x1b\[(?:33|1;33|1;36|2|0)m/g;

const POSIX_LOGIN = `AZURE_CORE_LOGIN_EXPERIENCE_V2=off az login --tenant ${TENANT} --allow-no-subscriptions`;
const PWSH_LOGIN = `$env:AZURE_CORE_LOGIN_EXPERIENCE_V2='off'; az login --tenant ${TENANT} --allow-no-subscriptions`;
const CMD_LOGIN = `set AZURE_CORE_LOGIN_EXPERIENCE_V2=off&& az login --tenant ${TENANT} --allow-no-subscriptions`;
const URL = 'https://example.invalid/a/very/long/link/that/does/not/fit/in/the/frame';

/** @type {Notice} */
const SAMPLE = {
  title: 'Sign-in needed',
  paragraphs: [
    'ado-npm-exec could not get a Microsoft Entra ID token for the Azure DevOps feed. Sign in once in a terminal; later starts are silent.',
    `Details: ${URL}`,
  ],
  commands: [
    { label: 'PowerShell', command: PWSH_LOGIN },
    { label: 'Command Prompt (cmd.exe)', command: CMD_LOGIN },
  ],
  after: ['Then restart the MCP server.'],
  footnote: 'az: AADSTS70043: The refresh token has expired due to inactivity.',
};

test('noticeStyle: a pipe (an MCP client log) gets the prefix and never color', () => {
  assert.deepEqual(noticeStyle({}, {}), PIPED);
  assert.deepEqual(noticeStyle({ isTTY: false, columns: 200 }, {}), PIPED);
  assert.deepEqual(noticeStyle({}, { FORCE_COLOR: '1' }), PIPED);
});

test('noticeStyle: a terminal gets color and a frame that fits', () => {
  assert.deepEqual(noticeStyle({ isTTY: true, columns: 120 }, {}), { color: true, prefix: '', width: 78 });
  assert.equal(noticeStyle({ isTTY: true, columns: 80 }, {}).width, 78);
  assert.equal(noticeStyle({ isTTY: true, columns: 79 }, {}).width, 78);
  assert.equal(noticeStyle({ isTTY: true, columns: 60 }, {}).width, 59);
  assert.equal(noticeStyle({ isTTY: true, columns: 41 }, {}).width, 40);
  assert.equal(noticeStyle({ isTTY: true, columns: 20 }, {}).width, 40, 'never narrower than 40');
  assert.equal(noticeStyle({ isTTY: true }, {}).width, 78, 'columns unknown');
  assert.equal(noticeStyle({ isTTY: true, columns: 0 }, {}).width, 78, 'columns 0');
});

test('noticeStyle: NO_COLOR, TERM=dumb and FORCE_COLOR=0 turn color off', () => {
  const tty = { isTTY: true, columns: 100 };
  assert.deepEqual(noticeStyle(tty, { NO_COLOR: '1' }), { color: false, prefix: '', width: 78 });
  assert.equal(noticeStyle(tty, { NO_COLOR: '' }).color, true, 'an empty NO_COLOR does not count');
  assert.equal(noticeStyle(tty, { TERM: 'dumb' }).color, false);
  assert.equal(noticeStyle(tty, { TERM: 'xterm-256color' }).color, true);
  assert.equal(noticeStyle(tty, { FORCE_COLOR: '0' }).color, false);
  assert.equal(noticeStyle(tty, { FORCE_COLOR: 'false' }).color, false);
  assert.equal(noticeStyle(tty, { FORCE_COLOR: '1' }).color, true);
});

test('renderNotice: the whole frame, without color', () => {
  assert.equal(
    renderNotice(SAMPLE, { color: false, prefix: '', width: 50 }),
    [
      '',
      `┌─ Sign-in needed ${'─'.repeat(32)}`,
      '│',
      '│  ado-npm-exec could not get a Microsoft Entra ID',
      '│  token for the Azure DevOps feed. Sign in once',
      '│  in a terminal; later starts are silent.',
      '│',
      '│  Details:',
      `│  ${URL}`,
      '│',
      '│  PowerShell:',
      `│    ${PWSH_LOGIN}`,
      '│',
      '│  Command Prompt (cmd.exe):',
      `│    ${CMD_LOGIN}`,
      '│',
      '│  Then restart the MCP server.',
      '│',
      '│  az: AADSTS70043: The refresh token has expired',
      '│  due to inactivity.',
      '│',
      `└${'─'.repeat(49)}`,
      '',
    ].join('\n'),
  );
});

test('renderNotice: colors frame, title, commands and footnote, each reset', () => {
  const notice = { title: 'T', paragraphs: ['p'], commands: [{ label: 'L', command: 'c' }], after: ['a'], footnote: 'f' };
  const [Y, R] = ['\x1b[33m', '\x1b[0m'];
  assert.equal(
    renderNotice(notice, { ...PLAIN_40, color: true }),
    [
      '',
      `${Y}┌─${R} \x1b[1;33mT${R} ${Y}${'─'.repeat(35)}${R}`,
      `${Y}│${R}`,
      `${Y}│${R}  p`,
      `${Y}│${R}`,
      `${Y}│${R}  L:`,
      `${Y}│${R}    \x1b[1;36mc${R}`,
      `${Y}│${R}`,
      `${Y}│${R}  a`,
      `${Y}│${R}`,
      `${Y}│${R}  \x1b[2mf${R}`,
      `${Y}│${R}`,
      `${Y}${BOTTOM_40}${R}`,
      '',
    ].join('\n'),
  );
});

test('renderNotice: without color there is no escape code at all; color only adds codes', () => {
  const plain = renderNotice(SAMPLE, { color: false, prefix: '', width: 60 });
  const colored = renderNotice(SAMPLE, { color: true, prefix: '', width: 60 });
  assert.doesNotMatch(plain, /\x1b/);
  assert.match(colored, /\x1b\[1;36m/);
  assert.equal(stripVTControlCharacters(colored), plain);
});

test('renderNotice: every line carries the prefix when piped', () => {
  const out = renderNotice(SAMPLE, PIPED);
  assert.ok(out.startsWith('\n') && out.endsWith('\n'));
  const lines = out.slice(1, -1).split('\n');
  assert.equal(lines.length, 19);
  for (const line of lines) assert.ok(line.startsWith('ado-npm-exec: '), JSON.stringify(line));
  assert.equal(lines[0], `ado-npm-exec: ┌─ Sign-in needed ${'─'.repeat(60)}`);
  assert.equal(lines[lines.length - 1], `ado-npm-exec: └${'─'.repeat(77)}`);
  assert.doesNotMatch(out, /\x1b|[ \t]\n/, 'no escape codes, no trailing whitespace');
});

test('renderNotice: commands are never wrapped, even when wider than the frame', () => {
  const long = `${CMD_LOGIN} && echo ${'x'.repeat(60)}`;
  const notice = { title: 'T', paragraphs: ['A paragraph that is long enough to wrap in a narrow frame.'], commands: [long] };
  const plain = renderNotice(notice, PLAIN_40);
  assert.ok(plain.includes(`\n│    ${long}\n`));
  assert.ok(plain.includes('\n│  A paragraph that is long enough to\n│  wrap in a narrow frame.\n'), 'prose wraps at width - 3');
  assert.ok(renderNotice(notice, { ...PLAIN_40, color: true }).includes(`\x1b[1;36m${long}\x1b[0m`));
});

test('renderNotice: a label heads a group of commands', () => {
  const commands = ['one', 'two', { label: 'PowerShell', command: 'three' }, 'four', { label: 'Command Prompt (cmd.exe)', command: 'five' }];
  assert.equal(
    renderNotice({ title: 'T', paragraphs: [], commands }, PLAIN_40),
    [
      '',
      TOP_T_40,
      '│',
      '│    one',
      '│    two',
      '│',
      '│  PowerShell:',
      '│    three',
      '│    four',
      '│',
      '│  Command Prompt (cmd.exe):',
      '│    five',
      '│',
      BOTTOM_40,
      '',
    ].join('\n'),
  );
});

test('renderNotice: empty sections are left out, never a double blank line', () => {
  assert.equal(renderNotice({ title: 'T', paragraphs: [] }, PLAIN_40), ['', TOP_T_40, '│', BOTTOM_40, ''].join('\n'));
  const sparse = {
    title: 'T',
    paragraphs: ['', 'a', '  ', '\n\n'],
    commands: ['', ' \n ', { label: 'Label without a command', command: '' }],
    after: ['', 'b'],
    footnote: ' ',
  };
  assert.equal(renderNotice(sparse, PLAIN_40), ['', TOP_T_40, '│', '│  a', '│', '│  b', '│', BOTTOM_40, ''].join('\n'));
  assert.equal(
    renderNotice({ title: 'T', paragraphs: ['first\n\n\nsecond\n'], footnote: 'f\n\ng' }, PLAIN_40),
    ['', TOP_T_40, '│', '│  first', '│', '│  second', '│', '│  f', '│', '│  g', '│', BOTTOM_40, ''].join('\n'),
  );
});

test('renderNotice: a title too long for the frame still gets three rules', () => {
  const title = 'x'.repeat(50);
  assert.ok(renderNotice({ title, paragraphs: [] }, PLAIN_40).startsWith(`\n┌─ ${title} ───\n`));
  assert.ok(renderNotice({ title: '', paragraphs: [] }, PLAIN_40).startsWith(`\n┌${'─'.repeat(39)}\n`));
});

test('renderNotice: redacts tokens in the title, prose, labels, commands and footnote', () => {
  const jwt = validJwt();
  addSecret('registered-secret-value');
  const out = renderNotice(
    {
      title: `Title ${jwt}`,
      paragraphs: [`az said: Authorization: Bearer abcdefghijklmnop0123 and ${jwt}`, 'also registered-secret-value'],
      commands: [
        `curl -H "Authorization: Bearer abcdefghijklmnop0123" ${jwt}`,
        { label: `Label ${jwt}`, command: 'npm config set //registry.example.invalid/:_authToken=abcdef123456' },
      ],
      after: [jwt],
      footnote: `Bearer abcdefghijklmnop0123 ${jwt}`,
    },
    { color: false, prefix: '', width: 78 },
  );
  assert.doesNotMatch(out, /eyJ|abcdefghijklmnop0123|registered-secret-value|abcdef123456/);
  assert.ok(out.startsWith('\n┌─ Title <redacted-jwt> ─'));
  assert.ok(out.includes('\n│  az said: Authorization: Bearer <redacted> and <redacted-jwt>\n'));
  assert.ok(out.includes('\n│  also <redacted>\n'));
  assert.ok(out.includes('\n│    curl -H "Authorization: Bearer <redacted>" <redacted-jwt>\n'));
  assert.ok(out.includes('\n│  Label <redacted-jwt>:\n│    npm config set //registry.example.invalid/:_authToken=<redacted>\n'));
  assert.ok(out.includes('\n│  Bearer <redacted> <redacted-jwt>\n'));
});

test('renderNotice: a token split by control characters is still redacted', () => {
  const jwt = validJwt();
  const [h, p, s] = jwt.split('.');
  const paragraphs = [
    `${h}.${p}\x1b[0m.${s}`,
    `${h.slice(0, 5)}\x07${h.slice(5)}.${p}.${s}`,
    'Bearer\x07 abcdefghijklmnop',
    'Bearer\vabcdefghijklmnop',
  ];
  const out = renderNotice({ title: 'T', paragraphs, commands: [`az ${h}.${p}\x00.${s}`] }, PLAIN_40);
  assert.doesNotMatch(out, /eyJ|abcdefghijklmnop/);
  assert.equal((out.match(/<redacted-jwt>/g) ?? []).length, 3);
  assert.equal((out.match(/Bearer <redacted>/g) ?? []).length, 2);
});

test('renderNotice: strips escape sequences and control characters from the text', () => {
  const notice = {
    title: 'Sign-in\x1b]0;pwned\x07 needed',
    paragraphs: ['Error: \x1b[31mboom\x1b[0m\x00\x07\b done\r\x9b2J\x7f\x85.', 'one\r\ntwo\tthree'],
    commands: ['az login\x1b[2J\x1b[H'],
  };
  const plain = renderNotice(notice, PLAIN_40);
  assert.equal(
    plain,
    [
      '',
      `┌─ Sign-in needed ${'─'.repeat(22)}`,
      '│',
      '│  Error: boom done.',
      '│',
      '│  one',
      '│  two three',
      '│',
      '│    az login',
      '│',
      BOTTOM_40,
      '',
    ].join('\n'),
  );
  const colored = renderNotice(notice, { ...PLAIN_40, color: true });
  assert.doesNotMatch(colored.replace(OUR_CODES, ''), /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/, 'only our own codes');
  assert.equal(stripVTControlCharacters(colored), plain);
});

test('renderNotice: a newline in the text cannot start a line without the prefix', () => {
  const notice = { title: 'One\nline', paragraphs: ['a\nb'], commands: [{ label: 'L\nM', command: 'x\ny\n' }], footnote: 'f\r\ng' };
  const out = renderNotice(notice, PIPED);
  for (const line of out.slice(1, -1).split('\n')) assert.ok(line.startsWith('ado-npm-exec: '), JSON.stringify(line));
  assert.ok(out.startsWith('\nado-npm-exec: ┌─ One line ─'));
  assert.ok(out.includes('\nado-npm-exec: │  a\nado-npm-exec: │  b\n'));
  assert.ok(out.includes('\nado-npm-exec: │  L M:\nado-npm-exec: │    x\nado-npm-exec: │    y\n'));
  assert.ok(out.includes('\nado-npm-exec: │  f\nado-npm-exec: │  g\n'));
});

test('wrap: greedy, on whitespace', () => {
  assert.deepEqual(wrap('one two three', 7), ['one two', 'three']);
  assert.deepEqual(wrap('aaa bbb', 7), ['aaa bbb'], 'an exact fit stays on one line');
  assert.deepEqual(wrap('aaa bbbb', 7), ['aaa', 'bbbb']);
  assert.deepEqual(wrap('  a   b \t c  ', 80), ['a b c']);
});

test('wrap: a word longer than the width (a URL) gets its own line, uncut', () => {
  assert.deepEqual(wrap(`see ${URL} for details`, 20), ['see', URL, 'for details']);
  assert.deepEqual(wrap(URL, 10), [URL]);
  assert.deepEqual(wrap('ab cd', 1), ['ab', 'cd']);
});

test('wrap: empty input, hard breaks and no-break spaces', () => {
  assert.deepEqual(wrap('', 10), []);
  assert.deepEqual(wrap(' \n \n', 10), []);
  assert.deepEqual(wrap('a\nb', 80), ['a', 'b']);
  assert.deepEqual(wrap('\n\na\n\n\nb\n\n', 80), ['a', '', 'b']);
  assert.deepEqual(wrap('a\u00a0b c', 3), ['a\u00a0b', 'c']);
});

test('writeNotice: renders for the stream it writes to', () => {
  /** @type {string[]} */
  const piped = [];
  writeNotice({ write: (s) => piped.push(s) }, SAMPLE, {});
  assert.deepEqual(piped, [renderNotice(SAMPLE, PIPED)]);

  /** @type {string[]} */
  const tty = [];
  writeNotice({ write: (s) => tty.push(s), isTTY: true, columns: 61 }, SAMPLE, {});
  assert.deepEqual(tty, [renderNotice(SAMPLE, { color: true, prefix: '', width: 60 })]);

  /** @type {string[]} */
  const noColor = [];
  writeNotice({ write: (s) => noColor.push(s), isTTY: true, columns: 61 }, SAMPLE, { NO_COLOR: '1' });
  assert.deepEqual(noColor, [renderNotice(SAMPLE, { color: false, prefix: '', width: 60 })]);
});

test('writeNotice: never throws', () => {
  const closed = {
    write() {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    },
  };
  assert.doesNotThrow(() => writeNotice(closed, SAMPLE, {}));
  assert.doesNotThrow(() => writeNotice({ write: () => true }, /** @type {any} */ (null), {}));
});

test('shellKind: from SHELL', () => {
  /** @type {[string, NodeJS.Platform, string | undefined][]} */
  const cases = [
    ['/bin/bash', 'linux', 'posix'],
    ['/bin/zsh', 'darwin', 'posix'],
    ['/usr/bin/fish', 'linux', 'posix'],
    ['/bin/sh', 'linux', 'posix'],
    ['/bin/dash', 'linux', 'posix'],
    ['/bin/ksh', 'freebsd', 'posix'],
    ['/usr/local/bin/pwsh', 'darwin', 'powershell'],
    ['/opt/microsoft/powershell/7-preview/pwsh-preview', 'linux', 'powershell'],
    ['/usr/bin/bash', 'win32', 'posix'],
    ['C:\\Program Files\\Git\\usr\\bin\\bash.exe', 'win32', 'posix'],
    ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32', 'powershell'],
    ['C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\PowerShell.exe', 'win32', 'powershell'],
    ['C:\\Windows\\System32\\cmd.exe', 'win32', 'cmd'],
    ['CMD.EXE', 'win32', 'cmd'],
    ['', 'linux', undefined],
    ['   ', 'win32', undefined],
  ];
  for (const [SHELL, platform, expected] of cases) assert.equal(shellKind({ SHELL }, platform), expected, `${SHELL} on ${platform}`);
});

test('shellKind: nothing set is unknown; other Windows hints are ignored', () => {
  assert.equal(shellKind({}, 'linux'), undefined);
  assert.equal(shellKind({}, 'win32'), undefined);
  const hints = { PSModulePath: 'C:\\Program Files\\WindowsPowerShell\\Modules', PROMPT: '$P$G', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
  assert.equal(shellKind(hints, 'win32'), undefined);
});

test('shellKind: ADO_NPM_EXEC_SHELL overrides SHELL', () => {
  assert.equal(shellKind({ ADO_NPM_EXEC_SHELL: 'pwsh', SHELL: '/bin/zsh' }, 'darwin'), 'powershell');
  assert.equal(shellKind({ ADO_NPM_EXEC_SHELL: 'powershell' }, 'win32'), 'powershell');
  assert.equal(shellKind({ ADO_NPM_EXEC_SHELL: 'cmd', SHELL: '/usr/bin/bash' }, 'win32'), 'cmd');
  assert.equal(shellKind({ ADO_NPM_EXEC_SHELL: 'bash', SHELL: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }, 'win32'), 'posix');
  assert.equal(shellKind({ ADO_NPM_EXEC_SHELL: 'posix' }, 'win32'), 'posix');
  assert.equal(shellKind({ ADO_NPM_EXEC_SHELL: '', SHELL: '/bin/zsh' }, 'darwin'), 'posix', 'an empty override is unset');
});

test('azLoginCommands: one command in the syntax of a known shell', () => {
  assert.deepEqual(azLoginCommands({ tenant: TENANT, env: { SHELL: '/bin/zsh' }, platform: 'darwin' }), [POSIX_LOGIN]);
  assert.deepEqual(azLoginCommands({ tenant: TENANT, env: { SHELL: '/usr/local/bin/pwsh' }, platform: 'linux' }), [PWSH_LOGIN]);
  assert.deepEqual(azLoginCommands({ tenant: TENANT, env: { ADO_NPM_EXEC_SHELL: 'pwsh' }, platform: 'win32' }), [PWSH_LOGIN]);
  assert.deepEqual(azLoginCommands({ tenant: TENANT, env: { ADO_NPM_EXEC_SHELL: 'cmd' }, platform: 'win32' }), [CMD_LOGIN]);
  assert.deepEqual(azLoginCommands({ tenant: TENANT, env: { SHELL: '/usr/bin/bash' }, platform: 'win32' }), [POSIX_LOGIN], 'Git Bash');
});

test('azLoginCommands: without a shell signal, Windows gets both forms, labeled', () => {
  assert.deepEqual(azLoginCommands({ tenant: TENANT, env: {}, platform: 'win32' }), [
    { label: 'PowerShell', command: PWSH_LOGIN },
    { label: 'Command Prompt (cmd.exe)', command: CMD_LOGIN },
  ]);
  assert.deepEqual(azLoginCommands({ tenant: TENANT, env: {}, platform: 'darwin' }), [POSIX_LOGIN]);
  assert.deepEqual(azLoginCommands({ tenant: TENANT, env: {}, platform: 'linux' }), [POSIX_LOGIN]);
});

test('azLoginCommands: only a GUID tenant ends up in the command', () => {
  const posix = (/** @type {string | undefined} */ tenant) => azLoginCommands({ tenant, env: { SHELL: '/bin/bash' }, platform: 'linux' });
  const bare = ['AZURE_CORE_LOGIN_EXPERIENCE_V2=off az login --allow-no-subscriptions'];
  assert.deepEqual(posix(undefined), bare);
  assert.deepEqual(posix(''), bare);
  assert.deepEqual(posix('x; rm -rf /'), bare);
  assert.deepEqual(posix(`${TENANT}; rm -rf /`), bare);
  assert.deepEqual(posix(`${TENANT}\n`), bare);
  assert.deepEqual(posix(ZERO_GUID), bare, 'the zero GUID stands for personal accounts, not a tenant');
  const upper = TENANT.toUpperCase();
  assert.deepEqual(posix(upper), [`AZURE_CORE_LOGIN_EXPERIENCE_V2=off az login --tenant ${upper} --allow-no-subscriptions`]);
  for (const c of azLoginCommands({ tenant: '$(calc)', env: {}, platform: 'win32' })) {
    assert.ok(typeof c !== 'string');
    assert.doesNotMatch(c.command, /--tenant|calc/);
  }
});

test('azLoginCommands: defaults to this process', () => {
  const commands = azLoginCommands();
  assert.deepEqual(commands, azLoginCommands({ env: process.env, platform: process.platform }));
  const forms = [
    'AZURE_CORE_LOGIN_EXPERIENCE_V2=off az login --allow-no-subscriptions',
    "$env:AZURE_CORE_LOGIN_EXPERIENCE_V2='off'; az login --allow-no-subscriptions",
    'set AZURE_CORE_LOGIN_EXPERIENCE_V2=off&& az login --allow-no-subscriptions',
  ];
  assert.ok(commands.length >= 1);
  for (const c of commands) assert.ok(forms.includes(typeof c === 'string' ? c : c.command), JSON.stringify(c));
});

test('azdLoginCommand', () => {
  assert.equal(azdLoginCommand(TENANT), `azd auth login --tenant-id ${TENANT}`);
  assert.equal(azdLoginCommand(), 'azd auth login');
  assert.equal(azdLoginCommand('x; rm -rf /'), 'azd auth login');
  assert.equal(azdLoginCommand(ZERO_GUID), 'azd auth login');
});

test('a sign-in notice built from the helpers keeps every command whole and copyable', () => {
  const commands = [
    ...azLoginCommands({ tenant: TENANT, env: {}, platform: 'win32' }),
    { label: 'Or with the Azure Developer CLI', command: azdLoginCommand(TENANT) },
  ];
  const out = renderNotice({ title: 'Sign-in needed', paragraphs: ['Sign in once.'], commands }, { ...PIPED, width: 40 });
  for (const command of [PWSH_LOGIN, CMD_LOGIN, `azd auth login --tenant-id ${TENANT}`]) {
    assert.ok(out.includes(`\nado-npm-exec: │    ${command}\n`), command);
  }
  assert.ok(out.includes('\nado-npm-exec: │  Or with the Azure Developer CLI:\n'));
});
