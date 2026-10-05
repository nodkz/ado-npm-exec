/**
 * Command-line parsing.
 *
 *   ado-npm-exec [options] --registry <url> [--] <spec> [args...]
 *   ado-npm-exec [options] <registryUrl> <spec> [args...]
 *
 * Options are only recognized before the first positional argument or `--`.
 * Everything after `<spec>` is passed to the package verbatim, including
 * arguments that look like flags.
 */

export class UsageError extends Error {
  name = 'UsageError';
}

/**
 * @typedef {object} ParsedArgs
 * @property {boolean} help
 * @property {boolean} version
 * @property {boolean} verbose
 * @property {string | undefined} tenant
 * @property {string | undefined} registry
 * @property {string | undefined} spec
 * @property {string[]} args
 */

export const USAGE = `Usage:
  ado-npm-exec [options] --registry <feed-url> [--] <package-spec> [args...]
  ado-npm-exec [options] <feed-url> <package-spec> [args...]

Runs <package-spec> from a private Azure Artifacts npm feed via "npm exec",
using a Microsoft Entra ID token acquired silently from Azure CLI (az) or
azureauth. Nothing is written to stdout and stdin is never read.

Options (must come before the feed URL / package spec):
  --registry <url>   Azure Artifacts npm feed URL, e.g.
                     https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/
  --tenant <guid>    Entra ID tenant of the feed's organization (default:
                     discovered from the feed's 401 response)
  --verbose          Print diagnostics to stderr
  -h, --help         Show this help
  -v, --version      Show the version

Environment:
  ADO_NPM_EXEC_TOKEN       Use this Entra ID access token (JWT) instead of az/azureauth
  ADO_NPM_EXEC_TENANT      Same as --tenant
  ADO_NPM_EXEC_VERBOSE=1   Same as --verbose
  ADO_NPM_EXEC_TIMEOUT_MS  Per token-provider timeout in ms (default 10000)
`;

/**
 * @param {readonly string[]} argv arguments after the executable name
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  /** @type {ParsedArgs} */
  const out = {
    help: false,
    version: false,
    verbose: false,
    tenant: undefined,
    registry: undefined,
    spec: undefined,
    args: [],
  };

  /** @type {string[]} */
  let rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      rest = argv.slice(i + 1);
      break;
    }
    if (!a.startsWith('-') || a === '-') {
      rest = argv.slice(i);
      break;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);
    /** @returns {string} */
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next === '--') {
        throw new UsageError(`${name} requires a value`);
      }
      i++;
      return next;
    };
    switch (name) {
      case '--registry':
        out.registry = value();
        break;
      case '--tenant':
        out.tenant = value();
        break;
      case '--verbose':
        if (inline !== undefined) throw new UsageError('--verbose does not take a value');
        out.verbose = true;
        break;
      case '-h':
      case '--help':
        out.help = true;
        return out;
      case '-v':
      case '--version':
        out.version = true;
        return out;
      default:
        throw new UsageError(`unknown option ${name}`);
    }
  }

  if (out.registry === undefined) {
    if (rest.length === 0) throw new UsageError('missing feed URL and package spec');
    out.registry = rest[0];
    rest = rest.slice(1);
  }
  if (rest.length === 0 || rest[0] === '') throw new UsageError('missing package spec');
  out.spec = rest[0];
  out.args = rest.slice(1);
  return out;
}
