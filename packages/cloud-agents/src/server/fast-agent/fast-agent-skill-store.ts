import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, sep } from 'node:path';

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

export type FastAgentPackagedSkillName =
  (typeof FAST_AGENT_PACKAGED_SKILL_NAMES)[number];

type FastAgentSkillDocument = {
  byteLength: number;
  content: string;
  name: FastAgentPackagedSkillName;
  resource: string;
  resources: string[];
};

const FAST_AGENT_PACKAGED_SKILL_NAME_SET = new Set<string>(
  FAST_AGENT_PACKAGED_SKILL_NAMES,
);
const SOURCE_SKILL_ROOT = fileURLToPath(
  new URL('../workflows/skills/standard', import.meta.url),
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

export class FastAgentSkillStore {
  private readonly resources = new Map<string, Promise<string[]>>();
  private readonly rootDirectory: Promise<string>;

  constructor(rootDirectory?: string) {
    this.rootDirectory = rootDirectory
      ? Promise.resolve(resolve(rootDirectory))
      : resolveDefaultSkillRoot();
  }

  async read(
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
      return {
        byteLength: Buffer.byteLength(content, 'utf8'),
        content,
        name: typedName,
        resource: requestedResource,
        resources,
      };
    } finally {
      await descriptor.close();
    }
  }
}

export const fastAgentSkillStore = new FastAgentSkillStore();
