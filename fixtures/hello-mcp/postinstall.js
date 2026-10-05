// Install script that tries to pollute stdout. With --foreground-scripts=false
// npm captures it, so it must never reach the MCP channel.
const fs = require('fs');

process.stdout.write('POSTINSTALL-POLLUTION\n');
if (process.env.HELLO_MCP_MARKER) fs.writeFileSync(process.env.HELLO_MCP_MARKER, 'ran');
