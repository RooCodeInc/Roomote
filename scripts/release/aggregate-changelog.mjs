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
  insertChangelogSection,
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
  : '# Changelog\n\nThis file tracks product releases for Roomote (single monorepo version). Automated release entries are prepended by `pnpm run version`.\n\n';

const nextContent = insertChangelogSection(existing, newSection);
writeFileSync(changelogPath, nextContent);
console.log(`Prepended CHANGELOG section for ${next}`);
