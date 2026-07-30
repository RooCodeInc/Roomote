/**
 * Shared helpers for the Roomote single-product Changesets release scripts.
 * Root package name is `roomote`; workspace packages use `@roomote/*`.
 */

import { execFileSync } from 'node:child_process';
import {
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
 * Read the current product version: the root package.json version, falling
 * back to the first workspace package that carries one.
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
 * Insert a new release section after the changelog title and intro prose,
 * before the first `##` release heading. Preserves any intro paragraph(s)
 * under `# Changelog` instead of inserting between the title and intro.
 *
 * @param {string} existingChangelogMarkdown
 * @param {string} newSection markdown for one release (starts with `## …`)
 * @returns {string}
 */
export function insertChangelogSection(existingChangelogMarkdown, newSection) {
  const section = newSection.replace(/^\s+/, '').replace(/\s*$/, '\n');

  if (!existingChangelogMarkdown.includes('# Changelog')) {
    return `# Changelog\n\n${section}\n${existingChangelogMarkdown}`.replace(
      /\n{3,}/g,
      '\n\n',
    );
  }

  const lines = existingChangelogMarkdown.split(/\r?\n/);
  let firstRelease = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      firstRelease = i;
      break;
    }
  }
  if (firstRelease === -1) firstRelease = lines.length;

  const headerLines = lines.slice(0, firstRelease);
  while (
    headerLines.length > 1 &&
    headerLines[headerLines.length - 1].trim() === ''
  ) {
    headerLines.pop();
  }
  const header = headerLines.join('\n').replace(/\s*$/, '') + '\n\n';
  const rest = lines.slice(firstRelease).join('\n').replace(/^\s*/, '');
  let next = rest ? `${header}${section}\n${rest}` : `${header}${section}`;
  next = next.replace(/\n{3,}/g, '\n\n');
  if (!next.endsWith('\n')) next += '\n';
  return next;
}

/**
 * Extract the markdown body for a given version heading from CHANGELOG.md.
 * Matches headings like `## 0.1.1` or `## v0.1.1`.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractChangelogSection(changelogMarkdown, version) {
  const bare = version.replace(/^v/, '');
  const lines = changelogMarkdown.split(/\r?\n/);
  const headingRe = new RegExp(`^##\\s+v?${escapeRegExp(bare)}(?:\\s|\\(|$)`);
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

const DISCORD_MESSAGE_LIMIT = 2000;

function truncateDiscordText(value, limit) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function removePatchChangesSection(markdown) {
  const lines = markdown.split('\n');
  const kept = [];
  let skipping = false;

  for (const line of lines) {
    if (/^###\s+Patch changes\s*$/i.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^#{1,3}\s+/.test(line)) {
      skipping = false;
    }
    if (!skipping) kept.push(line);
  }

  return kept.join('\n').trim();
}

/**
 * Build the Discord webhook payload for a published GitHub Release.
 *
 * @param {{
 *   name?: string | null,
 *   body?: string | null,
 *   url: string,
 *   publishedAt?: string | null,
 *   tagName: string
 * }} release
 */
export function buildDiscordReleasePayload(release) {
  if (!release || typeof release !== 'object') {
    throw new TypeError('GitHub Release data is required');
  }

  const tagName =
    typeof release.tagName === 'string' ? release.tagName.trim() : '';
  const url = typeof release.url === 'string' ? release.url.trim() : '';
  if (!tagName || !url) {
    throw new TypeError('GitHub Release tagName and url are required');
  }

  const version = tagName.replace(/^v/i, '');
  const versionTag = `v${version}`;
  const prefix = `@everyone\n\n# Roomote ${version} is out!`;
  const suffix = `See the full release notes [${versionTag}](${url}). Let us know what you think!`;
  const body =
    typeof release.body === 'string'
      ? removePatchChangesSection(release.body)
      : '';
  const bodyLimit = DISCORD_MESSAGE_LIMIT - prefix.length - suffix.length - 4;
  const announcementBody = truncateDiscordText(body, bodyLimit);
  const content = announcementBody
    ? `${prefix}\n\n${announcementBody}\n\n${suffix}`
    : `${prefix}\n\n${suffix}`;

  return {
    username: 'Roomote Releases',
    content,
    allowed_mentions: { parse: ['everyone'] },
  };
}

