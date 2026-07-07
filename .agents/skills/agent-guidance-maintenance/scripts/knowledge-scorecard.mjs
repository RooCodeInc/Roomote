import fs from 'node:fs/promises';
import path from 'node:path';
import {
  LOCAL_KNOWLEDGE_SCRIPT_PATHS,
  SURFACE_MAP_PATH,
  analyzeKnowledgeScriptCompliance,
  analyzeSurfaceMapCoverage,
  daysSince,
  extractMarkdownLinks,
  getMarkdownFilesInGuidanceRoots,
  isGeneratedQualityReport,
  isValidDate,
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
const ciMode = process.argv.includes('--ci');
const CORE_REQUIRED_PATHS = [
  'AGENTS.md',
  '.agent-guidance/README.md',
  '.agent-guidance/architecture/README.md',
  SURFACE_MAP_PATH,
  '.agent-guidance/features/README.md',
  '.agent-guidance/api/README.md',
  '.agent-guidance/operations/README.md',
  '.agent-guidance/references/README.md',
  '.agent-guidance/generated/README.md',
  '.agent-guidance/quality/README.md',
  '.agents/skills/agent-guidance-maintenance/SKILL.md',
  '.agents/skills/agent-guidance-maintenance/agents/openai.yaml',
  ...LOCAL_KNOWLEDGE_SCRIPT_PATHS,
];
const STARTER_PLACEHOLDER_SNIPPETS = [
  {
    path: 'AGENTS.md',
    snippets: [
      'Replace this paragraph with a short repository overview that explains:',
      '- Document install/bootstrap steps, required toolchains, local services, and environment prerequisites here.',
      '- Document the main local runtime commands here, plus any useful log or status commands.',
      '- Document build, package, or release commands here if the repository has them.',
    ],
  },
  {
    path: '.agent-guidance/README.md',
    snippets: [
      'Replace this section with a short repository-specific summary that answers:',
    ],
  },
  {
    path: '.agent-guidance/architecture/README.md',
    snippets: [
      'Add concrete architecture docs here with short descriptions so readers can scan the section quickly. If the repository has multiple durable architecture surfaces, do not stop at this index alone.',
    ],
  },
  {
    path: SURFACE_MAP_PATH,
    snippets: [
      'Replace the placeholder inventory below with the real major surfaces in this repository. Do not leave this file as starter text.',
      '`REPLACE_ME`',
    ],
  },
  {
    path: '.agent-guidance/features/README.md',
    snippets: [
      'Add concrete feature docs here with short descriptions so readers can scan the section quickly. If the repository has multiple durable feature surfaces, do not stop at this index alone.',
    ],
  },
  {
    path: '.agent-guidance/api/README.md',
    snippets: [
      'Add concrete API docs here with short descriptions so readers can scan the section quickly. If the repository has multiple durable API surfaces, do not stop at this index alone.',
    ],
  },
  {
    path: '.agent-guidance/operations/README.md',
    snippets: [
      'Add concrete operations docs here with short descriptions so readers can scan the section quickly. If the repository has multiple durable runbook surfaces, do not stop at this index alone.',
    ],
  },
];

function isValidGuidanceFrontmatter(parsed) {
  if (!parsed.hasFrontmatter) {
    return false;
  }

  const fm = parsed.frontmatter;
  const required = ['title', 'status', 'last_reviewed', 'owner', 'summary'];
  if (!required.every((field) => Boolean(fm[field]))) {
    return false;
  }

  const allowedStatuses = new Set(['draft', 'active', 'stable', 'deprecated']);
  if (!allowedStatuses.has(fm.status)) {
    return false;
  }

  return isValidDate(fm.last_reviewed);
}

const guidanceFiles = await getMarkdownFilesInGuidanceRoots(rootDir);
const scorableGuidance = guidanceFiles
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

let validFrontmatterCount = 0;
let freshGuidanceCount = 0;
let agentsNonEmptyLineCount = null;
const fullAgentsMapScoreMaxLines = 140;
const partialAgentsMapScoreMaxLines = 180;

for (const { filePath, relativePath } of scorableGuidance) {
  const content = await fs.readFile(filePath, 'utf8');
  const parsed = parseFrontmatter(content);

  const valid = isValidGuidanceFrontmatter(parsed);
  if (valid) {
    validFrontmatterCount += 1;
  }

  const lastReviewed = parsed.frontmatter.last_reviewed;
  if (
    lastReviewed &&
    isValidDate(lastReviewed) &&
    daysSince(lastReviewed, today) <= staleThresholdDays
  ) {
    freshGuidanceCount += 1;
  }
}

const frontmatterRatio =
  scorableGuidance.length === 0
    ? 1
    : validFrontmatterCount / scorableGuidance.length;
const freshnessRatio =
  scorableGuidance.length === 0
    ? 1
    : freshGuidanceCount / scorableGuidance.length;

const linkFiles = [...guidanceFiles, path.join(rootDir, 'AGENTS.md')];
let totalLinks = 0;
let validLinks = 0;

for (const filePath of linkFiles) {
  if (!(await pathExists(filePath))) {
    continue;
  }

  const content = await fs.readFile(filePath, 'utf8');
  const links = extractMarkdownLinks(content);

  for (const link of links) {
    if (shouldIgnoreLink(link)) {
      continue;
    }

    totalLinks += 1;
    const resolved = resolveLinkTarget(filePath, link, rootDir);
    if (resolved && (await pathExists(resolved))) {
      validLinks += 1;
    }
  }
}

const linkIntegrityRatio = totalLinks === 0 ? 1 : validLinks / totalLinks;

const harnessChecks = [];

for (const relativePath of CORE_REQUIRED_PATHS) {
  harnessChecks.push(await pathExists(path.join(rootDir, relativePath)));
}

const knowledgeScriptCompliance =
  await analyzeKnowledgeScriptCompliance(rootDir);
harnessChecks.push(...knowledgeScriptCompliance.checks);

const agentsPath = path.join(rootDir, 'AGENTS.md');
if (await pathExists(agentsPath)) {
  const agentsContent = await fs.readFile(agentsPath, 'utf8');
  agentsNonEmptyLineCount = agentsContent
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0).length;
}

