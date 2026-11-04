/**
 * The subset of node-semver (strict mode) and npm-pick-manifest needed to
 * pick the version npm would install for `name@<wanted>`. Where the npm
 * releases disagree, or the input is outside the subset, the answer is
 * `undefined` and npm decides: nothing here guesses.
 */

const MAX_LENGTH = 256;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const NUM = '0|[1-9]\\d*';
const NON_NUM = '\\d*[a-zA-Z-][a-zA-Z0-9-]*';
const PRE_ID = `(?:${NON_NUM}|${NUM})`;
const PRERELEASE = `(?:-(${PRE_ID}(?:\\.${PRE_ID})*))`;
const BUILD = '(?:\\+([a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*))';
const FULL_RE = new RegExp(`^v?(${NUM})\\.(${NUM})\\.(${NUM})${PRERELEASE}?${BUILD}?$`);
const LOOSE_ID = `(?:${NON_NUM}|\\d+)`;
const LOOSE_RE = new RegExp(`^[v=\\s]*(\\d+)\\.(\\d+)\\.(\\d+)(?:-?(${LOOSE_ID}(?:\\.${LOOSE_ID})*))?${BUILD}?$`);
const XID = `${NUM}|[xX*]`;
const PARTIAL_RE = new RegExp(`^v?(${XID})(?:\\.(${XID})(?:\\.(${XID})${PRERELEASE}?)?)?$`);
const OPERATOR_RE = /^(?:<=|>=|<|>|=|~>|~|\^)/;
const NUMERIC_RE = /^[0-9]+$/;
const TAG_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;
const RANGE_START_RE = /^[v=]*[xX*0-9]/;

/**
 * @typedef {object} Version
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 * @property {ReadonlyArray<string | number>} prerelease  numeric identifiers below 2^53 - 1 are numbers
 * @property {ReadonlyArray<string>} build  kept, but ignored for precedence
 * @property {string} version  normalized `1.2.3-pre.1` form, without build metadata
 */

/**
 * Opaque result of {@link parseRange}.
 *
 * @typedef {{ readonly raw: string }} ParsedRange
 */

/**
 * @typedef {{ type: 'version', version: string } | { type: 'range', range: string } | { type: 'tag', tag: string }} Wanted
 */

/**
 * @typedef {object} Packument
 * @property {string} [name]
 * @property {Record<string, unknown>} [dist-tags]
 * @property {Record<string, { version?: string, deprecated?: unknown, engines?: { node?: unknown, npm?: unknown } }>} [versions]
 */

/**
 * @typedef {object} PickOptions
 * @property {string} nodeVersion  the node version npm checks `engines.node` against, e.g. `process.version`
 * @property {string} [npmVersion]  the version of the npm that runs `npm exec` (npm passes its own): checked
 *   against `engines.npm`, and it decides how the default tag is picked. Without it, `engines.npm` is not
 *   checked (npm-pick-manifest's default) and only answers both default-tag behaviours agree on are given.
 * @property {string} [defaultTag]  npm's `tag` config; "latest" unless the user changed it
 */

/** @typedef {{ text: string, M: string, m: string | undefined, p: string | undefined, pr: string | undefined }} Partial */
/** @typedef {{ kind: 'hyphen', from: Partial, to: Partial } | { kind: 'op', op: string, partial: Partial }} Item */
/** @typedef {{ op: string, version: Version | undefined, value: string }} Comparator */
/** @typedef {{ version: Version, fresh: boolean, engine: boolean }} Ranked */
/** @typedef {{ includePrerelease: boolean, caretZero: boolean, tildePartial: boolean }} Variant */
/** @typedef {{ items: Item[][], sets: Map<Variant, Comparator[][] | null> }} RangeState */

/** @type {Variant} */
const PLAIN = { includePrerelease: false, caretZero: false, tildePartial: false };

