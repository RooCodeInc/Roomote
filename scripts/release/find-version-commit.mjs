#!/usr/bin/env node
/**
 * Print the commit SHA that introduced a product version (the release PR merge
 * commit). Used by the Release workflow to freeze the promote PR at the
 * versioned commit instead of the moving develop tip.
 *
 * Usage: node scripts/release/find-version-commit.mjs <version> [ref]
 * Prints the full SHA to stdout, or exits 1 when the version is not the
 * contiguous tip version of the ref.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findVersionCommit } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');

const version = process.argv[2];
const ref = process.argv[3] || 'HEAD';

if (!version) {
  console.error(
    'Usage: node scripts/release/find-version-commit.mjs <version> [ref]',
  );
  process.exit(1);
}

const sha = findVersionCommit({ cwd: repoRoot, version, ref });
if (!sha) {
  console.error(
    `No commit introducing version ${version} found from ${ref}; is ${version} the current version on that ref?`,
  );
  process.exit(1);
}
process.stdout.write(`${sha}\n`);
