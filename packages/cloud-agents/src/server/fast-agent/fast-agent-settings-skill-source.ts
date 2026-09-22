import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  and,
  db,
  environmentRepositoryMappings,
  environments,
  eq,
  inArray,
  repositories,
} from '@roomote/db/server';
import {
  environmentConfigSchema,
  renderManualSkillMarkdown,
  type EnvironmentConfig,
} from '@roomote/types';

import {
  getFastAgentSkillDescription,
  type FastAgentSettingsSkillSource,
  type FastAgentSkillDocument,
  type FastAgentSkillListResult,
  type FastAgentSkillQuery,
  type FastAgentSkillSummary,
} from './fast-agent-skill-store';
import { FastAgentPromptSkillSnapshotCache } from './fast-agent-prompt-skill-snapshot-cache';
import { FAST_AGENT_SPILL_MAX_FILE_BYTES } from './fast-agent-spill-store';

const execFileAsync = promisify(execFile);
const SETTINGS_SKILL_FETCH_TIMEOUT_MS = 60_000;
const SETTINGS_SKILL_GIT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const SETTINGS_SKILL_MAX_SOURCES = 8;
const SETTINGS_SKILL_MAX_FILES = 256;
const SETTINGS_SKILL_MAX_SKILLS = 128;
const SETTINGS_SKILL_PATH_MAX_CHARS = 1_024;
const SETTINGS_SKILL_SOURCE_PATTERN =
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*$/u;
const SETTINGS_SKILL_NAME_PATTERN = /^[^/\s]+$/u;

type SettingsSkillEnvironment = {
  config: EnvironmentConfig;
  id: string;
};

type SettingsSkillResource = {
  byteLength: number;
  path: string;
  resource: string;
};

export type SettingsSkillRecord = {
  content: string;
  description: string;
  environmentIds: string[];
  id: string;
  invocation: string;
  name: string;
  resources: Map<string, SettingsSkillResource>;
  sourceName?: string;
  snapshot?: SettingsSkillMarketplaceSnapshot;
};

export type SettingsSkillMarketplaceSnapshot = {
  directory: string;
  records: Array<
    Omit<
      SettingsSkillRecord,
      'environmentIds' | 'id' | 'invocation' | 'snapshot'
    >
  >;
  revision: string;
  source: string;
};

type FastAgentSettingsSkillSourceOptions = {
  allowedEnvironmentIds: string[];
  loadMarketplaceSnapshot?: (
    source: string,
    revision?: string,
  ) => Promise<SettingsSkillMarketplaceSnapshot>;
  resolveEnvironments?: (
    query: FastAgentSkillQuery,
  ) => Promise<SettingsSkillEnvironment[]>;
};

type GitTreeEntry = {
  byteLength: number;
  mode: string;
  path: string;
  type: string;
};

function parseGitTree(output: string): GitTreeEntry[] {
  const entries: GitTreeEntry[] = [];
  for (const rawEntry of output.split('\0')) {
    if (!rawEntry) continue;
    const match =
      /^(\d{6})\s+(\w+)\s+[0-9a-f]+(?:\s+(\d+|-))?\t([\s\S]+)$/u.exec(rawEntry);
    if (!match?.[1] || !match[2] || !match[4]) continue;
    const byteLength = match[3] ? Number(match[3]) : 0;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) continue;
    entries.push({
      byteLength,
      mode: match[1],
      path: match[4],
      type: match[2],
    });
  }
  return entries;
}

function parseFrontmatterScalar(content: string, key: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
    content,
  )?.[1];
  if (!frontmatter) return '';
  const match = new RegExp(`^${key}:\\s*(.*)$`, 'mu').exec(frontmatter);
  const value = match?.[1]?.trim() ?? '';
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function settingsSkillId(identity: string): string {
  return `settings:manual:${createHash('sha256').update(identity).digest('hex')}`;
}

function marketplaceSkillId(
  source: string,
  revision: string,
  name: string,
): string {
  const payload = Buffer.from(
    JSON.stringify([source, revision, name]),
    'utf8',
  ).toString('base64url');
  return `settings:marketplace:${payload}`;
}

type MarketplaceSkillReference = {
  name: string;
  revision: string;
  source: string;
};

