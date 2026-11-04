import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { getEventListeners } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  MACHINERY_MARKERS,
  collectLaunchAncestry,
  isLaunchMachinery,
  parseProcessTable,
  powershellPath,
  readWindowsProcessTable,
  resolveTopLaunchShim,
} from '../src/ancestry.js';

/** @typedef {import('../src/ancestry.js').ProcInfo} ProcInfo */
/** @typedef {(error: Error | null, stdout: string) => void} ExecCallback */

const FEED = 'https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/';
const ARGS = `--registry ${FEED} -- @contoso/tool@1.2.3`;
const NODE = '"C:\\Program Files\\nodejs\\node.exe"';
const NPM_CLI = '"C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"';
const PS = 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

// What a Windows MCP client starts with `npm exec -y -- ado-npm-exec@1.1.0 ...`, nearest first.
const US = 7340;
const BIN_SHIM = 7312;
const OUTER_NPM = 6120;
const TOP_SHIM = 5988;
const CLIENT = 4420;
const CLIENT_PARENT = 3104;

const CMD = {
  us: `${NODE} C:\\Users\\dev\\AppData\\Local\\npm-cache\\_npx\\8f2c1d0e9a7b6c5d\\node_modules\\ado-npm-exec\\bin\\ado-npm-exec.js ${ARGS}`,
  binShim: `cmd /d /s /c ado-npm-exec ${ARGS}`,
  npm: `${NODE} ${NPM_CLI} exec -y -- ado-npm-exec@1.1.0 ${ARGS}`,
  topShim: `C:\\WINDOWS\\system32\\cmd.exe /d /s /c npm exec -y -- ado-npm-exec@1.1.0 ${ARGS}`,
  client: '"C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" --type=utility --utility-sub-type=node.mojom.NodeService',
};

// Real launch chains as [image name, command line], from our own process up to the client.
const SERVER = `-y ado-npm-exec@2.0.0 --registry ${FEED} -- @contoso/tool@1.2.3`;
const NODEJS = 'C:\\Program Files\\nodejs\\';
const SELF_ROW = ['node.exe', CMD.us];
// npm runs the bin through ComSpec, with cmd-escaped arguments.
const BIN_ROW = ['cmd.exe', `C:\\WINDOWS\\system32\\cmd.exe /d /s /c ado-npm-exec ^^^"--registry^^^" ^^^"${FEED}^^^" ^^^"@contoso/tool@1.2.3^^^"`];
// npx.cmd builds its paths from %~dp0, which already ends with a backslash.
const NPX_ROW = ['node.exe', `"${NODEJS}\\node.exe" "${NODEJS}\\node_modules\\npm\\bin\\npx-cli.js" ${SERVER}`];
/** @type {Record<string, string[][]>} */
const CHAINS = {
  'a Node.js client (shell: true)': [SELF_ROW, BIN_ROW, NPX_ROW, ['cmd.exe', `C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npx ${SERVER}"`], ['Code.exe', CMD.client]],
  'npx.cmd started directly': [
    SELF_ROW,
    BIN_ROW,
    NPX_ROW,
    ['cmd.exe', `C:\\WINDOWS\\system32\\cmd.exe /c ""${NODEJS}npx.cmd" ${SERVER}"`],
    ['claude.exe', '"C:\\Users\\dev\\AppData\\Local\\AnthropicClaude\\claude.exe"'],
  ],
  'a Rust client': [
    SELF_ROW,
    BIN_ROW,
    NPX_ROW,
    ['cmd.exe', `C:\\WINDOWS\\system32\\cmd.exe /e:ON /v:OFF /d /c ""${NODEJS}npx.cmd" ${SERVER}"`],
    ['client.exe', 'C:\\Tools\\client.exe --stdio'],
  ],
  'npm exec': [
    SELF_ROW,
    BIN_ROW,
    ['node.exe', `"${NODEJS}\\node.exe" "${NODEJS}\\node_modules\\npm\\bin\\npm-cli.js" exec ${SERVER}`],
    ['cmd.exe', `C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npm exec ${SERVER}"`],
    ['Code.exe', CMD.client],
  ],
  'a PowerShell wrapper': [SELF_ROW, BIN_ROW, NPX_ROW, ['powershell.exe', `powershell.exe -NoProfile -Command npx ${SERVER}`], ['Code.exe', CMD.client]],
  'an npx.exe launcher': [
    SELF_ROW,
    BIN_ROW,
    ['node.exe', `C:\\Tools\\node\\node.exe C:\\Tools\\node\\node_modules\\npm\\bin\\npx-cli.js ${SERVER}`],
    ['npx.exe', `"C:\\Program Files\\Volta\\npx.exe" ${SERVER}`],
    ['Code.exe', CMD.client],
  ],
};

/** @returns {Map<number, ProcInfo>} */
function fieldTable() {
  return new Map([
    [US, { ppid: BIN_SHIM, name: 'node.exe', cmd: CMD.us }],
    [BIN_SHIM, { ppid: OUTER_NPM, name: 'cmd.exe', cmd: CMD.binShim }],
    [OUTER_NPM, { ppid: TOP_SHIM, name: 'node.exe', cmd: CMD.npm }],
    [TOP_SHIM, { ppid: CLIENT, name: 'cmd.exe', cmd: CMD.topShim }],
    [CLIENT, { ppid: CLIENT_PARENT, name: 'Code.exe', cmd: CMD.client }],
    [CLIENT_PARENT, { ppid: 1200, name: 'explorer.exe', cmd: 'C:\\WINDOWS\\Explorer.EXE' }],
  ]);
}

