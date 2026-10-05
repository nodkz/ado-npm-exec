#!/usr/bin/env node
// Manual smoke test against a REAL private Azure Artifacts npm feed, using
// your real az / azureauth login. Not run in CI.
//
//   SMOKE_REGISTRY=https://pkgs.dev.azure.com/<org>/_packaging/<feed>/npm/registry/ \
//   SMOKE_SPEC=@scope/pkg@1.2.3 \
//   SMOKE_ARGS="--version" \
//   node scripts/smoke.mjs
//
// Set SMOKE_MCP=1 when SMOKE_SPEC is an MCP stdio server: the script then sends
// an `initialize` request and requires a JSON-RPC response as the very first
// line on stdout. SMOKE_TIMEOUT_MS (default 180000) bounds the whole run.
//
// Passes when: the run succeeds, stdout holds only the package's own output,
// and no ado-npm-exec-* temp directory is left behind.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/ado-npm-exec.js', import.meta.url));
const registry = process.env.SMOKE_REGISTRY;
const spec = process.env.SMOKE_SPEC;
const args = (process.env.SMOKE_ARGS ?? '').split(' ').filter(Boolean);
const mcp = process.env.SMOKE_MCP === '1';
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);

if (!registry || !spec) {
  process.stderr.write('Set SMOKE_REGISTRY and SMOKE_SPEC (see the header of scripts/smoke.mjs).\n');
  process.exit(2);
}

const tempDirs = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ado-npm-exec-')));
const before = tempDirs();
const started = Date.now();
/** @type {string[]} */
const failures = [];

const child = spawn(process.execPath, [BIN, '--verbose', '--registry', registry, '--', spec, ...args], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
let stdout = '';
child.stdout.setEncoding('utf8').on('data', (d) => {
  stdout += d;
  if (mcp) checkMcp();
});

let mcpAnswered = false;
function checkMcp() {
  const nl = stdout.indexOf('\n');
  if (mcpAnswered || nl === -1) return;
  mcpAnswered = true;
  try {
    const msg = JSON.parse(stdout.slice(0, nl));
    if (msg.jsonrpc !== '2.0' || msg.id !== 1 || !(msg.result || msg.error)) failures.push(`first stdout line is not the initialize response: ${stdout.slice(0, nl)}`);
    else process.stderr.write(`smoke: initialize answered by ${JSON.stringify(msg.result?.serverInfo ?? msg.error)}\n`);
  } catch {
    failures.push(`first stdout line is not JSON: ${stdout.slice(0, nl)}`);
  }
  child.stdin.end(); // a well-behaved stdio server exits when stdin closes
  setTimeout(() => child.kill('SIGTERM'), 15_000).unref();
}

if (mcp) {
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ado-npm-exec-smoke', version: '0.0.0' } },
    })}\n`,
  );
} else {
  child.stdin.end();
}

const killer = setTimeout(() => {
  failures.push(`timed out after ${timeoutMs} ms`);
  child.kill('SIGTERM');
}, timeoutMs);

child.on('exit', (code, signal) => {
  clearTimeout(killer);
  if (mcp && !mcpAnswered) failures.push('no initialize response on stdout');
  if (!mcp && code !== 0) failures.push(`exit ${signal ?? code}`);
  // Give the bootstrapper a moment to finish cleanup before checking.
  setTimeout(() => {
    const leftovers = [...tempDirs()].filter((d) => !before.has(d));
    if (leftovers.length) failures.push(`temp directories left behind: ${leftovers.join(', ')}`);
    process.stderr.write(`smoke: stdout was ${JSON.stringify(stdout.length > 500 ? `${stdout.slice(0, 500)}...` : stdout)}\n`);
    process.stderr.write(`smoke: finished in ${Date.now() - started} ms (exit ${signal ?? code})\n`);
    if (failures.length) {
      for (const f of failures) process.stderr.write(`smoke: FAIL ${f}\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write('smoke: PASS\n');
    }
  }, 200);
});