function parseMarketplaceSkillId(
  id: string,
): MarketplaceSkillReference | undefined {
  const payload = /^settings:marketplace:([A-Za-z0-9_-]+)$/u.exec(id)?.[1];
  if (!payload) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string' ||
      typeof parsed[2] !== 'string' ||
      !SETTINGS_SKILL_SOURCE_PATTERN.test(parsed[0]) ||
      !/^[0-9a-f]{6,64}$/iu.test(parsed[1]) ||
      !SETTINGS_SKILL_NAME_PATTERN.test(parsed[2])
    ) {
      return undefined;
    }
    return { name: parsed[2], revision: parsed[1], source: parsed[0] };
  } catch {
    return undefined;
  }
}

async function runGit(
  args: string[],
  options: { cwd?: string } = {},
): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'gc.auto',
      GIT_CONFIG_VALUE_0: '0',
      GIT_TERMINAL_PROMPT: '0',
    },
    maxBuffer: SETTINGS_SKILL_GIT_OUTPUT_LIMIT_BYTES,
    timeout: SETTINGS_SKILL_FETCH_TIMEOUT_MS,
  });
  return result.stdout;
}

async function readGitResource(
  snapshot: Pick<SettingsSkillMarketplaceSnapshot, 'directory' | 'revision'>,
  path: string,
): Promise<string> {
  return runGit([
    '-C',
    snapshot.directory,
    'show',
    `${snapshot.revision}:${path}`,
  ]);
}

