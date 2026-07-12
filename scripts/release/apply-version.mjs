#!/usr/bin/env node
/**
 * Apply pending changesets as one product version bump.
 *
 * Roomote ships a single product version: the root package.json field.
 * This script prepends the release section to the root CHANGELOG.md, bumps
 * the root version by the highest pending changeset level, and deletes the
 * consumed changeset files. Workspace package versions are never touched.
 *
 * Usage: node scripts/release/apply-version.mjs
 * Runs as `pnpm run version` while preparing the release PR.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyProductVersion } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');

const result = applyProductVersion(repoRoot);
if (!result) {
  console.log('No pending changesets; nothing to version.');
  process.exit(0);
}
console.log(
  `Versioned roomote ${result.previous} -> ${result.next} (${result.changesets.length} changeset(s): ${result.changesets.join(', ')})`,
);
