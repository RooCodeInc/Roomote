import fs from 'node:fs/promises';
import path from 'node:path';
import {
  LOCAL_KNOWLEDGE_SCRIPT_PATHS,
  SURFACE_MAP_PATH,
  analyzeKnowledgeScriptCompliance,
  analyzeSurfaceMapCoverage,
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
const errors = [];

const REQUIRED_PATHS = [
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

const REQUIRED_AGENT_SECTIONS = [
  'Setup',
  'Run',
  'Build',
  'Validation',
  'Knowledge Map',
  'Working With This Guidance',
];

const REQUIRED_AGENT_LINKS = [
  '.agent-guidance/README.md',
  '.agent-guidance/architecture/README.md',
  '.agent-guidance/architecture/repository-surface-map.md',
  '.agent-guidance/features/README.md',
  '.agent-guidance/api/README.md',
  '.agent-guidance/operations/README.md',
  '.agent-guidance/references/README.md',
  '.agent-guidance/generated/README.md',
  '.agent-guidance/quality/README.md',
  '.agents/skills/agent-guidance-maintenance/SKILL.md',
];

const GENERAL_GUIDANCE_STATUSES = new Set([
  'draft',
  'active',
  'stable',
  'deprecated',
]);
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

function addError(message) {
  errors.push(message);
}

function validateGuidancePageFrontmatter(
  relativePath,
  frontmatter,
  hasFrontmatter,
) {
  if (!hasFrontmatter) {
    addError(`${relativePath}: missing required frontmatter block.`);
    return;
  }

  const requiredFields = [
    'title',
    'status',
    'last_reviewed',
    'owner',
    'summary',
  ];
  for (const field of requiredFields) {
    if (!frontmatter[field]) {
      addError(`${relativePath}: missing frontmatter field '${field}'.`);
    }
  }

  if (
    frontmatter.status &&
    !GENERAL_GUIDANCE_STATUSES.has(frontmatter.status)
  ) {
    addError(`${relativePath}: invalid status '${frontmatter.status}'.`);
  }

  if (frontmatter.last_reviewed && !isValidDate(frontmatter.last_reviewed)) {
    addError(
      `${relativePath}: invalid last_reviewed '${frontmatter.last_reviewed}' (expected YYYY-MM-DD).`,
    );
  }
}

async function validateRequiredPaths() {
  for (const requiredPath of REQUIRED_PATHS) {
    if (!(await pathExists(path.join(rootDir, requiredPath)))) {
      addError(`missing required path: ${requiredPath}`);
    }
  }
}

async function validateAgentsFile() {
  const agentsPath = path.join(rootDir, 'AGENTS.md');
  if (!(await pathExists(agentsPath))) {
    addError('AGENTS.md: file is missing.');
    return;
  }

  const content = await fs.readFile(agentsPath, 'utf8');

  for (const section of REQUIRED_AGENT_SECTIONS) {
    const pattern = new RegExp(
      `^##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      'm',
    );
    if (!pattern.test(content)) {
      addError(`AGENTS.md: missing required section '## ${section}'.`);
    }
  }

  for (const linkPath of REQUIRED_AGENT_LINKS) {
    if (!content.includes(linkPath)) {
      addError(`AGENTS.md: missing required link reference '${linkPath}'.`);
    }
  }
}

async function validateGuidanceFrontmatter() {
  const guidanceFiles = await getMarkdownFilesInGuidanceRoots(rootDir);

  for (const filePath of guidanceFiles) {
    const relativePath = toRepoRelative(rootDir, filePath);

    if (
      relativePath === '.agent-guidance/README.md' ||
      relativePath.startsWith('.agent-guidance/execution-plans/')
    ) {
      continue;
    }

    const content = await fs.readFile(filePath, 'utf8');
    const parsed = parseFrontmatter(content);

    validateGuidancePageFrontmatter(
      relativePath,
      parsed.frontmatter,
      parsed.hasFrontmatter,
    );
  }
}

async function validateLinks() {
  const markdownCandidates = [
    ...(await getMarkdownFilesInGuidanceRoots(rootDir)),
    path.join(rootDir, 'AGENTS.md'),
  ];
  const markdownFiles = [];

  for (const filePath of markdownCandidates) {
    if (await pathExists(filePath)) {
      markdownFiles.push(filePath);
    }
  }

  for (const filePath of markdownFiles) {
    if (!(await pathExists(filePath))) {
      continue;
    }

    const content = await fs.readFile(filePath, 'utf8');
    const links = extractMarkdownLinks(content);

    for (const link of links) {
      if (shouldIgnoreLink(link)) {
        continue;
      }

      const resolved = resolveLinkTarget(filePath, link, rootDir);
      if (!resolved || !(await pathExists(resolved))) {
        addError(
          `${toRepoRelative(rootDir, filePath)}: broken link '${link}'.`,
        );
      }
    }
  }
}

async function validateStarterPlaceholders() {
  for (const entry of STARTER_PLACEHOLDER_SNIPPETS) {
    const absolutePath = path.join(rootDir, entry.path);
    if (!(await pathExists(absolutePath))) {
      continue;
    }

    const content = await fs.readFile(absolutePath, 'utf8');
    for (const snippet of entry.snippets) {
      if (content.includes(snippet)) {
        addError(
          `${entry.path}: still contains starter placeholder text '${snippet}'.`,
        );
      }
    }
  }
}

async function validateSurfaceCoverage() {
  const { errors: surfaceErrors } = await analyzeSurfaceMapCoverage(rootDir);
  for (const error of surfaceErrors) {
    addError(error);
  }
}

async function validateKnowledgeScripts() {
  const { errors: scriptErrors } =
    await analyzeKnowledgeScriptCompliance(rootDir);
  for (const error of scriptErrors) {
    addError(error);
  }
}

await validateRequiredPaths();
await validateAgentsFile();
await validateGuidanceFrontmatter();
await validateLinks();
await validateStarterPlaceholders();
await validateSurfaceCoverage();
await validateKnowledgeScripts();

if (errors.length > 0) {
  console.error('knowledge-check: FAILED');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('knowledge-check: OK');