/** PowerShell output for a table. @param {Map<number, ProcInfo>} table */
function render(table) {
  return [...table].map(([pid, p]) => `${pid}|${p.ppid}|${p.name}|${p.cmd}\r\n`).join('');
}

/**
 * Records every lookup, to prove what the walk never looked at.
 * @param {Map<number, ProcInfo>} table
 */
function recordLookups(table) {
  /** @type {number[]} */
  const looked = [];
  const get = table.get.bind(table);
  table.get = (pid) => {
    looked.push(pid);
    return get(pid);
  };
  return looked;
}

/** @param {(callback: ExecCallback) => void} behave */
function fakeExecFile(behave) {
  /** @type {{ file: string, args: string[], options: import('node:child_process').ExecFileOptionsWithStringEncoding }[]} */
  const calls = [];
  const stdin = new PassThrough();
  /**
   * @param {string} file
   * @param {string[]} args
   * @param {import('node:child_process').ExecFileOptionsWithStringEncoding} options
   * @param {ExecCallback} callback
   */
  const impl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    behave(callback);
    return { stdin };
  };
  return { impl, calls, stdin };
}

/** @param {string} message @param {object} [props] */
function execError(message, props = {}) {
  return Object.assign(new Error(message), props);
}

/** Timers that keep the event loop alive. */
function liveTimers() {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
}

/**
 * A process table for a chain listed from our own process (pid 9000) up to the client.
 * @param {string[][]} rows
 */
function chainTable(rows) {
  /** @type {Map<number, ProcInfo>} */
  const table = new Map();
  rows.forEach(([name, cmd], i) => table.set(9000 + i, { ppid: 9001 + i, name, cmd }));
  return table;
}

test('launch machinery markers match case-insensitively', () => {
  assert.deepEqual(MACHINERY_MARKERS, ['ado-npm-exec', 'npm-cli.js', 'npx-cli.js']);
  assert.ok(Object.isFrozen(MACHINERY_MARKERS));
  for (const [cmd, name] of [
    [CMD.us, 'node.exe'],
    [CMD.binShim, 'cmd.exe'],
    [CMD.npm, 'node.exe'],
    [CMD.topShim, 'cmd.exe'],
  ]) {
    assert.equal(isLaunchMachinery(cmd, name), true, cmd);
  }
  assert.equal(isLaunchMachinery('C:\\NODEJS\\NODE.EXE C:\\NODEJS\\NODE_MODULES\\NPM\\BIN\\NPM-CLI.JS exec -- @contoso/tool', 'NODE.EXE'), true);
  assert.equal(isLaunchMachinery('cmd.exe /d /s /c ADO-NPM-EXEC --registry x', 'cmd.exe'), true);
  assert.equal(isLaunchMachinery(`${NODE} "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js" -y @contoso/tool`, 'node.exe'), true);
  assert.equal(isLaunchMachinery(CMD.client, 'Code.exe'), false);
  assert.equal(isLaunchMachinery('C:\\WINDOWS\\system32\\cmd.exe /d /s /c npm --version', 'cmd.exe'), false);
  assert.equal(isLaunchMachinery('', 'cmd.exe'), false);
  assert.equal(isLaunchMachinery(/** @type {any} */ (undefined), 'node.exe'), false);
});

test('a row without an image name is never launch machinery', () => {
  for (const name of ['', '  ', /** @type {any} */ (undefined), /** @type {any} */ (null)]) {
    for (const cmd of [CMD.us, CMD.binShim, CMD.npm, CMD.topShim]) {
      assert.equal(isLaunchMachinery(cmd, name), false, `${String(name)}: ${cmd}`);
    }
  }
  // Such a row ends the walk, like a client.
  const table = fieldTable();
  table.set(OUTER_NPM, { ppid: TOP_SHIM, name: '', cmd: CMD.npm });
  assert.deepEqual(collectLaunchAncestry(US, table), { pids: [BIN_SHIM], boundaryReached: true });
});

test('isLaunchMachinery judges cmd.exe by the command after its first /c or /k switch', () => {
  const machinery = [
    CMD.binShim,
    CMD.topShim,
    BIN_ROW[1],
    `C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npx ${SERVER}"`,
    'C:\\WINDOWS\\system32\\cmd.exe /D /S /C "npm exec -- ADO-NPM-EXEC"',
    `"C:\\WINDOWS\\system32\\cmd.exe" /c ""${NODEJS}npx.cmd" ${SERVER}"`,
    `C:\\WINDOWS\\system32\\cmd.exe /e:ON /v:OFF /d /c ""${NODEJS}npx.cmd" ${SERVER}"`,
    'cmd /d/s/c"npx -y ado-npm-exec@2.0.0"',
    'cmd.exe /cnpx -y ado-npm-exec@2.0.0',
    'cmd.exe /k npx -y ado-npm-exec@2.0.0',
    'cmd.exe\t/q /K "npx -y ado-npm-exec@2.0.0"',
  ];
  const others = [
    'C:\\WINDOWS\\system32\\cmd.exe /d /s /c npm --version',
    '"C:\\WINDOWS\\system32\\cmd.exe"',
    'C:\\WINDOWS\\system32\\cmd.exe /k "C:\\Tools\\VsDevCmd.bat"',
    // A marker outside the command, or a '/c' that is not the switch.
    'C:\\ado-npm-exec\\cmd.exe /d /s /c echo',
    '"C:\\Tools /c ado-npm-exec\\cmd.exe" /d /s /c echo',
    'C:/ado-npm-exec/cmd.exe /d',
    'cmd.exe /d /s C:/cache/ado-npm-exec',
    'cmd.exe / c ado-npm-exec',
    'cmd.exe start /c ado-npm-exec',
    'cmd.exe /d /s',
  ];
  for (const name of ['cmd.exe', 'CMD.EXE', 'Cmd']) {
    for (const cmd of machinery) assert.equal(isLaunchMachinery(cmd, name), true, `${name}: ${cmd}`);
    for (const cmd of others) assert.equal(isLaunchMachinery(cmd, name), false, `${name}: ${cmd}`);
  }
});

