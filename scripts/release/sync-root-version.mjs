#!/usr/bin/env node
/**
 * After `changeset version`, copy the lockstep `@roomote/*` version onto the
 * root `package.json` so the root remains the canonical product version.
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listWorkspacePackageJsons, readJson } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');

function readWorkspaceVersions() {
  const versions = [];
  for (const path of listWorkspacePackageJsons(repoRoot)) {
    const pkg = readJson(path);
    if (
      typeof pkg.name === 'string' &&
      pkg.name.startsWith('@roomote/') &&
      typeof pkg.version === 'string' &&
      pkg.version
    ) {
      versions.push({ name: pkg.name, version: pkg.version, path });
    }
  }
  if (versions.length === 0) {
    throw new Error('No @roomote/* package versions found to sync');
  }
  const unique = [...new Set(versions.map((entry) => entry.version))];
  if (unique.length !== 1) {
    const detail = versions
      .map((entry) => `${entry.name}@${entry.version}`)
      .join(', ');
    throw new Error(
      `Expected a single lockstep product version across @roomote/* packages; found: ${detail}`,
    );
  }
  return versions[0];
}

const { name, version } = readWorkspaceVersions();
const rootPath = join(repoRoot, 'package.json');
const root = readJson(rootPath);
if (root.version === version) {
  console.log(`Root version already ${version} (from ${name})`);
  process.exit(0);
}

root.version = version;
writeFileSync(rootPath, `${JSON.stringify(root, null, 2)}\n`);
console.log(`Synced root package.json version to ${version} (from ${name})`);
