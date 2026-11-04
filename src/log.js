/**
 * stderr-only logger. stdout belongs to the MCP JSON-RPC channel of the
 * package we launch, so this module (and the whole bootstrapper) never
 * writes there.
 */

/** @type {Set<string>} */
const secrets = new Set();

/** Register a value that must never appear in diagnostics. @param {string} value */
export function addSecret(value) {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}

// A password may contain "@", so the userinfo ends at the LAST "@" before the
// next "/", whitespace or quote.
const URL_USERINFO_RE = /\/\/[^/\s'"`]+@/g;
const SECRET_PARAM_RE = /([?&#](?:token|access_token|auth|password|pass|pwd|secret|key|sig|signature|code)=)[^&#\s'"`]+/gi;

/**
 * Mask the credentials a URL can carry: the userinfo of "scheme://user:pass@host"
 * and of npm's scheme-less "//user:pass@host/path", and the value of a query
 * (or fragment) parameter named like a credential, such as "?token=", "&sig="
 * or "#access_token=". Text without "//...@", such as "@scope/name@1.0.0",
 * "dev@contoso.com" or the npmrc key "//host/path/:_authToken=", stays as it is.
 *
 * @param {string} text
 * @returns {string}
 */
export function maskUrlCredentials(text) {
  return text.replace(URL_USERINFO_RE, '//<credentials>@').replace(SECRET_PARAM_RE, '$1<redacted>');
}

/** @param {unknown} text */
export function redact(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('<redacted>');
  return maskUrlCredentials(out)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>')
    .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '<redacted-jwt>')
    .replace(/(_authToken|_auth|_password)=\S+/g, '$1=<redacted>');
}

/**
 * @typedef {object} Logger
 * @property {boolean} verbose
 * @property {(msg: string) => void} error
 * @property {(msg: string) => void} info   always printed: rare events worth seeing in a client's log
 * @property {(msg: string) => void} debug  only with --verbose
 */

/**
 * @param {{ verbose?: boolean, write?: (s: string) => void }} [opts]
 * @returns {Logger}
 */
export function createLogger({ verbose = false, write = (s) => void process.stderr.write(s) } = {}) {
  const emit = (/** @type {string} */ msg) => write(`ado-npm-exec: ${redact(msg)}\n`);
  return {
    verbose,
    error: emit,
    info: emit,
    debug: (msg) => {
      if (verbose) emit(msg);
    },
  };
}