export async function loadFastAgentSettingsMarketplaceSnapshot(
  source: string,
  executeGit = runGit,
  revisionRef = 'HEAD',
): Promise<SettingsSkillMarketplaceSnapshot> {
  const sourceSegments = source.split('/');
  if (
    !SETTINGS_SKILL_SOURCE_PATTERN.test(source) ||
    sourceSegments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('Unsupported settings skill source.');
  }

  const directory = await mkdtemp(
    join(tmpdir(), 'roomote-fast-settings-skills-'),
  );
  const repositoryDirectory = join(directory, 'repository.git');
  try {
    await executeGit(['init', '--bare', repositoryDirectory]);
    await executeGit([
      '-C',
      repositoryDirectory,
      'fetch',
      '--depth=1',
      '--filter=blob:none',
      '--no-tags',
      `https://github.com/${source}.git`,
      revisionRef,
    ]);
    const revision = (
      await executeGit(['-C', repositoryDirectory, 'rev-parse', 'FETCH_HEAD'])
    ).trim();
    const markdownCandidates = parseGitTree(
      await executeGit([
        '-C',
        repositoryDirectory,
        'ls-tree',
        '-r',
        '-z',
        revision,
      ]),
    )
      .filter(
        (entry) =>
          entry.type === 'blob' &&
          (entry.mode === '100644' || entry.mode === '100755') &&
          entry.path.length <= SETTINGS_SKILL_PATH_MAX_CHARS &&
          entry.path.endsWith('.md'),
      )
      .sort((left, right) => {
        const leftMain =
          left.path === 'SKILL.md' || left.path.endsWith('/SKILL.md');
        const rightMain =
          right.path === 'SKILL.md' || right.path.endsWith('/SKILL.md');
        return leftMain === rightMain
          ? left.path.localeCompare(right.path)
          : leftMain
            ? -1
            : 1;
      })
      .slice(0, SETTINGS_SKILL_MAX_FILES);
    const tree =
      markdownCandidates.length === 0
        ? []
        : parseGitTree(
            await executeGit([
              '-C',
              repositoryDirectory,
              'ls-tree',
              '-z',
              '-l',
              revision,
              '--',
              ...markdownCandidates.map((entry) => entry.path),
            ]),
          ).filter(
            (entry) => entry.byteLength <= FAST_AGENT_SPILL_MAX_FILE_BYTES,
          );

    const mainEntries = tree
      .filter(
        (entry) =>
          entry.path === 'SKILL.md' || entry.path.endsWith('/SKILL.md'),
      )
      .slice(0, SETTINGS_SKILL_MAX_SKILLS);
    const skillRoots = new Set(
      mainEntries.map((entry) =>
        dirname(entry.path) === '.' ? '' : dirname(entry.path),
      ),
    );
    const records: SettingsSkillMarketplaceSnapshot['records'] = [];
    const seenNames = new Set<string>();
    for (const main of mainEntries) {
      const content = await executeGit([
        '-C',
        repositoryDirectory,
        'show',
        `${revision}:${main.path}`,
      ]);
      if (
        Buffer.byteLength(content, 'utf8') > FAST_AGENT_SPILL_MAX_FILE_BYTES
      ) {
        continue;
      }
      const name = parseFrontmatterScalar(content, 'name');
      if (
        !name ||
        !SETTINGS_SKILL_NAME_PATTERN.test(name) ||
        seenNames.has(name)
      ) {
        continue;
      }
      seenNames.add(name);
      const root = dirname(main.path) === '.' ? '' : dirname(main.path);
      const resources = new Map<string, SettingsSkillResource>();
      for (const entry of tree) {
        if (
          [...skillRoots].some(
            (candidateRoot) =>
              candidateRoot !== root &&
              candidateRoot.length > root.length &&
              entry.path.startsWith(`${candidateRoot}/`),
          )
        ) {
          continue;
        }
        const resource = root
          ? entry.path.startsWith(`${root}/`)
            ? entry.path.slice(root.length + 1)
            : ''
          : entry.path;
        if (!resource || resource.endsWith('/SKILL.md')) continue;
        if (root && !entry.path.startsWith(`${root}/`)) {
          continue;
        }
        resources.set(resource, {
          byteLength: entry.byteLength,
          path: entry.path,
          resource,
        });
      }
      if (!resources.has('SKILL.md')) continue;
      records.push({
        content,
        description: getFastAgentSkillDescription(content),
        name,
        resources,
        sourceName: source,
      });
    }
    return {
      directory: repositoryDirectory,
      records,
      revision,
      source,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function resolveSettingsSkillEnvironments(
  allowedEnvironmentIds: string[],
  query: FastAgentSkillQuery,
): Promise<SettingsSkillEnvironment[]> {
  let selectedEnvironmentIds = query.environmentId
    ? [query.environmentId]
    : allowedEnvironmentIds;
  if (query.repositoryId) {
    const mappings = await db
      .select({ environmentId: environmentRepositoryMappings.environmentId })
      .from(environmentRepositoryMappings)
      .innerJoin(
        repositories,
        eq(environmentRepositoryMappings.repositoryId, repositories.id),
      )
      .where(
        and(
          eq(environmentRepositoryMappings.repositoryId, query.repositoryId),
          eq(repositories.isActive, true),
          inArray(
            environmentRepositoryMappings.environmentId,
            allowedEnvironmentIds,
          ),
        ),
      );
    selectedEnvironmentIds = mappings.map((mapping) => mapping.environmentId);
  }
  if (selectedEnvironmentIds.length === 0) return [];
  const rows = await db
    .select({ config: environments.config, id: environments.id })
    .from(environments)
    .where(inArray(environments.id, selectedEnvironmentIds));
  return rows.flatMap((row) => {
    const config = environmentConfigSchema.safeParse(row.config);
    return config.success ? [{ config: config.data, id: row.id }] : [];
  });
}

/** Inline `manualSkills` from environment YAML share the same record format as
 * marketplace skills so prompt and tool inventories use one precedence path. */
function collectManualSkillRecords(
  authorizedEnvironments: SettingsSkillEnvironment[],
  byId: Map<string, SettingsSkillRecord>,
  warnings: string[],
): void {
  for (const environment of authorizedEnvironments) {
    for (const manualSkill of environment.config.manualSkills ?? []) {
      const content = renderManualSkillMarkdown(manualSkill);
      if (
        Buffer.byteLength(content, 'utf8') > FAST_AGENT_SPILL_MAX_FILE_BYTES
      ) {
        warnings.push(
          `A settings skill in environment ${environment.id} exceeded the Fast document limit.`,
        );
        continue;
      }
      const id = settingsSkillId(`${manualSkill.name}\0${content}`);
      const record = byId.get(id) ?? {
        content,
        description: manualSkill.description,
        environmentIds: [],
        id,
        invocation: manualSkill.name,
        name: manualSkill.name,
        resources: new Map([
          [
            'SKILL.md',
            {
              byteLength: Buffer.byteLength(content, 'utf8'),
              path: 'SKILL.md',
              resource: 'SKILL.md',
            },
          ],
        ]),
      };
      record.environmentIds.push(environment.id);
      byId.set(id, record);
    }
  }
}

export type FastAgentSettingsPromptCatalog = {
  /** Marketplace sources configured per authorized environment. The source
   * names remain useful in the prompt even when their bounded skill listing is
   * incomplete. */
  marketplaceSources: Array<{ environmentId: string; sources: string[] }>;
  skills: FastAgentSkillSummary[];
  warnings: string[];
};

export class RemoteFastAgentSettingsSkillSource implements FastAgentSettingsSkillSource {
  private readonly allowedEnvironmentIds: Set<string>;
  private readonly loadMarketplaceSnapshot: (
    source: string,
    revision?: string,
  ) => Promise<SettingsSkillMarketplaceSnapshot>;
  private readonly marketplaceSnapshots = new Map<
    string,
    Promise<SettingsSkillMarketplaceSnapshot>
  >();
  private readonly records = new Map<string, SettingsSkillRecord>();
  private readonly resolveEnvironments: (
    query: FastAgentSkillQuery,
  ) => Promise<SettingsSkillEnvironment[]>;

  constructor(options: FastAgentSettingsSkillSourceOptions) {
    this.allowedEnvironmentIds = new Set(options.allowedEnvironmentIds);
    this.loadMarketplaceSnapshot =
      options.loadMarketplaceSnapshot ??
      ((source, revision) =>
        loadFastAgentSettingsMarketplaceSnapshot(source, runGit, revision));
    this.resolveEnvironments =
      options.resolveEnvironments ??
      ((query) =>
        resolveSettingsSkillEnvironments(
          [...this.allowedEnvironmentIds],
          query,
        ));
  }

  private async getMarketplaceSnapshot(
    source: string,
    revision?: string,
  ): Promise<SettingsSkillMarketplaceSnapshot> {
    const key = revision ? `${source}\0${revision}` : source;
    let snapshotPromise = this.marketplaceSnapshots.get(key);
    if (!snapshotPromise) {
      snapshotPromise =
        revision === undefined
          ? this.loadMarketplaceSnapshot(source)
          : this.loadMarketplaceSnapshot(source, revision);
      this.marketplaceSnapshots.set(key, snapshotPromise);
    }
    return snapshotPromise;
  }

  async list(query: FastAgentSkillQuery): Promise<FastAgentSkillListResult> {
    if (query.sourceOffset !== undefined && !query.name) {
      throw new Error('A settings skill source offset requires an exact name.');
    }
    const sourceOffset = query.name ? (query.sourceOffset ?? 0) : 0;
    if (
      query.environmentId &&
      !this.allowedEnvironmentIds.has(query.environmentId)
    ) {
      throw new Error('Unknown Fast environment.');
    }
    const environmentsList = await this.resolveEnvironments(query);
    const authorizedEnvironments = environmentsList.filter((environment) =>
      this.allowedEnvironmentIds.has(environment.id),
    );
    const warnings: string[] = [];
    const byId = new Map<string, SettingsSkillRecord>();

    if (sourceOffset === 0) {
      collectManualSkillRecords(authorizedEnvironments, byId, warnings);
    }

    const sourceSelections = new Map<
      string,
      Map<string, 'all' | Set<string>>
    >();
    for (const environment of authorizedEnvironments) {
      for (const [source, selection] of Object.entries(
        environment.config.skills ?? {},
      )) {
        let environmentsForSource = sourceSelections.get(source);
        if (!environmentsForSource) {
          environmentsForSource = new Map();
          sourceSelections.set(source, environmentsForSource);
        }
        environmentsForSource.set(
          environment.id,
          selection === 'all' ? 'all' : new Set(selection),
        );
      }
    }

    const sourceCandidates = [...sourceSelections.entries()]
      .filter(([, selectionsByEnvironment]) =>
        query.name
          ? [...selectionsByEnvironment.values()].some(
              (selection) => selection === 'all' || selection.has(query.name!),
            )
          : true,
      )
      .sort((left, right) => {
        if (!query.name) return left[0].localeCompare(right[0]);
        const hasExplicitSelection = (
          selectionsByEnvironment: Map<string, 'all' | Set<string>>,
        ) =>
          [...selectionsByEnvironment.values()].some(
            (selection) => selection !== 'all' && selection.has(query.name!),
          );
        const priorityDifference =
          Number(hasExplicitSelection(right[1])) -
          Number(hasExplicitSelection(left[1]));
        return priorityDifference || left[0].localeCompare(right[0]);
      });
    const selectedSources = sourceCandidates.slice(
      sourceOffset,
      sourceOffset + SETTINGS_SKILL_MAX_SOURCES,
    );
    if (!query.name && sourceCandidates.length > selectedSources.length) {
      warnings.push(
        `Settings skill discovery omitted ${sourceCandidates.length - selectedSources.length} marketplace sources after reaching the limit of ${SETTINGS_SKILL_MAX_SOURCES}.`,
      );
    }
    const marketplaceResults = await Promise.all(
      selectedSources.map(async ([source, selectionsByEnvironment]) => {
        try {
          return {
            selectionsByEnvironment,
            snapshot: await this.getMarketplaceSnapshot(source),
            source,
          };
        } catch {
          return { selectionsByEnvironment, snapshot: null, source };
        }
      }),
    );
    for (const result of marketplaceResults) {
      const { selectionsByEnvironment, snapshot, source } = result;
      if (!snapshot) {
        warnings.push(`Settings skills could not be inspected for ${source}.`);
        continue;
      }
      for (const marketplaceRecord of snapshot.records) {
        const environmentIds = [...selectionsByEnvironment.entries()]
          .filter(
            ([, selection]) =>
              selection === 'all' || selection.has(marketplaceRecord.name),
          )
          .map(([environmentId]) => environmentId);
        if (environmentIds.length === 0) continue;
        const id = marketplaceSkillId(
          source,
          snapshot.revision,
          marketplaceRecord.name,
        );
        const record: SettingsSkillRecord = {
          ...marketplaceRecord,
          environmentIds,
          id,
          invocation: marketplaceRecord.name,
          snapshot,
        };
        byId.set(id, record);
      }
    }

    const skills: FastAgentSkillSummary[] = [];
    for (const record of byId.values()) {
      if (query.name && record.name !== query.name) continue;
      this.records.set(record.id, record);
      skills.push({
        description: record.description,
        environmentIds: [...new Set(record.environmentIds)].sort(),
        id: record.id,
        invocation: record.invocation,
        name: record.name,
        settingsSource: record.sourceName,
        source: 'settings',
      });
    }
    const nextSourceOffset =
      query.name &&
      sourceOffset + selectedSources.length < sourceCandidates.length
        ? sourceOffset + selectedSources.length
        : undefined;
    return {
      ...(nextSourceOffset === undefined ? {} : { nextSourceOffset }),
      skills,
      warnings,
    };
  }

  /** Inline environment skills plus the names of configured marketplace
   * sources, for the system prompt. The bounded listing is shared with
   * `list`, so IDs match and `load_skill` resolves them through any store
   * instance. */
  async listPromptCatalog(): Promise<FastAgentSettingsPromptCatalog> {
    const listed = await this.list({});
    const environmentsList = await this.resolveEnvironments({});
    const authorizedEnvironments = environmentsList.filter((environment) =>
      this.allowedEnvironmentIds.has(environment.id),
    );
    const marketplaceSources = authorizedEnvironments.flatMap((environment) => {
      const sources = Object.keys(environment.config.skills ?? {}).sort();
      return sources.length > 0
        ? [{ environmentId: environment.id, sources }]
        : [];
    });
    return {
      marketplaceSources,
      skills: listed.skills,
      warnings: listed.warnings,
    };
  }

  private async loadMarketplaceSkillReference(
    id: string,
    reference: MarketplaceSkillReference,
  ): Promise<void> {
    const environmentsList = await this.resolveEnvironments({});
    const selectionsByEnvironment = new Map<string, 'all' | Set<string>>();
    for (const environment of environmentsList) {
      if (!this.allowedEnvironmentIds.has(environment.id)) continue;
      const selection = environment.config.skills?.[reference.source];
      if (selection === undefined) continue;
      selectionsByEnvironment.set(
        environment.id,
        selection === 'all' ? 'all' : new Set(selection),
      );
    }
    const environmentIds = [...selectionsByEnvironment.entries()]
      .filter(
        ([, selection]) => selection === 'all' || selection.has(reference.name),
      )
      .map(([environmentId]) => environmentId)
      .sort();
    if (environmentIds.length === 0) return;

    const snapshot = await this.getMarketplaceSnapshot(
      reference.source,
      reference.revision,
    );
    if (snapshot.revision !== reference.revision) return;
    const marketplaceRecord = snapshot.records.find(
      (record) => record.name === reference.name,
    );
    if (!marketplaceRecord) return;
    this.records.set(id, {
      ...marketplaceRecord,
      environmentIds,
      id,
      invocation: marketplaceRecord.name,
      snapshot,
    });
  }

  async read(
    id: string,
    resource = 'SKILL.md',
  ): Promise<FastAgentSkillDocument> {
    // The system prompt lists settings skill IDs without going through the
    // executor's `list`, so a fresh per-turn source must be able to resolve
    // either an inline or marketplace record directly.
    if (!this.records.has(id) && id.startsWith('settings:')) {
      const marketplaceReference = parseMarketplaceSkillId(id);
      if (marketplaceReference) {
        await this.loadMarketplaceSkillReference(id, marketplaceReference);
      } else {
        await this.list({});
      }
    }
    const record = this.records.get(id);
    const selectedResource = record?.resources.get(resource);
    if (!record || !selectedResource) {
      throw new Error('Unknown settings skill resource.');
    }
    const content =
      resource === 'SKILL.md' || !record.snapshot
        ? record.content
        : await readGitResource(record.snapshot, selectedResource.path);
    const byteLength = Buffer.byteLength(content, 'utf8');
    if (byteLength > FAST_AGENT_SPILL_MAX_FILE_BYTES) {
      throw new Error('Skill resource is too large.');
    }
    return {
      byteLength,
      content,
      description: resource === 'SKILL.md' ? record.description : '',
      environmentIds: [...new Set(record.environmentIds)].sort(),
      id: record.id,
      invocation: record.invocation,
      name: record.name,
      resource,
      resources: [...record.resources.keys()].sort(),
      settingsSource: record.sourceName,
      source: 'settings',
    };
  }

  async dispose(): Promise<void> {
    const settled = await Promise.allSettled(
      this.marketplaceSnapshots.values(),
    );
    await Promise.all(
      settled.flatMap((result) =>
        result.status === 'fulfilled'
          ? [
              rm(dirname(result.value.directory), {
                recursive: true,
                force: true,
              }),
            ]
          : [],
      ),
    );
    this.marketplaceSnapshots.clear();
    this.records.clear();
  }
}

const promptMarketplaceSnapshotCache =
  new FastAgentPromptSkillSnapshotCache<SettingsSkillMarketplaceSnapshot>({
    cleanup: (snapshot) =>
      rm(dirname(snapshot.directory), { recursive: true, force: true }),
    // The prompt lists names and descriptions; `load_skill` reads a skill's
    // text and resources through its own source, so neither is kept here.
    retain: (snapshot) => ({
      ...snapshot,
      records: snapshot.records.map((record) => ({
        ...record,
        content: '',
        resources: new Map(),
      })),
    }),
  });

/**
 * The settings source the system prompt lists from. Inline environment skills
 * are read from the database on every turn as before; marketplace snapshots,
 * which need a fetch, come from the process-wide prompt cache.
 */
export function createFastAgentPromptSettingsSkillSource(
  allowedEnvironmentIds: string[],
): RemoteFastAgentSettingsSkillSource {
  return new RemoteFastAgentSettingsSkillSource({
    allowedEnvironmentIds,
    loadMarketplaceSnapshot: (source, revision) =>
      promptMarketplaceSnapshotCache.get(
        revision ? `${source}\0${revision}` : source,
        () =>
          loadFastAgentSettingsMarketplaceSnapshot(source, runGit, revision),
      ),
  });
}
