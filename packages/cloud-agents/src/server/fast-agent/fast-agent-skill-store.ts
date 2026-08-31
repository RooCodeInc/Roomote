import { constants, existsSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { FAST_AGENT_SPILL_MAX_FILE_BYTES } from './fast-agent-spill-store';
import { shouldUseCheckoutSkillRoots } from './fast-agent-runtime-context';

export const FAST_AGENT_PACKAGED_SKILL_NAMES = [
  'address-pr-feedback',
  'agent-browser',
  'capture-visual-proof',
  'ci-failure-triage',
  'code-quality-auditor',
  'codeql-triage',
  'create-draft-pr',
  'create-pr',
  'debug-reported-bug',
  'dependabot-triage',
  'doctor',
  'environment-setup',
  'explain-repo-code',
  'explore-and-act',
  'feature-demo',
  'fix-pr',
  'fix-sentry-error',
  'github-management',
  'implement-changes',
  'implement-repo-change',
  'issue-fixer',
  'plan-repo-implementation',
  'push',
  'refactor-code',
  'resolve-github-pr-merge-conflicts',
  'review-and-fix',
  'review-code',
  'security-auditor',
  'security-best-practices',
  'security-review',
  'sentry-triage',
  'simplify',
  'triage-better-stack',
  'triage-sentry',
  'update-dependencies',
  'zero',
] as const;

type FastAgentPackagedSkillName =
  (typeof FAST_AGENT_PACKAGED_SKILL_NAMES)[number];

export type FastAgentSkillSummary = {
  description: string;
  environmentIds?: string[];
  id: string;
  invocation?: string;
  name: string;
  repository?: string;
  settingsSource?: string;
  source: 'packaged' | 'repository' | 'settings';
};

export type FastAgentSkillDocument = FastAgentSkillSummary & {
  byteLength: number;
  content: string;
  resource: string;
  resources: string[];
};

export type FastAgentSkillListResult = {
  skills: FastAgentSkillSummary[];
  warnings: string[];
};

type FastAgentSkillCatalog = FastAgentSkillListResult & {
  counts: {
    packaged: number;
    repository: number;
    settings: number;
    total: number;
  };
};

export type FastAgentSkillQuery = {
  environmentId?: string;
  name?: string;
  repositoryId?: string;
};

export type FastAgentSkillScope =
  | { environmentId: string; repositoryId?: never }
  | { environmentId?: never; repositoryId: string };

export type FastAgentRepositorySkillSource = {
  list(scope: FastAgentSkillScope): Promise<FastAgentSkillListResult>;
  read(id: string, resource?: string): Promise<FastAgentSkillDocument>;
  dispose?(): Promise<void>;
};

export type FastAgentSettingsSkillSource = {
  list(query: FastAgentSkillQuery): Promise<FastAgentSkillListResult>;
  read(id: string, resource?: string): Promise<FastAgentSkillDocument>;
  dispose?(): Promise<void>;
};

const FAST_AGENT_PACKAGED_SKILL_NAME_SET = new Set<string>(
  FAST_AGENT_PACKAGED_SKILL_NAMES,
);
async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function getDefaultSkillRootCandidates(
  moduleUrl = import.meta.url,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates = [
    // Unbundled package source (tests and direct TypeScript execution).
    resolve(dirname(fileURLToPath(moduleUrl)), '../workflows/skills/standard'),
  ];
  const checkoutCandidates = [
    resolve(cwd, 'packages/cloud-agents/src/server/workflows/skills/standard'),
    resolve(
      cwd,
      '../../packages/cloud-agents/src/server/workflows/skills/standard',
    ),
  ];

  if (
    shouldUseCheckoutSkillRoots(env, () =>
      checkoutCandidates.some((candidate) => existsSync(candidate)),
    )
  ) {
    // A Roomote checkout started inside another Roomote task runs bundled
    // services from apps/<service>, while ordinary local development needs
    // the same checkout path. Production keeps the original candidates.
    candidates.push(...checkoutCandidates);
  }

  // Existing runtime-app image layout: /roomote/apps/<service> ->
  // /roomote/skills/standard.
  candidates.push(resolve(cwd, '../../skills/standard'));
  return candidates;
}

export async function resolveDefaultSkillRoot(
  moduleUrl = import.meta.url,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  for (const candidate of getDefaultSkillRootCandidates(moduleUrl, cwd, env)) {
    if (await directoryExists(candidate)) return candidate;
  }
  throw new Error('Packaged Fast skills are unavailable in this runtime.');
}

async function listMarkdownResources(
  directory: string,
  rootDirectory: string,
): Promise<string[]> {
  const resources: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      resources.push(...(await listMarkdownResources(path, rootDirectory)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      resources.push(relative(rootDirectory, path).split(sep).join('/'));
    }
  }
  return resources;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function getFastAgentSkillDescription(content: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
    content,
  )?.[1];
  if (!frontmatter) return '';
  const lines = frontmatter.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^description:\s*(.*)$/u.exec(lines[index] ?? '');
    if (!match) continue;
    const value = match[1]?.trim() ?? '';
    if (value === '>' || value === '|') {
      const folded: string[] = [];
      for (let nested = index + 1; nested < lines.length; nested += 1) {
        const line = lines[nested] ?? '';
        if (!/^\s+/u.test(line)) break;
        folded.push(line.trim());
      }
      return folded.join(value === '>' ? ' ' : '\n').trim();
    }
    return unquoteYamlScalar(value);
  }
  return '';
}

function packagedSkillId(name: string): string {
  return `packaged:${name}`;
}

