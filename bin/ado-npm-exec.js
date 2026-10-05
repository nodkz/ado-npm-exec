#!/usr/bin/env node
// Entry point. Never writes to stdout: it belongs to the launched MCP server.
import { main } from '../src/cli.js';

if (Number(process.versions.node.split('.')[0]) < 20) {
  process.stderr.write(`ado-npm-exec: Node.js 20 or newer is required (found ${process.version}).\n`);
  process.exit(1);
}

const result = await main(process.argv.slice(2));
if (result.signal && process.platform !== 'win32') {
  // Mirror how the child ended so our parent sees the same outcome.
  process.kill(process.pid, result.signal);
}
process.exitCode = result.code;
