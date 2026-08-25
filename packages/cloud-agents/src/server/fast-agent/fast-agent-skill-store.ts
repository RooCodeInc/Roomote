import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { FAST_AGENT_SPILL_MAX_FILE_BYTES } from './fast-agent-spill-store';
import {
  FAST_DIRECT_PACKAGED_SKILL_NAMES,
  type PackagedSkillName,
} from '../../packaged-skill-catalog';

export type FastAgentSkillDocument = {
  byteLength: number;
  content: string;
  name: PackagedSkillName;
  resource: string;
  resources: string[];
};

const FAST_AGENT_PACKAGED_SKILL_NAME_SET = new Set<string>(
  FAST_DIRECT_PACKAGED_SKILL_NAMES,
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
    const typedName = name as PackagedSkillName;
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