export class FastAgentSkillStore {
  private readonly resources = new Map<string, Promise<string[]>>();
  private readonly rootDirectory: Promise<string>;

  constructor(
    rootDirectory?: string,
    private readonly repositorySkills?: FastAgentRepositorySkillSource,
    private readonly settingsSkills?: FastAgentSettingsSkillSource,
  ) {
    this.rootDirectory = rootDirectory
      ? Promise.resolve(resolve(rootDirectory))
      : resolveDefaultSkillRoot();
  }

  async list(query: FastAgentSkillQuery = {}): Promise<FastAgentSkillCatalog> {
    const packaged = await Promise.all(
      FAST_AGENT_PACKAGED_SKILL_NAMES.map(async (name) => {
        const document = await this.readPackaged(name);
        return {
          description: getFastAgentSkillDescription(document.content),
          id: document.id,
          invocation: name,
          name,
          source: 'packaged' as const,
        };
      }),
    );
    const scope = query.environmentId
      ? ({ environmentId: query.environmentId } as const)
      : query.repositoryId
        ? ({ repositoryId: query.repositoryId } as const)
        : undefined;
    const packagedNames = new Set<string>(packaged.map((skill) => skill.name));
    const packagedMatchIsAuthoritative =
      !!query.name && packagedNames.has(query.name);
    const settings =
      !packagedMatchIsAuthoritative &&
      (scope || query.name) &&
      this.settingsSkills
        ? await this.settingsSkills.list(query)
        : { skills: [], warnings: [] };
    const repository =
      !packagedMatchIsAuthoritative && scope && this.repositorySkills
        ? await this.repositorySkills.list(scope)
        : { skills: [], warnings: [] };
    const filteredPackaged = query.name
      ? packaged.filter((skill) => skill.name === query.name)
      : packaged;
    const filteredSettings = settings.skills.filter(
      (skill) =>
        (!query.name || skill.name === query.name) &&
        !packagedNames.has(skill.name),
    );
    const settingsNames = new Set<string>(
      filteredSettings.map((skill) => skill.name),
    );
    const filteredRepository = repository.skills.filter(
      (skill) =>
        (!query.name || skill.name === query.name) &&
        !packagedNames.has(skill.name) &&
        !settingsNames.has(skill.name),
    );
    return {
      counts: {
        packaged: filteredPackaged.length,
        repository: filteredRepository.length,
        settings: filteredSettings.length,
        total:
          filteredPackaged.length +
          filteredSettings.length +
          filteredRepository.length,
      },
      skills: [
        ...filteredPackaged,
        ...filteredSettings,
        ...filteredRepository,
      ].sort((left, right) =>
        left.name === right.name
          ? left.id.localeCompare(right.id)
          : left.name.localeCompare(right.name),
      ),
      warnings: [...settings.warnings, ...repository.warnings],
    };
  }

  async read(
    id: string,
    requestedResource = 'SKILL.md',
  ): Promise<FastAgentSkillDocument> {
    if (id.startsWith('packaged:')) {
      return this.readPackaged(id.slice('packaged:'.length), requestedResource);
    }
    if (id.startsWith('settings:')) {
      if (!this.settingsSkills) throw new Error('Unknown skill.');
      return this.settingsSkills.read(id, requestedResource);
    }
    if (!this.repositorySkills) throw new Error('Unknown skill.');
    return this.repositorySkills.read(id, requestedResource);
  }

  async dispose(): Promise<void> {
    await Promise.all([
      this.repositorySkills?.dispose?.(),
      this.settingsSkills?.dispose?.(),
    ]);
  }

  private async readPackaged(
    name: string,
    requestedResource = 'SKILL.md',
  ): Promise<FastAgentSkillDocument> {
    if (!FAST_AGENT_PACKAGED_SKILL_NAME_SET.has(name)) {
      throw new Error('Unknown packaged skill.');
    }
    const typedName = name as FastAgentPackagedSkillName;
    const rootDirectory = await this.rootDirectory;
    const skillDirectory = join(rootDirectory, typedName);
    let resourcePromise = this.resources.get(typedName);
    if (!resourcePromise) {
      resourcePromise = listMarkdownResources(
        skillDirectory,
        skillDirectory,
      ).then((values) => values.sort());
      this.resources.set(typedName, resourcePromise);
    }
    const resources = await resourcePromise;
    if (!resources.includes(requestedResource)) {
      throw new Error('Unknown packaged skill resource.');
    }

    const resourcePath = join(skillDirectory, ...requestedResource.split('/'));
    const descriptor = await open(
      resourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const resourceStat = await descriptor.stat();
      if (
        !resourceStat.isFile() ||
        resourceStat.size > FAST_AGENT_SPILL_MAX_FILE_BYTES
      ) {
        throw new Error('Packaged skill resource is not a supported document.');
      }
      const content = await descriptor.readFile('utf8');
      const byteLength = Buffer.byteLength(content, 'utf8');
      if (byteLength > FAST_AGENT_SPILL_MAX_FILE_BYTES) {
        throw new Error('Packaged skill resource is not a supported document.');
      }
      return {
        byteLength,
        content,
        description:
          requestedResource === 'SKILL.md'
            ? getFastAgentSkillDescription(content)
            : '',
        id: packagedSkillId(typedName),
        invocation: typedName,
        name: typedName,
        resource: requestedResource,
        resources,
        source: 'packaged',
      };
    } finally {
      await descriptor.close();
    }
  }
}

export const fastAgentSkillStore = new FastAgentSkillStore();
