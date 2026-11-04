import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNpmArgv, buildPreinstallArgv, FORCED_NPM_FLAGS, npmFetchFlags, scriptShellFlags } from '../src/run.js';

test('forced flags keep shrinkwrapped registry.npmjs.org downloads on the feed', () => {
  assert.ok(FORCED_NPM_FLAGS.includes('--replace-registry-host=registry.npmjs.org'));
  assert.equal(FORCED_NPM_FLAGS.some((f) => f.includes('always')), false);
});

test('a fetch timeout unless the user tuned fetch timing', () => {
  const missing = () => {
    throw Object.assign(new Error('no'), { code: 'ENOENT' });
  };
  assert.deepEqual(npmFetchFlags({}, missing), ['--fetch-timeout=120000']);
  assert.deepEqual(npmFetchFlags({ npm_config_globalconfig: '/g' }, missing), ['--fetch-timeout=120000']);
  for (const key of ['npm_config_fetch_timeout', 'NPM_CONFIG_FETCH_RETRIES', 'npm_config_fetch-retry-mintimeout', 'npm_config_fetch_retry_factor']) {
    assert.deepEqual(npmFetchFlags({ [key]: '1' }, missing), [], key);
  }
  assert.deepEqual(npmFetchFlags({ npm_config_fetch_timeout: '' }, missing), ['--fetch-timeout=120000'], 'empty values do not count');
  assert.deepEqual(npmFetchFlags({ npm_config_globalconfig: '/g' }, () => 'proxy=x\n  fetch-timeout = 600000\n'), []);
  assert.deepEqual(npmFetchFlags({ npm_config_globalconfig: '/g' }, () => 'proxy=x\n'), ['--fetch-timeout=120000']);
  const denied = () => {
    throw Object.assign(new Error('no'), { code: 'EACCES' });
  };
  assert.deepEqual(npmFetchFlags({ npm_config_globalconfig: '/g' }, denied), [], 'unreadable: unknown, so leave npm alone');
});

test('npm exec argv: cache modes and extra flags before the spec', () => {
  const common = { cli: '/npm-cli.js', prefixDir: '/t', registryHref: 'https://f/', cacheDir: '/c', spec: 'tool@1.0.0', args: ['a'] };
  assert.deepEqual(buildNpmArgv(common), ['/npm-cli.js', 'exec', '--prefix=/t', '--registry=https://f/', '--cache=/c', ...FORCED_NPM_FLAGS, '--', 'tool@1.0.0', 'a']);
  assert.deepEqual(buildNpmArgv({ ...common, cacheMode: 'offline', extraFlags: ['--x'] }).slice(-5), ['--x', '--offline', '--', 'tool@1.0.0', 'a']);
  assert.deepEqual(buildNpmArgv({ ...common, cacheMode: 'prefer-offline' }).slice(-4), ['--prefer-offline', '--', 'tool@1.0.0', 'a']);
  assert.deepEqual(buildNpmArgv({ ...common, cacheMode: 'online' }).slice(-3), ['--', 'tool@1.0.0', 'a']);
});

test('a pre-install installs the same _npx folder without running the package, with plain output', () => {
  const argv = buildPreinstallArgv({ cli: '/npm-cli.js', prefixDir: '/t', registryHref: 'https://f/', cacheDir: '/c', spec: '@c/tool@1.0.0', extraFlags: ['--fetch-timeout=120000'] });
  assert.deepEqual(argv, [
    '/npm-cli.js', 'exec', '--prefix=/t', '--registry=https://f/', '--cache=/c', ...FORCED_NPM_FLAGS,
    '--color=false', '--fetch-timeout=120000', '--package=@c/tool@1.0.0', '--call=exit 0',
  ]);
  assert.equal(argv.includes('--'), false);
});

test('every inner npm links commands into the folder, with the hoisted layout whose lockfile names the version', () => {
  assert.ok(FORCED_NPM_FLAGS.includes('--bin-links=true'));
  assert.ok(FORCED_NPM_FLAGS.includes('--install-strategy=hoisted'));
});

test('npm gets an absolute script shell: a bare one would be looked up on a PATH npm fills with workspace folders', () => {
  assert.deepEqual(scriptShellFlags({}, 'linux'), ['--script-shell=/bin/sh']);
  assert.deepEqual(scriptShellFlags({ npm_config_script_shell: 'bash' }, 'darwin'), ['--script-shell=/bin/sh']);
  assert.deepEqual(scriptShellFlags({ NPM_CONFIG_SCRIPT_SHELL: '/bin/zsh' }, 'linux'), [], 'your own absolute shell');
  assert.deepEqual(scriptShellFlags({}, 'win32'), [], '%ComSpec% is absolute');
  assert.deepEqual(scriptShellFlags({ npm_config_script_shell: 'C:\\Program Files\\Git\\bin\\bash.exe' }, 'win32'), []);
  assert.deepEqual(scriptShellFlags({ npm_config_script_shell: 'bash', SystemRoot: 'D:\\Win' }, 'win32'), ['--script-shell=D:\\Win\\System32\\cmd.exe']);
});