// With includePrerelease, node-semver changed two lower bounds over time:
// `^0.m.p` lost its "-0" in 7.8.3 and `~M[.m]` gained one in 7.8.5. An answer
// is only given when all three generations agree.
/** @type {Variant[]} */
const INCLUDE_PRERELEASE = [
  { includePrerelease: true, caretZero: true, tildePartial: false },
  { includePrerelease: true, caretZero: false, tildePartial: false },
  { includePrerelease: true, caretZero: false, tildePartial: true },
];

/** @type {WeakSet<object>} */
const versions = new WeakSet();
/** @type {WeakMap<object, RangeState>} */
const ranges = new WeakMap();

/**
 * @param {RegExpExecArray} m  major, minor, patch, prerelease, build
 * @returns {Version | undefined}
 */
function fromMatch(m) {
  const [major, minor, patch] = [+m[1], +m[2], +m[3]];
  if (major > MAX_SAFE || minor > MAX_SAFE || patch > MAX_SAFE) return undefined;
  const prerelease = m[4]
    ? m[4].split('.').map((id) => (NUMERIC_RE.test(id) && +id < MAX_SAFE ? +id : id))
    : [];
  const version = `${major}.${minor}.${patch}${prerelease.length ? `-${prerelease.join('.')}` : ''}`;
  const parsed = Object.freeze({
    major,
    minor,
    patch,
    prerelease: Object.freeze(prerelease),
    build: Object.freeze(m[5] ? m[5].split('.') : []),
    version,
  });
  versions.add(parsed);
  return parsed;
}

/**
 * `semver.parse(input)` in strict mode.
 *
 * @param {unknown} input
 * @returns {Version | undefined}
 */
export function parseVersion(input) {
  if (typeof input === 'object' && input !== null && versions.has(input)) return /** @type {Version} */ (input);
  if (typeof input !== 'string' || input.length > MAX_LENGTH) return undefined;
  const m = FULL_RE.exec(input.trim());
  return m ? fromMatch(m) : undefined;
}

/**
 * Whether node-semver's loose mode, which npm uses for packument keys, would
 * accept the string as a version.
 *
 * @param {string} input
 */
function isLooseVersion(input) {
  if (input.length > MAX_LENGTH) return false;
  const m = LOOSE_RE.exec(input.trim());
  return !!m && +m[1] <= MAX_SAFE && +m[2] <= MAX_SAFE && +m[3] <= MAX_SAFE;
}

/**
 * node-semver's compareIdentifiers, including its numeric coercion of digit
 * strings (identifiers too large to be numbers stay strings).
 *
 * @param {string | number} a
 * @param {string | number} b
 * @returns {-1 | 0 | 1}
 */