test('isLaunchMachinery judges node.exe by its script, split as Windows command-line tokens', () => {
  const machinery = [
    CMD.us,
    CMD.npm,
    NPX_ROW[1],
    `${NODE} "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js" -y ado-npm-exec@2.0.0 --registry ${FEED}`,
    'node.exe C:\\x\\ado-npm-exec\\bin\\ado-npm-exec.js --registry x',
    'node --max-old-space-size=4096 --no-warnings -- C:\\x\\ado-npm-exec\\bin\\ado-npm-exec.js',
    'node.exe "C:\\Program Files\\ado-npm-exec\\bin\\ado-npm-exec.js"',
    // Quotes group and are removed; \" is a literal quote.
    'node.exe "--title=a b" C:\\x\\npm-cli.js',
    'node.exe "-x" C:\\x\\npm-cli.js',
    'node.exe --title="a \\"b\\" c" C:\\x\\npm-cli.js',
  ];
  const others = [
    'node.exe C:\\client\\index.js --config ado-npm-exec.json',
    `${NODE} C:\\Users\\dev\\agent\\index.js --mcp-config "{\\"command\\":\\"npx\\",\\"args\\":[\\"ado-npm-exec\\"]}"`,
    '"C:\\Program Files\\ado-npm-exec\\node.exe" C:\\client\\index.js',
    'node.exe --require=ado-npm-exec/register C:\\client\\index.js',
    'node.exe "C:\\client dir\\index.js" ado-npm-exec',
    // A backslash before a quote: \" does not open quoting, and \\" is a backslash and a closing quote.
    'node.exe a\\"b ado-npm-exec',
    'node.exe "C:\\client\\\\" ado-npm-exec',
    'node.exe',
    'node.exe --inspect ',
  ];
  for (const name of ['node.exe', 'NODE.EXE', 'node']) {
    for (const cmd of machinery) assert.equal(isLaunchMachinery(cmd, name), true, `${name}: ${cmd}`);
    for (const cmd of others) assert.equal(isLaunchMachinery(cmd, name), false, `${name}: ${cmd}`);
  }
});

test('isLaunchMachinery skips Node options and their values to find the script', () => {
  const machinery = [
    'node.exe --require C:\\x\\preload.js C:\\npm\\bin\\npm-cli.js exec -- @contoso/tool',
    'node -r x npm-cli.js',
    `${NODE} -r C:\\x\\a.js --import file:///C:/x/b.mjs --title "MCP server" -C dev --inspect ${NPM_CLI} exec`,
    // A value after '=' is part of the option.
    'node.exe --require=C:\\x\\preload.js --input-type=module C:\\x\\npm-cli.js',
    // Node also accepts '_' for '-' in option names.
    'node.exe --input_type module --env_file .env C:\\x\\npm-cli.js',
    // '--' ends the options: the next argument is the script.
    'node.exe -r x -- C:\\x\\npm-cli.js',
    // Arguments after the script belong to the script.
    'node.exe C:\\x\\npm-cli.js -e x --require y',
  ];
  const others = [
    // An option value is not the script.
    'node.exe --require C:\\x\\npm-cli.js C:\\client\\index.js',
    'node.exe -r ado-npm-exec/register C:\\client\\index.js',
    'node.exe --title ado-npm-exec C:\\client\\index.js',
    'node.exe --env_file C:\\x\\npm-cli.js C:\\client\\index.js',
    'node.exe --require',
    // After '--', the next argument is the script even when it starts with '-'.
    'node.exe -- -x C:\\x\\npm-cli.js',
    'node.exe --',
    // Inline code or a script from stdin: no script file.
    'node.exe -e 1 C:\\x\\npm-cli.js',
    'node.exe --eval=1 C:\\x\\npm-cli.js',
    'node.exe -p 1 C:\\x\\npm-cli.js',
    'node.exe --print C:\\x\\npm-cli.js',
    'node.exe -pe 1 C:\\x\\npm-cli.js',
    'node.exe -r C:\\x\\a.js -e 1 C:\\x\\npm-cli.js',
    'node.exe - C:\\x\\npm-cli.js',
  ];
  for (const cmd of machinery) assert.equal(isLaunchMachinery(cmd, 'node.exe'), true, cmd);
  for (const cmd of others) assert.equal(isLaunchMachinery(cmd, 'node.exe'), false, cmd);

  const valueOptions = [
    ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--title'],
    ['--inspect-port', '--debug-port', '--env-file', '--env-file-if-exists', '--watch-path', '--disable-warning'],
    ['--redirect-warnings', '--icu-data-dir', '--openssl-config', '--diagnostic-dir', '--report-dir', '--report-directory'],
    ['--report-filename', '--report-signal', '--heapsnapshot-signal', '--secure-heap', '--secure-heap-min'],
    ['--max-http-header-size', '--unhandled-rejections', '--dns-result-order', '--experimental-config-file', '--localstorage-file'],
  ].flat();
  for (const option of valueOptions) {
    assert.equal(isLaunchMachinery(`node.exe ${option} C:\\x\\value C:\\x\\npm-cli.js`, 'node.exe'), true, option);
    assert.equal(isLaunchMachinery(`node.exe ${option} C:\\x\\npm-cli.js C:\\client\\index.js`, 'node.exe'), false, option);
    if (option.startsWith('--')) {
      assert.equal(isLaunchMachinery(`node.exe ${option}=C:\\x\\value C:\\x\\npm-cli.js`, 'node.exe'), true, `${option}=`);
    }
  }
  // Flags take no value, and option names are case-sensitive (-c is not -C). V8 options need '='.
  for (const flag of ['--inspect', '--inspect-brk', '--no-warnings', '--trace-warnings', '-c', '--stack-trace-limit=50']) {
    assert.equal(isLaunchMachinery(`node.exe ${flag} C:\\x\\npm-cli.js C:\\client\\index.js`, 'node.exe'), true, flag);
  }
});

