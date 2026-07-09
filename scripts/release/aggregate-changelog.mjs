#!/usr/bin/env node
/**
 * Prepend a product CHANGELOG.md section from pending Changesets, then leave
 * those changeset files for `changeset version` to consume.
 *
 * Runs before `changeset version` as part of `pnpm run version`.
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeNextVersion,
  parsePendingChangesets,
  readCurrentProductVersion,
} from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');

const pending = parsePendingChangesets(repoRoot);
if (pending.length === 0) {
  console.log('No pending changesets; skipping CHANGELOG aggregation.');
  process.exit(0);
}

const current = readCurrentProductVersion(repoRoot);
const levels = pending.flatMap((entry) => Object.values(entry.bumps));
const next = computeNextVersion(current, levels);

const byLevel = { major: [], minor: [], patch: [] };
for (const entry of pending) {
  const levelOrder = ['major', 'minor', 'patch'];
  const highest = levelOrder.find((l) =>
    Object.values(entry.bumps).includes(l),
  );
  if (!highest) continue;
  const summary = entry.summary.replace(/\s+/g, ' ').trim() || entry.file;
  byLevel[highest].push(summary);
}

const date = new Date().toISOString().slice(0, 10);
const sections = [];
sections.push(`## ${next} (${date})`);
sections.push('');

for (const [label, key] of [
  ['Major changes', 'major'],
  ['Minor changes', 'minor'],
  ['Patch changes', 'patch'],
]) {
  if (byLevel[key].length === 0) continue;
  sections.push(`### ${label}`);
  sections.push('');
  for (const item of byLevel[key]) {
    sections.push(`- ${item}`);
  }
  sections.push('');
}

const newSection = sections.join('\n').trimEnd() + '\n';
const changelogPath = join(repoRoot, 'CHANGELOG.md');
const existing = existsSync(changelogPath)
  ? readFileSync(changelogPath, 'utf8')
  : '# Changelog\n\nThis file tracks product releases for Roomote (single monorepo version).\n\n';

let nextContent;
if (existing.includes('# Changelog')) {
  // Insert after the first heading block (title + optional intro paragraphs)
  const lines = existing.split(/\r?\n/);
  let insertAt = 1;
  // Skip blank lines and intro paragraph lines until the first ## release heading or EOF
  while (insertAt < lines.length && !/^##\s+/.test(lines[insertAt])) {
    insertAt++;
  }
  // Prefer to leave the intro; insert just before first ## or at end of intro
  // Recompute: after title line, keep following non-heading lines as intro, then insert.
  insertAt = 1;
  while (
    insertAt < lines.length &&
    lines[insertAt].trim() !== '' &&
    !/^##\s+/.test(lines[insertAt])
  ) {
    insertAt++;
  }
  while (insertAt < lines.length && lines[insertAt].trim() === '') {
    insertAt++;
  }
  const before = lines.slice(0, insertAt).join('\n').replace(/\s*$/, '\n\n');
  const after = lines.slice(insertAt).join('\n').replace(/^\s*/, '');
  nextContent = `${before}${newSection}\n${after}`.replace(/\n{3,}/g, '\n\n');
  if (!nextContent.endsWith('\n')) nextContent += '\n';
} else {
  nextContent = `# Changelog\n\n${newSection}\n${existing}`;
}

writeFileSync(changelogPath, nextContent);
console.log(`Prepended CHANGELOG section for ${next}`);
