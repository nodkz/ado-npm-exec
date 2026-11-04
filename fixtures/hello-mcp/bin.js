#!/usr/bin/env node
const fs = require('fs');

const tag = process.env.HELLO_MCP_SHOW_VERSION ? `@${require('./package.json').version}` : '';
process.stdout.write(`REMOTE-OK${tag} ${process.argv.slice(2).join(' ')}\n`);
// Tests that need a server that keeps running: wait for a file to appear.
const waitFor = process.env.HELLO_MCP_WAIT_FOR;
if (waitFor) {
  const end = Date.now() + 120000;
  const timer = setInterval(() => {
    if (fs.existsSync(waitFor) || Date.now() > end) clearInterval(timer);
  }, 100);
}
