import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { FAST_AGENT_SPILL_MAX_FILE_BYTES } from './fast-agent-spill-store';

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
  source: 'packaged' | 'repository';
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

export type FastAgentSkillCatalog = FastAgentSkillListResult & {
  counts: {
    packaged: number;
    repository: number;
    total: number;
  };
};

export type FastAgentRepositorySkillSource = {
  list(environmentId?: string): Promise<FastAgentSkillListResult>;
  read(id: string, resource?: string): Promise<FastAgentSkillDocument>;
  dispose?(): Promise<void>;
};

const FAST_AGENT_PACKAGED_SKILL_NAME_SET = new Set<string>(
  FAST_AGENT_PACKAGED_SKILL_NAMES,
);
const SOURCE_SKILL_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../workflows/skills/standard',
);
const RUNTIME_SKILL_ROOT = resolve(process.cwd(), '../../skills/standard');

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveDefaultSkillRoot(): Promise<string> {
  for (const candidate of [SOURCE_SKILL_ROOT, RUNTIME_SKILL_ROOT]) {
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
  ) {
    this.rootDirectory = rootDirectory
      ? Promise.resolve(resolve(rootDirectory))
      : resolveDefaultSkillRoot();
  }

  async list(environmentId?: string): Promise<FastAgentSkillCatalog> {
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
    const repository = this.repositorySkills
      ? await this.repositorySkills.list(environmentId)
      : { skills: [], warnings: [] };
    return {
      counts: {
        packaged: packaged.length,
        repository: repository.skills.length,
        total: packaged.length + repository.skills.length,
      },
      skills: [...packaged, ...repository.skills].sort((left, right) =>
        left.name === right.name
          ? left.id.localeCompare(right.id)
          : left.name.localeCompare(right.name),
      ),
      warnings: repository.warnings,
    };
  }

  async read(
    id: string,
    requestedResource = 'SKILL.md',
  ): Promise<FastAgentSkillDocument> {
    if (id.startsWith('packaged:')) {
      return this.readPackaged(id.slice('packaged:'.length), requestedResource);
    }
    if (!this.repositorySkills) throw new Error('Unknown skill.');
    return this.repositorySkills.read(id, requestedResource);
  }

  async dispose(): Promise<void> {
    await this.repositorySkills?.dispose?.();
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