const placeholderFindings = [];
for (const entry of STARTER_PLACEHOLDER_SNIPPETS) {
  const absolutePath = path.join(rootDir, entry.path);
  if (!(await pathExists(absolutePath))) {
    continue;
  }

  const content = await fs.readFile(absolutePath, 'utf8');
  for (const snippet of entry.snippets) {
    if (content.includes(snippet)) {
      placeholderFindings.push({ path: entry.path, snippet });
    }
  }
}

const { checks: surfaceCoverageChecks, errors: surfaceCoverageErrors } =
  await analyzeSurfaceMapCoverage(rootDir);
const surfaceCoveragePass =
  surfaceCoverageChecks.length === 0
    ? 1
    : surfaceCoverageChecks.filter(Boolean).length /
      surfaceCoverageChecks.length;
const agentsMapSizeRatio =
  agentsNonEmptyLineCount === null
    ? 0
    : agentsNonEmptyLineCount <= fullAgentsMapScoreMaxLines
      ? 1
      : agentsNonEmptyLineCount <= partialAgentsMapScoreMaxLines
        ? 0.5
        : 0;

const componentScores = [
  { label: 'Frontmatter', value: frontmatterRatio, weight: 0.18 },
  { label: 'Freshness', value: freshnessRatio, weight: 0.14 },
  { label: 'Link integrity', value: linkIntegrityRatio, weight: 0.14 },
  {
    label: 'Required guidance surface',
    value:
      harnessChecks.length === 0
        ? 1
        : harnessChecks.filter(Boolean).length / harnessChecks.length,
    weight: 0.18,
  },
  { label: 'Surface coverage', value: surfaceCoveragePass, weight: 0.18 },
  { label: 'AGENTS map size', value: agentsMapSizeRatio, weight: 0.08 },
  {
    label: 'Starter placeholder cleanup',
    value: placeholderFindings.length === 0 ? 1 : 0,
    weight: 0.1,
  },
];

const totalScore = Math.round(
  componentScores.reduce(
    (sum, item) => sum + item.value * item.weight * 100,
    0,
  ),
);

const reportPath = path.join(
  rootDir,
  '.agent-guidance/quality/latest-scorecard.md',
);
const report = `---
title: Latest Knowledge Scorecard
status: active
last_reviewed: ${todayIso}
owner: automation
summary: Generated weighted internal agent-guidance quality scorecard.
---

# Knowledge Scorecard

Generated on: ${todayIso}

## Total Score

- ${totalScore}/100

## Component Scores

${componentScores.map((item) => `- ${item.label}: ${Math.round(item.value * 100)}%`).join('\n')}

## Findings

### Surface Coverage

${surfaceCoverageErrors.length === 0 ? 'None.' : surfaceCoverageErrors.map((item) => `- ${item}`).join('\n')}

### Placeholder Cleanup

${placeholderFindings.length === 0 ? 'None.' : placeholderFindings.map((item) => `- ${item.path}: ${item.snippet}`).join('\n')}

### AGENTS Size

${agentsNonEmptyLineCount === null ? 'AGENTS.md missing.' : `- Non-empty lines: ${agentsNonEmptyLineCount}\n- Full score at <= ${fullAgentsMapScoreMaxLines} non-empty lines; partial score through ${partialAgentsMapScoreMaxLines}. Keep AGENTS.md map-like and move depth into .agent-guidance/ when it grows beyond that range.`}
`;

await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, report, 'utf8');

console.log(
  `Knowledge scorecard written to ${toRepoRelative(rootDir, reportPath)}.`,
);
console.log(`Total score: ${totalScore}/100`);

if (ciMode && totalScore < 85) {
  process.exit(1);
}
