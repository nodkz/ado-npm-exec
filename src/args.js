/**
 * Command-line parsing (see USAGE). Options count only before the first
 * positional argument or `--`; everything after the package spec goes to the
 * package as it is, flags included.
 */

export class UsageError extends Error {
  name = 'UsageError';
}

/** @typedef {'login' | 'prewarm' | 'doctor'} Action */

/**
 * @typedef {object} ParsedArgs
 * @property {boolean} help
 * @property {boolean} version
 * @property {boolean} verbose
 * @property {Action | undefined} action
 * @property {boolean} alwaysFresh
 * @property {boolean | undefined} offlineFallback  undefined: not given on the command line
 * @property {string | undefined} tenant
 * @property {string | undefined} registry
 * @property {string | undefined} spec
 * @property {string[]} args  the package's arguments (for --prewarm: more package specs)
 */

export const USAGE = `Usage:
  ado-npm-exec [options] --registry <feed-url> [--] <package-spec> [args...]
  ado-npm-exec [options] <feed-url> <package-spec> [args...]
  ado-npm-exec --login [--tenant <guid>] <feed-url>
  ado-npm-exec --prewarm [options] <feed-url> <package-spec> [<package-spec>...]
  ado-npm-exec --doctor [options] [<feed-url> [<package-spec>]]

Runs <package-spec> from a private Azure Artifacts npm feed via "npm exec",
using a Microsoft Entra ID token acquired silently from the Azure CLI (az),
the Azure Developer CLI (azd) or azureauth. A package that ran before starts
from npm's cache with no token and no network request; a newer version is
installed in the background for the next start. Nothing is written to stdout,
and stdin is never read (--login hands the terminal to the sign-in tool).

Options (must come before the feed URL / package spec):
  --registry <url>         Azure Artifacts npm feed URL, e.g.
                           https://pkgs.dev.azure.com/contoso/_packaging/feed/npm/registry/
  --tenant <guid>          Entra ID tenant of the feed's organization (default:
                           remembered for the organization for a week, else
                           discovered from the feed's 401 response)
  --always-fresh, --fresh  Resolve the spec on the feed before every start and
                           run the newest matching version now (an exact
                           version needs no lookup)
  --no-offline-fallback    Fail instead of running the copy in npm's cache when
                           no token can be acquired, or the feed or npm fails
                           (--offline-fallback: the default)
  --verbose                Print diagnostics to stderr
  -h, --help               Show this help
  -v, --version            Show the version

Actions:
  --login                  Sign in once with az (or azd) for the feed's tenant,
                           without a subscription prompt
  --prewarm                Install the package(s) into npm's cache now, so the
                           next start needs no token and no network
  --doctor                 Print a diagnostic report to stderr (never a token;
                           review it before you share it)

Environment:
  ADO_NPM_EXEC_TOKEN               Use this Entra ID access token (JWT) instead of az/azd/azureauth
  ADO_NPM_EXEC_TENANT              Same as --tenant
  ADO_NPM_EXEC_ALWAYS_FRESH=1      Same as --always-fresh
  ADO_NPM_EXEC_OFFLINE_FALLBACK=0  Same as --no-offline-fallback
  ADO_NPM_EXEC_VERBOSE=1           Same as --verbose
  ADO_NPM_EXEC_TIMEOUT_MS          Timeout for each sign-in tool run, in ms (default 10000)
  ADO_NPM_EXEC_SHELL               Shell of the sign-in notice's commands (default: from SHELL)
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
    action: undefined,
    alwaysFresh: false,
    offlineFallback: undefined,
    tenant: undefined,
    registry: undefined,
    spec: undefined,
    args: [],
  };

  /** @param {Action} action */
  const setAction = (action) => {
    if (out.action && out.action !== action) throw new UsageError(`--${out.action} and --${action} cannot be combined`);
    out.action = action;
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
    const flag = () => {
      if (inline !== undefined) throw new UsageError(`${name} does not take a value`);
    };
    switch (name) {
      case '--registry':
        out.registry = value();
        break;
      case '--tenant':
        out.tenant = value();
        break;
      case '--verbose':
        flag();
        out.verbose = true;
        break;
      case '--always-fresh':
      case '--fresh':
        flag();
        out.alwaysFresh = true;
        break;
      case '--offline-fallback':
        flag();
        out.offlineFallback = true;
        break;
      case '--no-offline-fallback':
        flag();
        out.offlineFallback = false;
        break;
      case '--login':
      case '--prewarm':
      case '--doctor':
        flag();
        setAction(/** @type {Action} */ (name.slice(2)));
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

  if (out.action === 'doctor') {
    if (out.registry === undefined && rest.length > 0) {
      out.registry = rest[0];
      rest = rest.slice(1);
    }
    if (rest.length > 1) throw new UsageError('--doctor takes at most a feed URL and one package spec');
    out.spec = rest[0] || undefined;
    return out;
  }

  if (out.registry === undefined) {
    if (rest.length === 0) throw new UsageError(out.action === 'login' ? 'missing feed URL' : 'missing feed URL and package spec');
    out.registry = rest[0];
    rest = rest.slice(1);
  }
  if (out.action === 'login') {
    if (rest.length > 0) throw new UsageError('--login takes only the feed URL');
    return out;
  }
  if (rest.length === 0 || rest[0] === '') throw new UsageError('missing package spec');
  out.spec = rest[0];
  out.args = rest.slice(1);
  if (out.action === 'prewarm' && out.args.some((s) => s === '')) throw new UsageError('empty package spec');
  return out;
}