test('isLaunchMachinery judges launcher shims by their command line, and other programs never', () => {
  const launchers = [
    ['npm.exe', 'npm.exe exec -y -- ado-npm-exec@2.0.0'],
    ['NPX.EXE', `"C:\\Program Files\\Volta\\npx.exe" ${SERVER}`],
    ['npx', 'npx -y @contoso/tool --registry x ado-npm-exec'],
    ['ado-npm-exec.exe', 'ado-npm-exec.exe --registry x -- @contoso/tool'],
    ['powershell.exe', `powershell.exe -NoProfile -Command npx ${SERVER}`],
    ['PowerShell', `powershell -c "C:\\x\\node_modules\\npm\\bin\\npx-cli.js"`],
    ['pwsh.exe', `pwsh -c "npx ${SERVER}"`],
    ['bash.exe', `"C:\\Program Files\\Git\\usr\\bin\\bash.exe" -c "npx ${SERVER}"`],
    ['sh.exe', `sh -c "npx ${SERVER}"`],
  ];
  for (const [name, cmd] of launchers) {
    assert.equal(isLaunchMachinery(cmd, name), true, name);
    assert.equal(isLaunchMachinery('C:\\Tools\\shim.exe --version', name), false, `${name} without a marker`);
  }
  const mentions = 'C:\\x\\node_modules\\npm\\bin\\npm-cli.js /c ado-npm-exec npx-cli.js';
  for (const name of ['Code.exe', 'claude.exe', 'explorer.exe', 'zsh.exe', 'nodejs.exe', 'cmd2.exe', 'npm-cli.js', 'node.exe.bak']) {
    assert.equal(isLaunchMachinery(`${name} ${mentions}`, name), false, name);
  }
});

test('parseProcessTable reads CRLF rows whose command lines contain pipes', () => {
  const text = [
    '\uFEFF0|0|System Idle Process|',
    '4|0|System|',
    `${US}|${BIN_SHIM}|node.exe|node a.js --filter "x|y" | more`,
    ' 12 |\t7 | cmd.exe |cmd /c x ',
    '',
  ].join('\r\n');
  assert.deepEqual(
    parseProcessTable(text),
    new Map([
      [0, { ppid: 0, name: 'System Idle Process', cmd: '' }],
      [4, { ppid: 0, name: 'System', cmd: '' }],
      [US, { ppid: BIN_SHIM, name: 'node.exe', cmd: 'node a.js --filter "x|y" | more' }],
      [12, { ppid: 7, name: 'cmd.exe', cmd: 'cmd /c x ' }],
    ]),
  );
  assert.deepEqual(parseProcessTable('5|4|smss.exe|smss.exe\n6|5|csrss.exe|csrss.exe'), new Map([
    [5, { ppid: 4, name: 'smss.exe', cmd: 'smss.exe' }],
    [6, { ppid: 5, name: 'csrss.exe', cmd: 'csrss.exe' }],
  ]));
  assert.deepEqual(parseProcessTable(render(fieldTable())), fieldTable());
});

test('parseProcessTable ignores lines that are not pid|ppid|name|cmd rows', () => {
  const text = [
    '  101     1 /usr/bin/node /opt/ado-npm-exec/bin/ado-npm-exec.js --x  ',
    '102 101',
    '103\t101\tsh -c a|b',
    '104|1|node.exe|node a.js',
  ].join('\n');
  assert.deepEqual(parseProcessTable(text), new Map([[104, { ppid: 1, name: 'node.exe', cmd: 'node a.js' }]]));
});

test('parseProcessTable ignores garbage, negative, fractional and non-numeric pids', () => {
  const garbage = [
    '',
    '   ',
    'garbage',
    '|||',
    'ProcessId|ParentProcessId|Name|CommandLine',
    '12|34',
    '12|34|node.exe',
    'abc def ghi',
    '42',
    '-1|4|x.exe|x',
    '5|-4|x.exe|x',
    'NaN|4|x.exe|x',
    '5|NaN|x.exe|x',
    '1.5|4|x.exe|x',
    '0x10|4|x.exe|x',
    '1e3|4|x.exe|x',
    ' |4|x.exe|x',
    '5||x.exe|x',
    '9007199254740993|4|x.exe|x',
  ];
  assert.equal(parseProcessTable(garbage.join('\r\n')).size, 0);
  assert.equal(parseProcessTable('').size, 0);
  assert.deepEqual([...parseProcessTable(['oops', '8|4|ok.exe|ok', '-8|4|x|y'].join('\n')).keys()], [8]);
});

