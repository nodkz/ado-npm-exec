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

/** @param {unknown} text */
export function redact(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('<redacted>');
  return out
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>')
    .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '<redacted-jwt>')
    .replace(/(_authToken|_auth|_password)=\S+/g, '$1=<redacted>');
}

/**
 * @typedef {object} Logger
 * @property {boolean} verbose
 * @property {(msg: string) => void} error
 * @property {(msg: string) => void} debug
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
    debug: (msg) => {
      if (verbose) emit(msg);
    },
  };
}