/**
 * Find the commit that introduced the given product version on a ref.
 *
 * Walks commits that touched the root package.json from the tip of `ref`
 * backwards, and returns the oldest contiguous commit whose version equals
 * `version` — i.e. the release PR merge commit that bumped to it. Returns
 * null when the tip of `ref` is not on `version` (the version is stale) or
 * the version never appears.
 *
 * Versions only change in commits that touch package.json, so the oldest
 * contiguous match from the tip is exactly the commit that introduced it.
 *
 * @param {{ cwd: string, version: string, ref?: string }} options
 * @returns {string | null} full commit SHA or null
 */
export function findVersionCommit({ cwd, version, ref = 'HEAD' }) {
  const git = (args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  const shas = git(['rev-list', ref, '--', 'package.json'])
    .split('\n')
    .filter(Boolean);

  let candidate = null;
  for (const sha of shas) {
    let commitVersion = null;
    try {
      commitVersion = JSON.parse(git(['show', `${sha}:package.json`])).version;
    } catch {
      break;
    }
    if (commitVersion !== version) break;
    candidate = sha;
  }
  return candidate;
}

const CHANGELOG_HEADER =
  '# Changelog\n\nThis file tracks product releases for Roomote (single monorepo version). Automated release entries are prepended by `pnpm run version`.\n\n';

/**
 * Build one product CHANGELOG.md release section from pending changesets,
 * grouped by the highest bump level each changeset requests.
 *
 * @param {ReturnType<typeof parsePendingChangesets>} pending
 * @param {string} nextVersion
 * @param {string} date ISO date (YYYY-MM-DD)
 * @returns {string} markdown section starting with `## <version> (<date>)`
 */
export function buildChangelogSection(pending, nextVersion, date) {
  const byLevel = { major: [], minor: [], patch: [] };
  for (const entry of pending) {
    const highest = ['major', 'minor', 'patch'].find((level) =>
      Object.values(entry.bumps).includes(level),
    );
    if (!highest) continue;
    const summary = entry.summary.replace(/\s+/g, ' ').trim() || entry.file;
    byLevel[highest].push(summary);
  }

  const highlightSource =
    byLevel.major[0] || byLevel.minor[0] || byLevel.patch[0] || null;
  const releaseSummary = highlightSource
    ? highlightSource
    : '<one-sentence release summary — REPLACE ME>';
  const highlights = (
    highlightSource
      ? [highlightSource, ...byLevel.major.slice(1), ...byLevel.minor.slice(1)]
      : ['<highlight — REPLACE ME>']
  ).slice(0, 4);

  const lines = [
    `## ${nextVersion} (${date})`,
    '',
    releaseSummary,
    '',
    '### Highlights',
    '',
  ];
  for (const item of highlights) {
    lines.push(`- ${item}`);
  }
  lines.push('');

  for (const [label, key] of [
    ['Major changes', 'major'],
    ['Minor changes', 'minor'],
    ['Patch changes', 'patch'],
  ]) {
    if (byLevel[key].length === 0) continue;
    lines.push(`### ${label}`, '');
    for (const item of byLevel[key]) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Apply the pending changesets as one product version bump: prepend the
 * release section to the root CHANGELOG.md, set the root package.json
 * version, and delete the consumed changeset files. Workspace package
 * versions are intentionally left untouched; the root version is the only
 * product version.
 *
 * @param {string} repoRoot
 * @param {{ date?: string }} [options]
 * @returns {{ previous: string, next: string, changesets: string[] } | null}
 *   null when there is nothing to version
 */
export function applyProductVersion(repoRoot, options = {}) {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const pending = parsePendingChangesets(repoRoot);
  if (pending.length === 0) return null;

  const rootPath = join(repoRoot, 'package.json');
  const root = readJson(rootPath);
  const previous = readCurrentProductVersion(repoRoot);
  const levels = pending.flatMap((entry) => Object.values(entry.bumps));
  const next = computeNextVersion(previous, levels);

  const changelogPath = join(repoRoot, 'CHANGELOG.md');
  const existing = existsSync(changelogPath)
    ? readFileSync(changelogPath, 'utf8')
    : CHANGELOG_HEADER;
  writeFileSync(
    changelogPath,
    insertChangelogSection(
      existing,
      buildChangelogSection(pending, next, date),
    ),
  );

  root.version = next;
  writeFileSync(rootPath, `${JSON.stringify(root, null, 2)}\n`);

  for (const entry of pending) {
    rmSync(join(repoRoot, '.changeset', entry.file));
  }

  return { previous, next, changesets: pending.map((entry) => entry.file) };
}