test('parseProcessTable drops a pid listed twice', () => {
  const table = parseProcessTable('20|1|a.exe|a\n21|20|b.exe|b\n20|2|c.exe|c ado-npm-exec\n20|3|d.exe|d\n');
  assert.deepEqual([...table.keys()], [21]);
});

test('powershellPath is absolute and follows SystemRoot', () => {
  const tail = '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  assert.equal(powershellPath({ SystemRoot: 'D:\\Win' }), PS);
  assert.equal(powershellPath({ SYSTEMROOT: 'C:\\WINDOWS' }), `C:\\WINDOWS${tail}`);
  assert.equal(powershellPath({ systemroot: 'E:/Windows/' }), `E:\\Windows${tail}`);
  assert.equal(powershellPath({}), `C:\\Windows${tail}`);
  for (const SystemRoot of ['', 'Windows', '.\\evil', 'C:Windows', '\\Windows', '\\\\server\\share']) {
    assert.equal(powershellPath({ SystemRoot }), `C:\\Windows${tail}`, SystemRoot);
  }
  assert.ok(path.win32.isAbsolute(powershellPath()));
  assert.ok(powershellPath().endsWith(tail));
});

test('readWindowsProcessTable runs PowerShell once, by absolute path, and parses its output', async () => {
  const fake = fakeExecFile((callback) => setImmediate(() => callback(null, render(fieldTable()))));
  const env = { SystemRoot: 'D:\\Win', PATH: 'C:\\w\\node_modules\\.bin' };
  const table = await readWindowsProcessTable({ env, timeoutMs: 1234, execFileImpl: fake.impl });
  assert.deepEqual(table, fieldTable());
  assert.equal(fake.calls.length, 1);
  const [{ file, args, options }] = fake.calls;
  assert.equal(file, PS);
  assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
  assert.equal(args.length, 6);
  assert.match(args[5], /^\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8; /);
  assert.match(args[5], / Get-CimInstance Win32_Process \| ForEach-Object \{ /);
  assert.ok(args[5].includes('"$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine'), args[5]);
  assert.deepEqual(options, {
    timeout: 1234,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
    cwd: 'D:\\Win',
    signal: undefined,
  });
  assert.equal(fake.stdin.writableEnded, true, 'stdin is closed so PowerShell never waits for input');
});

test('readWindowsProcessTable resolves to an empty table on any failure', async () => {
  const failures = [
    execError('spawn powershell.exe ENOENT', { code: 'ENOENT' }),
    execError('Command failed', { code: 1 }),
    execError('Command failed', { killed: true, signal: 'SIGTERM', code: null }),
    execError('stdout maxBuffer length exceeded', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
  ];
  for (const error of failures) {
    // Partial output never counts.
    const fake = fakeExecFile((callback) => setImmediate(() => callback(error, render(fieldTable()))));
    const table = await readWindowsProcessTable({ execFileImpl: fake.impl });
    assert.ok(table instanceof Map);
    assert.equal(table.size, 0, error.message);
  }
  const empty = fakeExecFile((callback) => setImmediate(() => callback(null, '')));
  assert.equal((await readWindowsProcessTable({ execFileImpl: empty.impl })).size, 0);
  const sync = fakeExecFile((callback) => callback(null, render(fieldTable())));
  assert.equal((await readWindowsProcessTable({ execFileImpl: sync.impl })).size, fieldTable().size);
});

test('readWindowsProcessTable never throws and never hangs', async () => {
  const throwing = () => {
    throw new Error('spawn EPERM');
  };
  /** @type {Promise<Map<number, ProcInfo>> | undefined} */
  let pending;
  assert.doesNotThrow(() => {
    pending = readWindowsProcessTable({ execFileImpl: throwing });
  });
  assert.equal((await pending)?.size, 0);
  assert.equal((await readWindowsProcessTable({ env: /** @type {any} */ (null), execFileImpl: throwing })).size, 0);

  // execFile only calls back once the pipes close; a grandchild could hold them forever.
  const started = Date.now();
  const silent = fakeExecFile(() => {});
  assert.equal((await readWindowsProcessTable({ timeoutMs: 10, execFileImpl: silent.impl })).size, 0);
  assert.ok(Date.now() - started < 5000);
});

test('readWindowsProcessTable starts nothing when its signal is already aborted', async () => {
  const fake = fakeExecFile(() => {});
  const timers = liveTimers();
  const pending = readWindowsProcessTable({ execFileImpl: fake.impl, signal: AbortSignal.abort() });
  assert.equal(liveTimers(), timers, 'no timer');
  assert.deepEqual(await pending, new Map());
  assert.equal(fake.calls.length, 0, 'PowerShell is not started');
});

test('readWindowsProcessTable resolves at once with an empty table when its signal aborts', async () => {
  const controller = new AbortController();
  /** @type {ExecCallback[]} */
  const callbacks = [];
  const fake = fakeExecFile((callback) => callbacks.push(callback));
  const timers = liveTimers();
  const pending = readWindowsProcessTable({ timeoutMs: 60_000, execFileImpl: fake.impl, signal: controller.signal });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].options.signal, controller.signal, 'execFile gets the signal, to stop PowerShell');
  assert.equal(liveTimers(), timers + 1, 'the lookup timer runs');

  const abortedAt = Date.now();
  controller.abort();
  assert.deepEqual(await pending, new Map());
  assert.ok(Date.now() - abortedAt < 1000, 'settles at once');
  assert.equal(liveTimers(), timers, 'the timer is cleared');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'the listener is removed');

  // execFile then calls back with an AbortError; that changes nothing.
  callbacks[0](execError('The operation was aborted', { name: 'AbortError', code: 'ABORT_ERR' }), render(fieldTable()));
  assert.deepEqual(await pending, new Map());
});

