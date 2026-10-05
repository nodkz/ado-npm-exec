// Fixture: spawns a grandchild that inherits (and so holds open) our stdout
// and stderr pipes, records its pid, then idles forever itself.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
fs.writeFileSync(/** @type {string} */ (process.argv[2]), String(grandchild.pid));
process.stdout.write('started\n');
if (process.argv[3] === 'exit') process.exit(0);
setInterval(() => {}, 1000);
