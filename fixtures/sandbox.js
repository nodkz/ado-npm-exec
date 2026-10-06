// Test sandboxes for end-to-end runs. ado-npm-exec refuses a temp directory
// whose parents other users can write to (like /tmp on Linux), so sandboxes
// live inside the repository checkout instead (ignored by git).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_TMP_BASE = fileURLToPath(new URL('../.tmp-test/', import.meta.url));

/** @param {string} [prefix] */
export function makeTestRoot(prefix = 'run-') {
  fs.mkdirSync(TEST_TMP_BASE, { recursive: true });
  return fs.mkdtempSync(path.join(TEST_TMP_BASE, prefix));
}
