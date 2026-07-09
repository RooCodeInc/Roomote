/**
 * Shared helpers for the Roomote single-product Changesets release scripts.
 * Root package name is `roomote`; workspace packages use `@roomote/*`.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function listWorkspacePackageJsons(repoRoot) {
  const paths = [];
  for (const scope of ['apps', 'packages']) {
    const dir = join(repoRoot, scope);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(dir, entry.name, 'package.json');
      if (existsSync(pkgPath)) paths.push(pkgPath);
    }
  }
  return paths;
}

/**
 * Bump a semver string by the maximum of bump levels in entries.
 * Supports major|minor|patch only (no prerelease).
 */
export function computeNextVersion(current, bumpLevels) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(current);
  if (!match) {
    throw new Error(`Unsupported version: ${current}`);
  }
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);

  const levels = new Set(bumpLevels);
  if (levels.has('major')) {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (levels.has('minor')) {
    minor += 1;
    patch = 0;
  } else if (levels.has('patch')) {
    patch += 1;
  } else {
    return current;
  }
  return `${major}.${minor}.${patch}`;
}

/**
 * Parse pending Changeset markdown files (not README).
 * Returns [{ file, summary, bumps: { [pkg]: 'major'|'minor'|'patch' } }]
 */
export function parsePendingChangesets(repoRoot) {
  const dir = join(repoRoot, '.changeset');
  if (!existsSync(dir)) return [];

  const entries = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md') || name.toLowerCase() === 'readme.md') continue;
    const file = join(dir, name);
    const raw = readFileSync(file, 'utf8');
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!fmMatch) continue;

    const frontmatter = fmMatch[1];
    const body = fmMatch[2].trim();
    const bumps = {};
    for (const line of frontmatter.split(/\r?\n/)) {
      const m = line.match(/^['"]?([^'"\s:]+)['"]?:\s*(major|minor|patch)\s*$/);
      if (m) bumps[m[1]] = m[2];
    }
    if (Object.keys(bumps).length === 0) continue;
    entries.push({ file: name, summary: body, bumps });
  }
  return entries;
}

/**
 * Read a representative current product version from the fixed group.
 * Prefers root package.json when it has a version, else first workspace package.
 */
export function readCurrentProductVersion(repoRoot) {
  const rootPkg = readJson(join(repoRoot, 'package.json'));
  if (typeof rootPkg.version === 'string' && rootPkg.version) {
    return rootPkg.version;
  }
  for (const path of listWorkspacePackageJsons(repoRoot)) {
    const pkg = readJson(path);
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  }
  throw new Error('No product version found in package.json files');
}

/**
 * Extract the markdown body for a given version heading from CHANGELOG.md.
 * Matches headings like `## 0.1.1` or `## v0.1.1`.
 */
export function extractChangelogSection(changelogMarkdown, version) {
  const bare = version.replace(/^v/, '');
  const lines = changelogMarkdown.split(/\r?\n/);
  const headingRe = new RegExp(
    `^##\\s+v?${bare.replace(/\./g, '\\.')}(?:\\s|\\(|$)`,
  );
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}
