import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInnerEnv } from '../src/env.js';

const base = { npmrcFile: '/tmp/ado-npm-exec-x/.npmrc', registryHost: 'contoso.pkgs.visualstudio.com', scope: 'contoso' };

test('strips the outer npm exec config that would override the temp npmrc', () => {
  const env = buildInnerEnv(
    {
      PATH: '/bin',
      HOME: '/home/u',
      npm_config_registry: 'https://registry.npmjs.org/',
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
      Npm_Config_UserConfig: '/home/u/.npmrc',
      npm_config_prefix: '/usr/local',
      npm_config_package: 'evil',
      npm_config_call: 'rm -rf /',
      npm_config_global: 'true',
      npm_config_location: 'global',
      npm_config_workspaces: 'true',
      'npm_config_include-workspace-root': 'true',
      npm_config_globalconfig: '/usr/local/etc/npmrc',
      npm_config_cache: '/home/u/.npm',
      npm_config_https_proxy: 'http://proxy:8080',
      npm_config_cafile: '/etc/ca.pem',
      npm_config_foreground_scripts: 'true',
      'npm_config_//contoso.pkgs.visualstudio.com/_packaging/feed/npm/registry/:_authToken': 'stale',
      'NPM_CONFIG_//CONTOSO.PKGS.VISUALSTUDIO.COM/:_authToken': 'stale-host-level',
      'npm_config_//other.example/:_authToken': 'other-host',
      'npm_config_@contoso:registry': 'https://registry.npmjs.org/',
      'npm_config_@other:registry': 'https://other.example/',
      ADO_NPM_EXEC_TOKEN: 'secret',
      ado_npm_exec_tenant: 't',
      SYSTEM_ACCESSTOKEN: 'kept',
      AZUREAUTH_ADO_PAT: 'kept',
    },
    base,
  );
  assert.deepEqual(env, {
    PATH: '/bin',
    HOME: '/home/u',
    npm_config_globalconfig: '/usr/local/etc/npmrc',
    npm_config_cache: '/home/u/.npm',
    npm_config_https_proxy: 'http://proxy:8080',
    npm_config_cafile: '/etc/ca.pem',
    npm_config_foreground_scripts: 'true',
    'npm_config_//other.example/:_authToken': 'other-host',
    'npm_config_@other:registry': 'https://other.example/',
    SYSTEM_ACCESSTOKEN: 'kept',
    AZUREAUTH_ADO_PAT: 'kept',
    npm_config_userconfig: '/tmp/ado-npm-exec-x/.npmrc',
  });
});

test('hyphenated host names are matched whatever the separator', () => {
  const env = buildInnerEnv(
    { 'npm_config_//my-org.pkgs.visualstudio.com/:_authToken': 'stale', npm_config_globalconfig: '/g' },
    { ...base, registryHost: 'my-org.pkgs.visualstudio.com' },
  );
  assert.equal(Object.keys(env).some((k) => k.includes('my-org')), false);
});

test('defaults globalconfig the way npm does when the outer npm did not export it', () => {
  const posix = buildInnerEnv({}, { ...base, platform: 'linux', execPath: '/opt/node/bin/node' });
  assert.equal(posix.npm_config_globalconfig, '/opt/node/etc/npmrc');
  const inherited = buildInnerEnv({ npm_config_prefix: '/custom' }, { ...base, platform: 'linux', execPath: '/x/bin/node' });
  assert.equal(inherited.npm_config_globalconfig, '/custom/etc/npmrc');
  assert.equal(inherited.npm_config_prefix, undefined);
  const prefixEnv = buildInnerEnv({ PREFIX: '/p' }, { ...base, platform: 'linux', execPath: '/x/bin/node' });
  assert.equal(prefixEnv.npm_config_globalconfig, '/p/etc/npmrc');
  const win = buildInnerEnv({}, { ...base, platform: 'win32', execPath: 'C:\\nodejs\\node.exe' });
  assert.equal(win.npm_config_globalconfig, 'C:\\nodejs\\etc\\npmrc');
});

test('without a scope nothing scope-specific is touched', () => {
  const env = buildInnerEnv({ 'npm_config_@contoso:registry': 'https://x/', npm_config_globalconfig: '/g' }, { ...base, scope: undefined });
  assert.equal(env['npm_config_@contoso:registry'], 'https://x/');
});

test('drops the default scope and scoped registries that are not https', () => {
  const env = buildInnerEnv(
    {
      npm_config_scope: 'legacy',
      'npm_config_@legacy:registry': 'http://contoso.pkgs.visualstudio.com/_packaging/feed/npm/registry/',
      'NPM_CONFIG_@other:registry': ' HTTP://x/',
      'npm_config_@ok:registry': 'https://other.example/',
      npm_config_globalconfig: '/g',
    },
    { ...base, scope: undefined },
  );
  assert.deepEqual(Object.keys(env).sort(), ['npm_config_@ok:registry', 'npm_config_globalconfig', 'npm_config_userconfig']);
});

test('replaces the global config path that `npm exec --prefix=~/` derived', () => {
  const outer = {
    npm_config_prefix: '/home/u',
    npm_config_local_prefix: '/home/u',
    npm_config_globalconfig: '/home/u/etc/npmrc',
  };
  const env = buildInnerEnv(outer, { ...base, platform: 'linux', execPath: '/opt/node/bin/node' });
  assert.equal(env.npm_config_globalconfig, '/opt/node/etc/npmrc');
  const withPrefixEnv = buildInnerEnv({ ...outer, PREFIX: '/p' }, { ...base, platform: 'linux', execPath: '/opt/node/bin/node' });
  assert.equal(withPrefixEnv.npm_config_globalconfig, '/p/etc/npmrc');
  // A prefix from config files (not --prefix) leaves globalconfig alone.
  const configured = buildInnerEnv(
    { npm_config_prefix: '/home/u/.npm-global', npm_config_local_prefix: '/work/project', npm_config_globalconfig: '/home/u/.npm-global/etc/npmrc' },
    { ...base, platform: 'linux', execPath: '/opt/node/bin/node' },
  );
  assert.equal(configured.npm_config_globalconfig, '/home/u/.npm-global/etc/npmrc');
  const win = buildInnerEnv(
    { npm_config_prefix: 'C:\\Users\\u', npm_config_local_prefix: 'c:\\users\\u', npm_config_globalconfig: 'C:\\Users\\u\\etc\\npmrc' },
    { ...base, platform: 'win32', execPath: 'C:\\nodejs\\node.exe' },
  );
  assert.equal(win.npm_config_globalconfig, 'C:\\nodejs\\etc\\npmrc');
});
