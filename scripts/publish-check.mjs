#!/usr/bin/env node
// Decides whether CI should publish: true when the version in package.json is
// not on the npm registry yet. Used by .github/workflows/publish.yml; writes
// publish/version/tag/first to $GITHUB_OUTPUT when that is set.
//
//   node scripts/publish-check.mjs
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Semver precedence: negative when a < b, 0 when equal, positive when a > b.
 *
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const pa = SEMVER_RE.exec(a);
  const pb = SEMVER_RE.exec(b);
  if (!pa || !pb) throw new Error(`not a semver version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  if (!pa[4] || !pb[4]) return (pa[4] ? -1 : 0) - (pb[4] ? -1 : 0);
  const xa = pa[4].split('.');
  const xb = pb[4].split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb) {
      const d = Number(xa[i]) - Number(xb[i]);
      if (d !== 0) return d;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (xa[i] !== xb[i]) {
      return xa[i] < xb[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * @typedef {object} PublishDecision
 * @property {boolean} publish
 * @property {string} version
 * @property {'latest' | 'next'} tag  npm dist-tag to publish under
 * @property {boolean} first          the package does not exist on the registry yet
 * @property {string} reason
 */

/**
 * @param {{ name: string, version: string, registry?: string, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<PublishDecision>}
 */
export async function checkPublish({ name, version, registry = 'https://registry.npmjs.org/', fetchImpl = fetch }) {
  if (!SEMVER_RE.exec(version)) throw new Error(`package.json version ${JSON.stringify(version)} is not a valid semver version`);
  const prerelease = version.split('+')[0].includes('-');
  /** @type {'latest' | 'next'} */
  const tag = prerelease ? 'next' : 'latest';
  const url = new URL(name.replace('/', '%2f'), registry.endsWith('/') ? registry : `${registry}/`);
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (res.status === 404) {
    return { publish: true, version, tag, first: true, reason: `${name} is not on the registry yet` };
  }
  if (!res.ok) throw new Error(`registry answered ${res.status} for ${url}`);
  const doc = /** @type {{ versions?: Record<string, unknown>, time?: Record<string, string>, 'dist-tags'?: Record<string, string> }} */ (
    await res.json()
  );
  if (doc.versions?.[version]) {
    return { publish: false, version, tag, first: false, reason: `${name}@${version} is already published` };
  }
  if (doc.time?.[version]) {
    throw new Error(`${name}@${version} was published and unpublished before; npm does not allow reusing a version. Bump the version.`);
  }
  const latest = doc['dist-tags']?.latest;
  if (!prerelease && latest && SEMVER_RE.test(latest) && compareVersions(version, latest) < 0) {
    throw new Error(`${version} is lower than the latest published ${latest}; publish it by hand with an explicit --tag if that is intended.`);
  }
  return { publish: true, version, tag, first: false, reason: `${name}@${version} is new (latest is ${latest ?? 'none'})` };
}

/**
 * @param {PublishDecision} decision
 * @param {string | undefined} outputFile  $GITHUB_OUTPUT
 */
export function writeOutputs(decision, outputFile) {
  if (!outputFile) return;
  const lines = [`publish=${decision.publish}`, `version=${decision.version}`, `tag=${decision.tag}`, `first=${decision.first}`];
  fs.appendFileSync(outputFile, `${lines.join('\n')}\n`);
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const decision = await checkPublish({ name: pkg.name, version: pkg.version, registry: process.env.NPM_REGISTRY });
  process.stdout.write(`${decision.publish ? 'publish' : 'skip'}: ${decision.reason}${decision.publish ? ` (dist-tag ${decision.tag})` : ''}\n`);
  writeOutputs(decision, process.env.GITHUB_OUTPUT);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`publish-check: ${error.message}\n`);
    process.exitCode = 1;
  });
}
