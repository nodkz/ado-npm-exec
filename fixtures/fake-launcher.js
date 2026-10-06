// Fixture: a launcher-style bin that starts the real server as its own child
// and ignores signals itself (so it does not forward them).
import { spawn } from 'node:child_process';

for (const sig of /** @type {NodeJS.Signals[]} */ (['SIGTERM', 'SIGINT'])) process.on(sig, () => {});
const server = spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit' });
server.on('exit', (code) => process.exit(code ?? 0));