test('readWindowsProcessTable removes its abort listener however it settles', async () => {
  const controller = new AbortController();
  const ok = fakeExecFile((callback) => setImmediate(() => callback(null, render(fieldTable()))));
  assert.deepEqual(await readWindowsProcessTable({ execFileImpl: ok.impl, signal: controller.signal }), fieldTable());
  const failed = fakeExecFile((callback) => setImmediate(() => callback(execError('Command failed', { code: 1 }), '')));
  assert.equal((await readWindowsProcessTable({ execFileImpl: failed.impl, signal: controller.signal })).size, 0);
  const throwing = () => {
    throw new Error('spawn EPERM');
  };
  assert.equal((await readWindowsProcessTable({ execFileImpl: throwing, signal: controller.signal })).size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.doesNotThrow(() => controller.abort(), 'a later abort is harmless');
});

test('aborting readWindowsProcessTable stops the child execFile started', async () => {
  const controller = new AbortController();
  /** @type {{ child?: import('node:child_process').ChildProcess }} */
  const started = {};
  const pending = readWindowsProcessTable({
    signal: controller.signal,
    // The real execFile with the options it is given, on a child that never exits by itself.
    execFileImpl: (file, args, options, callback) => {
      started.child = execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options, cwd: undefined }, callback);
      return started.child;
    },
  });
  const { child } = started;
  assert.ok(child?.pid, 'the child runs');
  // Not events.once: the child also emits the AbortError that execFile reports.
  const exited = new Promise((resolve) => child.once('exit', resolve));
  controller.abort();
  assert.deepEqual(await pending, new Map());
  await exited;
  assert.equal(child.killed, true);
});

test('collectLaunchAncestry walks the npm exec chain up to the client', () => {
  assert.deepEqual(collectLaunchAncestry(US, fieldTable()), { pids: [BIN_SHIM, OUTER_NPM, TOP_SHIM], boundaryReached: true });

  const npx = fieldTable();
  const npxCli = NPM_CLI.replace('npm-cli.js', 'npx-cli.js');
  npx.set(OUTER_NPM, { ppid: TOP_SHIM, name: 'node.exe', cmd: `${NODE} ${npxCli} -y ado-npm-exec@1.1.0 ${ARGS}` });
  npx.set(TOP_SHIM, { ppid: CLIENT, name: 'cmd.exe', cmd: `C:\\WINDOWS\\system32\\cmd.exe /d /s /c npx -y ado-npm-exec@1.1.0 ${ARGS}` });
  assert.deepEqual(collectLaunchAncestry(US, npx), { pids: [BIN_SHIM, OUTER_NPM, TOP_SHIM], boundaryReached: true });

  // npm started with a preload: the option value is not its script.
  const preload = fieldTable();
  preload.set(OUTER_NPM, { ppid: TOP_SHIM, name: 'node.exe', cmd: `${NODE} --require C:\\x\\preload.js ${NPM_CLI} exec -y -- ado-npm-exec@1.1.0 ${ARGS}` });
  assert.deepEqual(collectLaunchAncestry(US, preload), { pids: [BIN_SHIM, OUTER_NPM, TOP_SHIM], boundaryReached: true });

  const direct = new Map([
    [US, { ppid: CLIENT, name: 'node.exe', cmd: CMD.us }],
    [CLIENT, { ppid: CLIENT_PARENT, name: 'Code.exe', cmd: CMD.client }],
  ]);
  assert.deepEqual(collectLaunchAncestry(US, direct), { pids: [], boundaryReached: true });
});

test('collectLaunchAncestry finds the top of real launch chains by image name', async () => {
  for (const [title, rows] of Object.entries(CHAINS)) {
    const table = chainTable(rows);
    const shims = rows.slice(1, -1).map((_, i) => 9001 + i);
    assert.deepEqual(collectLaunchAncestry(9000, table), { pids: shims, boundaryReached: true }, title);
    const top = await resolveTopLaunchShim(9000, { platform: 'win32', readTable: async () => parseProcessTable(render(table)) });
    assert.equal(top, shims.at(-1), title);
  }
});

test('regression: a client whose command line mentions ado-npm-exec stops the walk', async () => {
  const clients = [
    // A Node.js client given the server config inline.
    {
      name: 'node.exe',
      cmd:
        `${NODE} C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@contoso\\agent\\index.js --additional-mcp-config ` +
        '"{\\"mcpServers\\":{\\"tool\\":{\\"command\\":\\"npx\\",\\"args\\":[\\"-y\\",\\"ado-npm-exec@2.0.0\\"]}}}"',
    },
    // A client given a config file named after the server.
    { name: 'node.exe', cmd: 'node.exe C:\\client\\index.js --config C:\\Users\\dev\\ado-npm-exec.json' },
    { name: 'Code.exe', cmd: `${CMD.client} --folder-uri file:///c%3A/src/ado-npm-exec` },
  ];
  for (const client of clients) {
    assert.equal(isLaunchMachinery(client.cmd, client.name), false, client.cmd);
    const table = fieldTable();
    table.set(CLIENT, { ppid: CLIENT_PARENT, ...client });
    const looked = recordLookups(table);
    assert.deepEqual(collectLaunchAncestry(US, table), { pids: [BIN_SHIM, OUTER_NPM, TOP_SHIM], boundaryReached: true });
    assert.equal(looked.includes(CLIENT_PARENT), false, 'nothing above the client is looked at');
    const top = await resolveTopLaunchShim(US, { platform: 'win32', readTable: async () => parseProcessTable(render(table)) });
    assert.equal(top, TOP_SHIM, 'the client is never returned');
  }
});