function compareIdentifiers(a, b) {
  const aNum = NUMERIC_RE.test(String(a));
  const bNum = NUMERIC_RE.test(String(b));
  if (aNum && bNum) {
    const [x, y] = [+a, +b];
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (aNum) return -1;
  if (bNum) return 1;
  const [x, y] = [String(a), String(b)];
  return x === y ? 0 : x < y ? -1 : 1;
}

/**
 * @param {Version} a
 * @param {Version} b
 * @returns {-1 | 0 | 1}
 */
function compare(a, b) {
  if (a.version === b.version) return 0;
  for (const key of /** @type {const} */ (['major', 'minor', 'patch'])) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  const [ap, bp] = [a.prerelease, b.prerelease];
  if (!ap.length || !bp.length) return ap.length ? -1 : bp.length ? 1 : 0;
  for (let i = 0; ; i++) {
    const [x, y] = [ap[i], bp[i]];
    if (x === undefined && y === undefined) return 0;
    if (y === undefined) return 1;
    if (x === undefined) return -1;
    if (x !== y) return compareIdentifiers(x, y);
  }
}

/**
 * `semver.compare(a, b)`: precedence per SemVer 2.0.0, build metadata ignored.
 *
 * @param {string | Version} a
 * @param {string | Version} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) throw new TypeError(`Invalid version: ${String(x ? b : a)}`);
  return compare(x, y);
}

/** @param {string | undefined} id */
const isX = (id) => id === undefined || id === 'x' || id === 'X' || id === '*';

/**
 * A version that may be partial or contain wildcards: `1`, `v1.2`, `1.x`,
 * `1.2.3-beta.1`. Wildcards followed by numbers (`x.1`, `1.x.2`, rejected
 * since node-semver 7.8.4) and prereleases on wildcards are not supported.
 *
 * @param {string} text
 * @returns {Partial | undefined}
 */
function parsePartial(text) {
  const match = PARTIAL_RE.exec(text);
  if (!match) return undefined;
  const [, M, m, p, pr] = match;
  if ((isX(M) && !isX(m)) || (isX(m) && !isX(p)) || (pr !== undefined && isX(p))) return undefined;
  if ([M, m, p].some((n) => !isX(n) && +(/** @type {string} */ (n)) > MAX_SAFE)) return undefined;
  return { text, M, m, p, pr };
}

/**
 * One `||`-separated comparator set, already trimmed, whitespace collapsed.
 *
 * @param {string} set
 * @returns {Item[] | undefined}
 */
function parseSet(set) {
  if (set === '') return [];
  const hyphen = /^(\S+) - (\S+)$/.exec(set);
  if (hyphen) {
    const [from, to] = [parsePartial(hyphen[1]), parsePartial(hyphen[2])];
    return from && to ? [{ kind: 'hyphen', from, to }] : undefined;
  }
  /** @type {Item[]} */
  const items = [];
  const words = set.split(' ');
  for (let i = 0; i < words.length; i++) {
    const op = OPERATOR_RE.exec(words[i])?.[0] ?? '';
    let text = words[i].slice(op.length);
    // node-semver drops the whitespace after an operator: `>= 1.2.3`, `^ 1.2`.
    if (op && text === '') text = words[++i] ?? '';
    const partial = parsePartial(text);
    if (!partial) return undefined;
    items.push({ kind: 'op', op, partial });
  }
  return items;
}

/**
 * node-semver's desugaring of one item into primitive comparators, as the
 * same strings it produces (hyphenReplace, replaceCaret, replaceTilde,
 * replaceXRange and replaceStars).
 *
 * @param {Item} item
 * @param {Variant} variant
 * @returns {string[]}
 */
function desugar(item, variant) {
  const z = variant.includePrerelease ? '-0' : '';
  if (item.kind === 'hyphen') {
    const { from: f, to: t } = item;
    const from = isX(f.M)
      ? ''
      : isX(f.m)
        ? `>=${f.M}.0.0${z}`
        : isX(f.p)
          ? `>=${f.M}.${f.m}.0${z}`
          : `>=${f.text}${f.pr ? '' : z}`;
    const to = isX(t.M)
      ? ''
      : isX(t.m)
        ? `<${+t.M + 1}.0.0-0`
        : isX(t.p)
          ? `<${t.M}.${+(/** @type {string} */ (t.m)) + 1}.0-0`
          : t.pr
            ? `<=${t.M}.${t.m}.${t.p}-${t.pr}`
            : variant.includePrerelease
              ? `<${t.M}.${t.m}.${+(/** @type {string} */ (t.p)) + 1}-0`
              : `<=${t.text}`;
    return [from, to].filter(Boolean);
  }
  const { op, partial } = item;
  const { M, m, p, pr } = partial;
  const [nM, nm, np] = [+M, Number(m), Number(p)];
  if (op === '^' || op === '~' || op === '~>') {
    if (isX(M)) return [''];
    if (op === '^') {
      if (isX(m)) return [`>=${M}.0.0${z}`, `<${nM + 1}.0.0-0`];
      if (isX(p)) return M === '0' ? [`>=0.${m}.0${z}`, `<0.${nm + 1}.0-0`] : [`>=${M}.${m}.0${z}`, `<${nM + 1}.0.0-0`];
      const low = `>=${M}.${m}.${p}${pr ? `-${pr}` : M === '0' && variant.caretZero ? z : ''}`;
      if (M !== '0') return [low, `<${nM + 1}.0.0-0`];
      return m === '0' ? [low, `<0.0.${np + 1}-0`] : [low, `<0.${nm + 1}.0-0`];
    }
    const zt = variant.tildePartial ? z : '';
    if (isX(m)) return [`>=${M}.0.0${zt}`, `<${nM + 1}.0.0-0`];
    if (isX(p)) return [`>=${M}.${m}.0${zt}`, `<${M}.${nm + 1}.0-0`];
    return [`>=${M}.${m}.${p}${pr ? `-${pr}` : ''}`, `<${M}.${nm + 1}.0-0`];
  }
  const xM = isX(M);
  const xm = xM || isX(m);
  const xp = xm || isX(p);
  if (!xp) return [`${op}${partial.text}`];
  const gtlt = op === '=' ? '' : op;
  if (xM) return gtlt === '>' || gtlt === '<' ? ['<0.0.0-0'] : [''];
  if (gtlt === '>') return [xm ? `>=${nM + 1}.0.0${z}` : `>=${M}.${nm + 1}.0${z}`];
  if (gtlt === '<=') return [xm ? `<${nM + 1}.0.0-0` : `<${M}.${nm + 1}.0-0`];
  if (gtlt === '<') return [`<${M}.${xm ? 0 : m}.0-0`];
  if (gtlt === '>=') return [`>=${M}.${xm ? 0 : m}.0${z}`];
  return xm ? [`>=${M}.0.0${z}`, `<${nM + 1}.0.0-0`] : [`>=${M}.${m}.0${z}`, `<${M}.${nm + 1}.0-0`];
}

/**
 * node-semver's `new Comparator(text)`, after its `>=0.0.0` => `*` rewrite.
 *
 * @param {string} text
 * @param {Variant} variant
 * @returns {Comparator | undefined}
 */
function toComparator(text, variant) {
  if (text === '' || text === (variant.includePrerelease ? '>=0.0.0-0' : '>=0.0.0')) {
    return { op: '', version: undefined, value: '' };
  }
  const [, gtlt, rest] = /** @type {RegExpExecArray} */ (/^([<>]?=?)(.*)$/.exec(text));
  const version = parseVersion(rest);
  if (!version) return undefined;
  const op = gtlt === '=' ? '' : gtlt;
  return { op, version, value: op + version.version };
}

/**
 * One comparator set as node-semver's Range#parseRange builds it, or null
 * when node-semver would throw.
 *
 * @param {Item[]} items
 * @param {Variant} variant
 * @returns {Comparator[] | null}
 */
function comparatorSet(items, variant) {
  const texts = items.flatMap((item) => desugar(item, variant));
  /** @type {Comparator[]} */
  const comparators = [];
  for (const text of texts.length ? texts : ['']) {
    const comparator = toComparator(text, variant);
    if (!comparator) return null;
    comparators.push(comparator);
  }
  const nullSet = comparators.find((c) => c.value === '<0.0.0-0');
  if (nullSet) return [nullSet];
  /** @type {Map<string, Comparator>} */
  const unique = new Map();
  for (const c of comparators) unique.set(c.value, unique.get(c.value) ?? c);
  if (unique.size > 1) unique.delete('');
  return [...unique.values()];
}

/**
 * The comparator sets node-semver builds for a range and options, or null
 * when node-semver would throw for them.
 *
 * @param {RangeState} state
 * @param {Variant} variant
 * @returns {Comparator[][] | null}
 */
function comparatorSets(state, variant) {
  const cached = state.sets.get(variant);
  if (cached !== undefined) return cached;
  /** @type {Comparator[][] | null} */
  let sets = [];
  for (const items of state.items) {
    const set = comparatorSet(items, variant);
    if (!set) {
      sets = null;
      break;
    }
    sets.push(set);
  }
  if (sets && sets.length > 1) {
    const kept = sets.filter((set) => set[0].value !== '<0.0.0-0');
    const any = kept.find((set) => set.length === 1 && set[0].value === '');
    sets = any ? [any] : kept.length ? kept : [sets[0]];
  }
  state.sets.set(variant, sets);
  return sets;
}

/**
 * node-semver's Range#test with a parsed version.
 *
 * @param {Comparator[][] | null} sets
 * @param {Version} v
 * @param {boolean} includePrerelease
 */
function testSets(sets, v, includePrerelease) {
  return !!sets?.some((set) => {
    for (const { op, version } of set) {
      if (!version) continue;
      const c = compare(v, version);
      const ok = op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '>=' ? c >= 0 : c === 0;
      if (!ok) return false;
    }
    if (!v.prerelease.length || includePrerelease) return true;
    // A prerelease only matches a set that names a prerelease of the same major.minor.patch.
    return set.some(
      ({ version: c }) => !!c?.prerelease.length && c.major === v.major && c.minor === v.minor && c.patch === v.patch,
    );
  });
}

/**
 * Parse a range like node-semver's strict `new Range(input)`.
 *
 * Returns undefined when node-semver rejects the range, and also for valid
 * syntax this module does not support: build metadata (`+build`) anywhere,
 * wildcards followed by numbers (`x.1`, `1.x.2`), prerelease tags on
 * wildcards (`1.2.x-pre`), version prefixes other than one `v` (`v=1`, `==1`,
 * `^=1.2.3`, `>= =1`), and inputs over 256 characters.
 *
 * @param {unknown} input
 * @returns {ParsedRange | undefined}
 */
export function parseRange(input) {
  if (typeof input !== 'string' || input.length > MAX_LENGTH || input.includes('+')) return undefined;
  const raw = input.trim().replace(/\s+/g, ' ');
  /** @type {Item[][]} */
  const items = [];
  for (const set of raw.split('||')) {
    const parsed = parseSet(set.trim());
    if (!parsed) return undefined;
    items.push(parsed);
  }
  /** @type {RangeState} */
  const state = { items, sets: new Map() };
  if (!comparatorSets(state, PLAIN)) return undefined;
  const range = Object.freeze({ raw });
  ranges.set(range, state);
  return range;
}

/**
 * `semver.satisfies(version, range, opts)` for a version and range that
 * parse in strict mode. Undefined when either cannot be parsed by this
 * module, or, with `includePrerelease`, when node-semver releases disagree.
 *
 * @param {string | Version} version
 * @param {string | ParsedRange} range
 * @param {{ includePrerelease?: boolean }} [opts]
 * @returns {boolean | undefined}
 */
export function satisfies(version, range, opts = {}) {
  const v = parseVersion(version);
  const parsed = typeof range === 'string' ? parseRange(range) : range;
  const state = typeof parsed === 'object' && parsed !== null ? ranges.get(parsed) : undefined;
  if (!v || !state) return undefined;
  if (!opts?.includePrerelease) return testSets(comparatorSets(state, PLAIN), v, false);
  const [first, ...rest] = INCLUDE_PRERELEASE.map((variant) => testSets(comparatorSets(state, variant), v, true));
  return rest.every((r) => r === first) ? first : undefined;
}

/**
 * How npm classifies the part after `name@` (npm-package-arg), for the
 * cases this module can resolve: an exact version, a range, or a dist-tag.
 * Undefined when npm must decide.
 *
 * @param {unknown} wanted
 * @returns {Wanted | undefined}
 */
export function classifyWanted(wanted) {
  if (typeof wanted !== 'string') return undefined;
  const spec = wanted.trim();
  if (spec === '') return { type: 'range', range: '*' };
  const version = parseVersion(spec);
  if (version) return { type: 'version', version: version.version };
  if (parseRange(spec)) return { type: 'range', range: spec };
  // Anything that starts like a version could be a range in loose mode, which npm uses.
  if (TAG_RE.test(spec) && encodeURIComponent(spec) === spec && !RANGE_START_RE.test(spec)) return { type: 'tag', tag: spec };
  return undefined;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// npm 10.8.2 bundles npm-pick-manifest 9.1.0, the first to check the default tag's engines and deprecation.
const CHECKED_DEFAULT_TAG = /** @type {Version} */ (parseVersion('10.8.2'));

/**
 * A property read with the same key coercion as npm's `obj[key]`.
 *
 * @param {Record<string, unknown>} obj
 * @param {unknown} key
 */
const get = (obj, key) => obj[/** @type {string} */ (key)];

/**
 * The manifest npm picks for `versions[key]`, as an exact version that
 * selects the same manifest again; null when there is none.
 *
 * @param {Record<string, unknown>} versionMap
 * @param {unknown} key
 * @returns {string | null | undefined}
 */
function exact(versionMap, key) {
  if (!get(versionMap, key)) return null;
  return isCanonical(versionMap, key) ? /** @type {string} */ (key) : undefined;
}

/**
 * The key is an own, normalized version (so `name@<key>` reads it back) of a manifest object.
 *
 * @param {Record<string, unknown>} versionMap
 * @param {unknown} key
 */
function isCanonical(versionMap, key) {
  return (
    typeof key === 'string' && Object.hasOwn(versionMap, key) && isRecord(versionMap[key]) && parseVersion(key)?.version === key
  );
}

/**
 * `semver.satisfies(key, range, { loose: true })` as npm-pick-manifest calls
 * it; undefined for keys only loose parsing accepts.
 *
 * @param {string} key
 * @param {ParsedRange} range
 */
function keySatisfies(key, range) {
  const v = parseVersion(key);
  if (v) return /** @type {boolean} */ (satisfies(v, range));
  return isLooseVersion(key) ? undefined : false;
}

/**
 * npm-install-checks' checkEngine as a verdict: true when the manifest's
 * engines accept the given node/npm versions, undefined when undecidable.
 *
 * @param {string} nodeVersion
 * @param {string | undefined} npmVersion
 * @returns {(manifest: Record<string, unknown>) => boolean | undefined}
 */
function engineCheck(nodeVersion, npmVersion) {
  /** @type {Map<string, ParsedRange | undefined>} */
  const cache = new Map();
  /**
   * `current && wanted && !semver.satisfies(current, wanted, { includePrerelease: true })`
   *
   * @param {string | undefined} current
   * @param {unknown} wanted
   * @returns {boolean | undefined}
   */
  const fails = (current, wanted) => {
    if (!current || !wanted) return false;
    // node-semver throws for anything but a string range, and an invalid version never satisfies.
    const version = parseVersion(current);
    if (typeof wanted !== 'string' || !version) return true;
    if (!cache.has(wanted)) cache.set(wanted, parseRange(wanted));
    const range = cache.get(wanted);
    const ok = range && satisfies(version, range, { includePrerelease: true });
    return ok === undefined ? undefined : !ok;
  };
  return (manifest) => {
    const engines = manifest.engines;
    if (!engines) return true;
    const { node, npm } = /** @type {Record<string, unknown>} */ (engines);
    const verdicts = [fails(nodeVersion, node), fails(npmVersion, npm)];
    return verdicts.includes(true) ? false : verdicts.includes(undefined) ? undefined : true;
  };
}

/**
 * The version `npm exec name@<wanted>` would run, mirroring npm-pick-manifest
 * (without `before`, `avoid`, staged or policy-restricted versions):
 * a string to pass as `name@<exact>`, null when npm finds no matching
 * version, or undefined when this module cannot be sure of npm's answer.
 *
 * npm passes its own version as `npmVersion`, and that version matters:
 * before npm 10.8.2 (npm-pick-manifest 9.1.0) the default tag was taken
 * without checking its engines and deprecation. Without `npmVersion`, a
 * result is only given when both behaviours agree.
 *
 * @param {Packument} packument
 * @param {string} wanted  the part after `name@`; '' for a bare name
 * @param {PickOptions} opts
 * @returns {string | null | undefined}
 */
export function pickVersion(packument, wanted, opts) {
  if (!isRecord(packument) || !isRecord(opts)) return undefined;
  const { nodeVersion, npmVersion, defaultTag = 'latest' } = opts;
  if (typeof nodeVersion !== 'string' || (npmVersion != null && typeof npmVersion !== 'string')) return undefined;
  const tag = classifyWanted(defaultTag);
  if (tag?.type !== 'tag' || tag.tag !== defaultTag) return undefined;
  const want = classifyWanted(wanted);
  const distTags = packument['dist-tags'] || {};
  const versionMap = packument.versions || {};
  if (!want || !isRecord(distTags) || !isRecord(versionMap)) return undefined;
  if (want.type === 'tag') return exact(versionMap, get(distTags, want.tag));
  if (want.type === 'version') return exact(versionMap, want.version);

  const range = /** @type {ParsedRange} */ (parseRange(want.range));
  const engineOk = engineCheck(nodeVersion, npmVersion ?? undefined);
  const npm = parseVersion(npmVersion);
  const checksDefaultTag = npm && compare(npm, CHECKED_DEFAULT_TAG) >= 0;
  /** @type {string | undefined} */
  let unchecked;
  // The default tag wins when it satisfies the range and (since npm 10.8.2) its manifest is usable.
  const latest = get(distTags, defaultTag);
  if (latest) {
    if (typeof latest !== 'string') return undefined;
    const inRange = want.range === '*' || keySatisfies(latest, range);
    if (inRange === undefined) return undefined;
    const manifest = inRange ? get(versionMap, latest) : undefined;
    if (manifest) {
      if (!isRecord(manifest)) return undefined;
      const usable = manifest.deprecated ? false : engineOk(manifest);
      const canonical = isCanonical(versionMap, latest);
      if (usable === true || checksDefaultTag === false) return canonical ? latest : undefined;
      if (usable === undefined || (checksDefaultTag === undefined && !canonical)) return undefined;
      // Unusable: newer npm sorts the versions below, older npm takes it anyway.
      if (checksDefaultTag === undefined) unchecked = latest;
    }
  }

  /** @type {{ key: string, version: Version, fresh: boolean, engine: boolean | undefined }[]} */
  const candidates = [];
  for (const [key, manifest] of Object.entries(versionMap)) {
    const inRange = keySatisfies(key, range);
    if (!inRange) {
      if (inRange === undefined) return undefined;
      continue;
    }
    const version = /** @type {Version} */ (parseVersion(key));
    // Huge numeric prerelease identifiers break node-semver's ordering; other keys npm would read differently.
    const huge = version.prerelease.some((id) => typeof id === 'string' && NUMERIC_RE.test(id));
    if (huge || !isCanonical(versionMap, key) || !isRecord(manifest)) return undefined;
    candidates.push({ key, version, fresh: !manifest.deprecated, engine: engineOk(manifest) });
  }
  /** npm-pick-manifest's order: usable, then engine-ok, then not deprecated, then highest. @param {Ranked} a @param {Ranked} b */
  const order = (a, b) =>
    +(b.fresh && b.engine) - +(a.fresh && a.engine) || +b.engine - +a.engine || +b.fresh - +a.fresh || compare(b.version, a.version);
  /** @type {(Ranked & { key: string })[]} */
  const decided = [];
  for (const c of candidates) if (c.engine !== undefined) decided.push({ ...c, engine: c.engine });
  const best = decided.sort(order)[0];
  // An undecidable engines verdict matters only when that version could win.
  const contested = candidates.some(
    (c) => c.engine === undefined && (!best || order({ ...c, engine: true }, best) < 0 || order({ ...c, engine: false }, best) < 0),
  );
  if (contested) return undefined;
  const winner = best ? best.key : null;
  return unchecked === undefined || unchecked === winner ? winner : undefined;
}
