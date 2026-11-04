// Runs the real CLI main() with test seams: TEST_REGISTRY_HREF swaps in a
// validator for a localhost registry (the feed allowlist only admits Azure
// DevOps hosts over https); TEST_TTY=1 makes stdin and stderr count as a
// terminal, for --login; TEST_LEASE_RETRY_MS shortens the retry of a lease
// that could not be written; the random delays that spread out servers
// started together are 0. Not part of the published package; everything
// else is the production code path.
import { main } from '../src/cli.js';

const href = process.env.TEST_REGISTRY_HREF;
/** @type {import('../src/cli.js').MainDeps} */
const deps = { random: () => 0, ...(process.env.TEST_LEASE_RETRY_MS ? { leaseRetryMs: Number(process.env.TEST_LEASE_RETRY_MS) } : {}) };
if (href) {
  const url = new URL(href);
  const registry = { href, host: url.host, pathname: url.pathname, nerfDart: `//${url.host}${url.pathname}`, org: 'test' };
  deps.validateRegistry = () => registry;
}
if (process.env.TEST_TTY === '1') Object.assign(deps, { stdinIsTTY: true, stderrIsTTY: true });
const result = await main(process.argv.slice(2), deps);
process.exitCode = result.code;
