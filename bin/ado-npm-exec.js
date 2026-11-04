#!/usr/bin/env node
// Entry point. Never writes to stdout: it belongs to the launched MCP server.

// A client that stopped reading our stderr must not crash us mid-shutdown,
// before the server tree is stopped and the token files are removed. Node
// reports the closed pipe asynchronously through this event; any other
// stream error stays fatal.
const READER_GONE = new Set(['EPIPE', 'EOF', 'ECONNRESET', 'ENOTCONN', 'ERR_STREAM_DESTROYED']);
process.stderr.on('error', (error) => {
  if (!READER_GONE.has(/** @type {NodeJS.ErrnoException} */ (error).code ?? '')) throw error;
});

if (Number(process.versions.node.split('.')[0]) < 20) {
  process.stderr.write(
    `ado-npm-exec: Node.js 20 or newer is required, but it was started with Node.js ${process.version} (${process.execPath}).\n` +
      'ado-npm-exec: Install the current Node.js LTS, then restart your MCP client. If a newer Node.js is already installed, ' +
      'the client is not starting it: an editor opened from the desktop may not see the PATH your shell sets up (nvm, Homebrew).\n',
  );
  process.exit(1);
}

const { main } = await import('../src/cli.js');
const result = await main(process.argv.slice(2));
if (result.signal && process.platform !== 'win32') {
  // Mirror how the child ended so our parent sees the same outcome.
  process.kill(process.pid, result.signal);
}
process.exitCode = result.code;