test('collectLaunchAncestry stops at a client whose parent is already dead', () => {
  const table = fieldTable();
  table.delete(CLIENT_PARENT);
  const looked = recordLookups(table);
  assert.deepEqual(collectLaunchAncestry(US, table), { pids: [BIN_SHIM, OUTER_NPM, TOP_SHIM], boundaryReached: true });
  assert.equal(looked.includes(CLIENT_PARENT), false);
});

test('regression: the walk never continues past the client into a dead ancestor', () => {
  // The client itself was started through npm (an inspector, a dev script); its launcher is already gone.
  const DEAD = 2900;
  const table = fieldTable();
  table.set(CLIENT, { ppid: CLIENT_PARENT, name: 'node.exe', cmd: `${NODE} C:\\Users\\dev\\inspector\\cli.js` });
  table.set(CLIENT_PARENT, { ppid: DEAD, name: 'node.exe', cmd: `${NODE} ${NPM_CLI} run inspect` });
  const looked = recordLookups(table);
  assert.deepEqual(collectLaunchAncestry(US, table), { pids: [BIN_SHIM, OUTER_NPM, TOP_SHIM], boundaryReached: true });
  assert.deepEqual(looked.filter((pid) => pid === CLIENT_PARENT || pid === DEAD), [], 'nothing above the client is looked at');
});

test('collectLaunchAncestry reports a truncated chain as incomplete', () => {
  const table = fieldTable();
  table.delete(OUTER_NPM);
  assert.deepEqual(collectLaunchAncestry(US, table), { pids: [BIN_SHIM], boundaryReached: false });
  assert.deepEqual(collectLaunchAncestry(US, new Map()), { pids: [], boundaryReached: false });
  assert.deepEqual(collectLaunchAncestry(99, fieldTable()), { pids: [], boundaryReached: false }, 'own row missing');
});

test('collectLaunchAncestry ends on a cycle, at maxDepth and at pid 0 or 1', () => {
  const cycle = new Map([
    [US, { ppid: 50, name: 'node.exe', cmd: CMD.us }],
    [50, { ppid: 51, name: 'cmd.exe', cmd: CMD.binShim }],
    [51, { ppid: 50, name: 'node.exe', cmd: CMD.npm }],
  ]);
  assert.deepEqual(collectLaunchAncestry(US, cycle), { pids: [50, 51], boundaryReached: false });
  const self = new Map([
    [US, { ppid: 60, name: 'node.exe', cmd: CMD.us }],
    [60, { ppid: 60, name: 'cmd.exe', cmd: CMD.binShim }],
  ]);
  assert.deepEqual(collectLaunchAncestry(US, self), { pids: [60], boundaryReached: false });
  const back = new Map([
    [US, { ppid: 70, name: 'node.exe', cmd: CMD.us }],
    [70, { ppid: US, name: 'cmd.exe', cmd: CMD.binShim }],
  ]);
  assert.deepEqual(collectLaunchAncestry(US, back), { pids: [70], boundaryReached: false });

  const shims = [BIN_SHIM, OUTER_NPM, TOP_SHIM];
  assert.deepEqual(collectLaunchAncestry(US, fieldTable(), { maxDepth: 3 }), { pids: shims, boundaryReached: false });
  assert.deepEqual(collectLaunchAncestry(US, fieldTable(), { maxDepth: 4 }), { pids: shims, boundaryReached: true });
  assert.deepEqual(collectLaunchAncestry(US, fieldTable(), { maxDepth: 0 }), { pids: [], boundaryReached: false });
  /** @type {Map<number, ProcInfo>} */
  const long = new Map([[US, { ppid: 1000, name: 'node.exe', cmd: CMD.us }]]);
  for (let pid = 1000; pid < 1020; pid++) long.set(pid, { ppid: pid + 1, name: 'cmd.exe', cmd: CMD.binShim });
  long.set(1020, { ppid: 4, name: 'Code.exe', cmd: CMD.client });
  const capped = collectLaunchAncestry(US, long);
  assert.equal(capped.pids.length, 10);
  assert.equal(capped.boundaryReached, false);
  assert.deepEqual(collectLaunchAncestry(US, long, { maxDepth: 50 }).boundaryReached, true);

  for (const root of [0, 1]) {
    const table = new Map([
      [US, { ppid: 80, name: 'node.exe', cmd: CMD.us }],
      [80, { ppid: root, name: 'node.exe', cmd: CMD.npm }],
      [root, { ppid: 0, name: 'init', cmd: '' }],
    ]);
    assert.deepEqual(collectLaunchAncestry(US, table), { pids: [80], boundaryReached: false }, `pid ${root}`);
  }
});

test('resolveTopLaunchShim returns the top shim on Windows only', async () => {
  /** @type {unknown[]} */
  const reads = [];
  const env = { SystemRoot: 'C:\\Windows' };
  const { signal } = new AbortController();
  /** @param {{ env: NodeJS.ProcessEnv, signal?: AbortSignal }} opts */
  const readTable = async (opts) => {
    reads.push(opts);
    return fieldTable();
  };
  assert.equal(await resolveTopLaunchShim(US, { platform: 'win32', env, readTable, signal }), TOP_SHIM);
  assert.deepEqual(reads, [{ env, signal }], 'the table is read once, with the env and the signal');
  assert.equal(await resolveTopLaunchShim(US, { platform: 'win32', env, readTable }), TOP_SHIM, 'no signal');

  for (const platform of /** @type {NodeJS.Platform[]} */ (['linux', 'darwin'])) {
    assert.equal(await resolveTopLaunchShim(US, { platform, env, readTable }), undefined, platform);
  }
  assert.equal(reads.length, 2, 'nothing is read off Windows');
});

