// Runs the real CLI main() against a localhost test registry. The feed
// allowlist only admits Azure DevOps hosts over https, so this test-only
// entry point (not part of the published package) swaps in a validator for
// TEST_REGISTRY_HREF. Everything else is the production code path.
import { main } from '../src/cli.js';

const href = /** @type {string} */ (process.env.TEST_REGISTRY_HREF);
const url = new URL(href);
const registry = { href, host: url.host, pathname: url.pathname, nerfDart: `//${url.host}${url.pathname}`, org: 'test' };

const result = await main(process.argv.slice(2), { validateRegistry: () => registry });
process.exitCode = result.code;
