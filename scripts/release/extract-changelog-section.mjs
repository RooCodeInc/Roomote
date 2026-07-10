#!/usr/bin/env node
/**
 * Extract the CHANGELOG.md section for a product version (for GitHub Releases).
 * Usage: node scripts/release/extract-changelog-section.mjs [version]
 * Prints the section markdown to stdout, or empty if missing.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractChangelogSection, readCurrentProductVersion } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');

const versionArg = process.argv[2];
const version = versionArg || readCurrentProductVersion(repoRoot);
const changelogPath = join(repoRoot, 'CHANGELOG.md');

if (!existsSync(changelogPath)) {
  process.exit(0);
}

const section = extractChangelogSection(
  readFileSync(changelogPath, 'utf8'),
  version,
);
if (section) {
  process.stdout.write(section);
  if (!section.endsWith('\n')) process.stdout.write('\n');
}