test('resolveTopLaunchShim parses real PowerShell-shaped output', async () => {
  const fake = fakeExecFile((callback) => setImmediate(() => callback(null, render(fieldTable()))));
  const top = await resolveTopLaunchShim(US, {
    platform: 'win32',
    env: { SystemRoot: 'D:\\Win' },
    readTable: (opts) => readWindowsProcessTable({ ...opts, execFileImpl: fake.impl }),
  });
  assert.equal(top, TOP_SHIM);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].file, PS);
});

test('resolveTopLaunchShim gives up unless the walk reached the client', async () => {
  const truncated = fieldTable();
  truncated.delete(OUTER_NPM);
  const direct = new Map([
    [US, { ppid: CLIENT, name: 'node.exe', cmd: CMD.us }],
    [CLIENT, { ppid: CLIENT_PARENT, name: 'Code.exe', cmd: CMD.client }],
  ]);
  const win = /** @type {const} */ ({ platform: 'win32' });
  assert.equal(await resolveTopLaunchShim(US, { ...win, readTable: async () => truncated }), undefined, 'truncated');
  assert.equal(await resolveTopLaunchShim(US, { ...win, readTable: async () => new Map() }), undefined, 'empty table');
  assert.equal(await resolveTopLaunchShim(US, { ...win, readTable: async () => direct }), undefined, 'client is our parent');
  assert.equal(await resolveTopLaunchShim(US, { ...win, maxDepth: 3, readTable: async () => fieldTable() }), undefined, 'maxDepth');
  assert.equal(await resolveTopLaunchShim(US, { ...win, maxDepth: 4, readTable: async () => fieldTable() }), TOP_SHIM, 'maxDepth');

  const regression = fieldTable();
  regression.set(CLIENT, { ppid: CLIENT_PARENT, name: 'node.exe', cmd: `${NODE} C:\\Users\\dev\\inspector\\cli.js` });
  regression.set(CLIENT_PARENT, { ppid: 2900, name: 'node.exe', cmd: `${NODE} ${NPM_CLI} run inspect` });
  assert.equal(await resolveTopLaunchShim(US, { ...win, readTable: async () => regression }), TOP_SHIM, 'never above the client');
});

test('resolveTopLaunchShim never rejects', async () => {
  const win = /** @type {const} */ ({ platform: 'win32' });
  assert.equal(await resolveTopLaunchShim(US, { ...win, readTable: () => Promise.reject(new Error('boom')) }), undefined);
  const throwing = () => {
    throw new Error('boom');
  };
  assert.equal(await resolveTopLaunchShim(US, { ...win, readTable: throwing }), undefined);
  assert.equal(await resolveTopLaunchShim(US, { ...win, readTable: async () => /** @type {any} */ (undefined) }), undefined);
});

test('resolveTopLaunchShim resolves undefined when its signal aborts', async () => {
  const win = /** @type {const} */ ({ platform: 'win32' });
  let reads = 0;
  const readTable = async () => {
    reads++;
    return fieldTable();
  };
  assert.equal(await resolveTopLaunchShim(US, { ...win, readTable, signal: AbortSignal.abort() }), undefined, 'aborted before');
  assert.equal(reads, 0, 'nothing is read');

  // Aborted during the PowerShell lookup: it gets the signal and ends at once.
  const controller = new AbortController();
  const hung = fakeExecFile(() => {});
  const timers = liveTimers();
  const pending = resolveTopLaunchShim(US, {
    ...win,
    signal: controller.signal,
    readTable: (opts) => readWindowsProcessTable({ ...opts, timeoutMs: 60_000, execFileImpl: hung.impl }),
  });
  assert.equal(hung.calls.length, 1);
  assert.equal(hung.calls[0].options.signal, controller.signal);
  const abortedAt = Date.now();
  controller.abort();
  assert.equal(await pending, undefined, 'aborted during');
  assert.ok(Date.now() - abortedAt < 1000, 'settles at once');
  assert.equal(liveTimers(), timers, 'nothing keeps running');

  // A table that arrives after the abort is not used.
  const late = new AbortController();
  const lateTable = async () => {
    late.abort();
    return fieldTable();
  };
  assert.equal(await resolveTopLaunchShim(US, { ...win, readTable: lateTable, signal: late.signal }), undefined, 'aborted while reading');
  assert.equal(await resolveTopLaunchShim(US, { ...win, readTable, signal: new AbortController().signal }), TOP_SHIM, 'never aborted');
});

test('readWindowsProcessTable lists this process and its parent', { skip: process.platform !== 'win32' }, async () => {
  const table = await readWindowsProcessTable({ timeoutMs: 60_000 });
  const self = table.get(process.pid);
  assert.ok(self, `pid ${process.pid} not among ${table.size} processes`);
  assert.equal(self.ppid, process.ppid);
  assert.equal(self.name.toLowerCase(), path.win32.basename(process.execPath).toLowerCase());
  assert.ok(self.cmd.length > 0, 'own command line is readable');
  assert.ok(table.has(process.ppid), 'parent is listed');
});
