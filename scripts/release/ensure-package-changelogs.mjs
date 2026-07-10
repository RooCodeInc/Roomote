#!/usr/bin/env node
/**
 * changesets/action reads per-package CHANGELOG.md after `changeset version`
 * even when the monorepo uses a single root CHANGELOG and `"changelog": false`.
 * Ensure a stub file exists for every @roomote/* package so the Version PR
 * can open. Product release notes live only in the root CHANGELOG.md.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listWorkspacePackageJsons } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');
const stub = `# Changelog

Package versions track the monorepo product release.
See the root [CHANGELOG.md](../../CHANGELOG.md).
`;

let created = 0;
for (const pkgPath of listWorkspacePackageJsons(repoRoot)) {
  const pkgDir = dirname(pkgPath);
  const changelogPath = join(pkgDir, 'CHANGELOG.md');
  if (existsSync(changelogPath)) continue;
  writeFileSync(changelogPath, stub);
  created += 1;
  console.log(`Created ${relative(repoRoot, changelogPath)}`);
}

if (created === 0) {
  console.log('All workspace packages already have CHANGELOG.md');
} else {
  console.log(`Created ${created} package CHANGELOG.md stub(s)`);
}
