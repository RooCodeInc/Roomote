import fs from 'node:fs/promises';
import path from 'node:path';
import {
  daysSince,
  extractMarkdownLinks,
  getMarkdownFilesInGuidanceRoots,
  isGeneratedQualityReport,
  parseFrontmatter,
  pathExists,
  resolveLinkTarget,
  shouldIgnoreLink,
  toRepoRelative,
} from './knowledge-lib.mjs';

const rootDir = process.cwd();
const today = new Date();
const todayIso = today.toISOString().slice(0, 10);
const staleThresholdDays = 45;

const guidanceFiles = await getMarkdownFilesInGuidanceRoots(rootDir);
const indexFiles = new Set(
  guidanceFiles.filter((filePath) => {
    const relativePath = toRepoRelative(rootDir, filePath);
    return (
      relativePath === '.agent-guidance/README.md' ||
      relativePath.endsWith('/README.md')
    );
  }),
);

const metadataTargets = guidanceFiles
  .map((filePath) => ({
    filePath,
    relativePath: toRepoRelative(rootDir, filePath),
  }))
  .filter(
    ({ relativePath }) =>
      relativePath !== '.agent-guidance/README.md' &&
      !relativePath.startsWith('.agent-guidance/execution-plans/') &&
      !isGeneratedQualityReport(relativePath),
  );

const staleGuidancePages = [];
const missingReviewDate = [];
const deprecatedMissingReplacement = [];

for (const { filePath, relativePath } of metadataTargets) {
  const content = await fs.readFile(filePath, 'utf8');
  const { hasFrontmatter, frontmatter, body } = parseFrontmatter(content);

  if (!hasFrontmatter || !frontmatter.last_reviewed) {
    missingReviewDate.push(relativePath);
  } else {
    const age = daysSince(frontmatter.last_reviewed, today);
    if (age > staleThresholdDays) {
      staleGuidancePages.push({
        relativePath,
        age,
        lastReviewed: frontmatter.last_reviewed,
      });
    }
  }

  if (frontmatter.status === 'deprecated') {
    const hasReplacement = /Replacement:\s*\[[^\]]+\]\([^)]+\)/i.test(body);
    if (!hasReplacement) {
      deprecatedMissingReplacement.push(relativePath);
    }
  }
}

const linkedFromIndexes = new Set();
for (const indexPath of indexFiles) {
  const content = await fs.readFile(indexPath, 'utf8');
  const links = extractMarkdownLinks(content);

  for (const link of links) {
    if (shouldIgnoreLink(link)) {
      continue;
    }

    const resolved = resolveLinkTarget(indexPath, link, rootDir);
    if (!resolved) {
      continue;
    }

    if (!(await pathExists(resolved))) {
      continue;
    }

    const relativeResolved = toRepoRelative(rootDir, resolved);
    if (
      relativeResolved.startsWith('.agent-guidance/') &&
      relativeResolved.endsWith('.md')
    ) {
      linkedFromIndexes.add(relativeResolved);
    }
  }
}

const orphanGuidancePages = metadataTargets
  .map(({ relativePath }) => relativePath)
  .filter((relativePath) => !relativePath.endsWith('/README.md'))
  .filter((relativePath) => !linkedFromIndexes.has(relativePath))
  .sort();

const reportPath = path.join(
  rootDir,
  '.agent-guidance/quality/latest-garden-report.md',
);
const report = `---
title: Latest Knowledge Garden Report
status: active
last_reviewed: ${todayIso}
owner: automation
summary: Generated stale/orphan/deprecation hygiene report for internal agent guidance.
---

# Knowledge Garden Report

Generated on: ${todayIso}

## Summary

- Stale guidance pages (> ${staleThresholdDays} days): ${staleGuidancePages.length}
- Guidance pages missing review metadata: ${missingReviewDate.length}
- Orphan guidance pages (not linked from guidance indexes): ${orphanGuidancePages.length}
- Deprecated guidance pages missing replacement link: ${deprecatedMissingReplacement.length}

## Stale Guidance Pages

${staleGuidancePages.length === 0 ? 'None.' : staleGuidancePages.map((item) => `- ${item.relativePath} (last reviewed ${item.lastReviewed}, ${item.age} days ago)`).join('\n')}

## Missing Review Metadata

${missingReviewDate.length === 0 ? 'None.' : missingReviewDate.map((item) => `- ${item}`).join('\n')}

## Orphan Guidance Pages

${orphanGuidancePages.length === 0 ? 'None.' : orphanGuidancePages.map((item) => `- ${item}`).join('\n')}

## Deprecated Guidance Pages Missing Replacement Link

${deprecatedMissingReplacement.length === 0 ? 'None.' : deprecatedMissingReplacement.map((item) => `- ${item}`).join('\n')}
`;

await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, report, 'utf8');

console.log(
  `Knowledge garden report written to ${toRepoRelative(rootDir, reportPath)}.`,
);
