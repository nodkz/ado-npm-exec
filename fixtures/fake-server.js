// Fixture: a long-running "MCP server". Records the signals it receives to
// an events file and exits on SIGTERM/SIGINT, unless told to ignore them.
import fs from 'node:fs';

const [pidFile, eventsFile, mode] = process.argv.slice(2);
for (const sig of /** @type {NodeJS.Signals[]} */ (['SIGTERM', 'SIGINT'])) {
  process.on(sig, () => {
    fs.appendFileSync(eventsFile, `${sig}\n`);
    if (mode !== 'ignore') process.exit(0);
  });
}
fs.writeFileSync(pidFile, String(process.pid));
setInterval(() => {}, 1000);
