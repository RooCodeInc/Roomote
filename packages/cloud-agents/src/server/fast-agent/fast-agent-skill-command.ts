import { createHash } from 'node:crypto';

import { getAvailableEnvironments } from '../available-environments';
import { RemoteFastAgentInstanceSkillSource } from './fast-agent-instance-skill-source';
import { RemoteFastAgentRepositorySkillSource } from './fast-agent-repository-skill-source';
import { RemoteFastAgentSettingsSkillSource } from './fast-agent-settings-skill-source';
import {
  FastAgentSkillStore,
  fastAgentSkillStore,
  type FastAgentSkillListResult,
  type FastAgentSkillSummary,
} from './fast-agent-skill-store';

const SKILLS_PER_PAGE = 8;
const SKILL_DESCRIPTION_MAX_LENGTH = 120;
const SKILL_COMMAND_CATALOG_CACHE_MAX_ENTRIES = 100;
const SKILL_COMMAND_REMOTE_FRESH_MS = 5 * 60_000;
const SKILL_COMMAND_CACHE_HARD_MAX_AGE_MS = 15 * 60_000;
const SKILL_COMMAND_REFRESH_RETRY_MS = 30_000;
const SKILL_COMMAND_REFRESH_TIMEOUT_MS = 90_000;
const SKILL_COMMAND_MAX_CONCURRENT_REFRESHES = 2;
const SOURCE_PRECEDENCE = {
  packaged: 0,
  instance: 1,
  settings: 2,
  repository: 3,
} as const;

export type UserCallableSkillCatalog = {
  skills: FastAgentSkillSummary[];
  warnings: string[];
  remoteDiscovery?: {
    marketplaceSourceCount: number;
    repositoryEnvironmentCount: number;
    status: 'failed' | 'partial' | 'ready';
  };
};

type SkillCatalogDependencies = {
  cache?: UserCallableSkillCatalogCache;
  environmentIds?: string[];
  list?: (environmentId?: string) => Promise<FastAgentSkillListResult>;
  log?: (message: string) => void;
  page?: number;
};

type UserCallableSkillCatalogCacheEntry = {
  createdAt: number;
  generation: number;
  next?: UserCallableSkillCatalog;
  refresh?: Promise<void>;
  refreshFailed: boolean;
  refreshOperationActive: boolean;
  remoteFreshUntil: number;
  retryAfter: number;
  visible: UserCallableSkillCatalog;
};

type LocalSkillCatalog = {
  catalog: UserCallableSkillCatalog;
  environmentIds: string[];
  pending: RemoteDiscoveryPending;
  revision: string;
};

type RemoteDiscoveryPending = {
  marketplaceSourceCount: number;
  repositoryEnvironmentCount: number;
};

export class UserCallableSkillCatalogCache {
  private readonly entries = new Map<
    string,
    UserCallableSkillCatalogCacheEntry
  >();

  constructor(
    maxEntries = SKILL_COMMAND_CATALOG_CACHE_MAX_ENTRIES,
    private readonly now = Date.now,
  ) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  private readonly maxEntries: number;
  private activeRefreshes = 0;

  get(input: {
    key: string;
    local: UserCallableSkillCatalog;
    page: number;
    pending: RemoteDiscoveryPending;
    refresh: () => Promise<UserCallableSkillCatalog>;
  }): { catalog: UserCallableSkillCatalog; status: 'hit' | 'miss' } {
    const now = this.now();
    for (const [entryKey, entry] of this.entries) {
      if (entry.createdAt + SKILL_COMMAND_CACHE_HARD_MAX_AGE_MS <= now) {
        this.entries.delete(entryKey);
      }
    }

    let entry = this.entries.get(input.key);
    const status = entry ? 'hit' : 'miss';
    if (!entry) {
      const hasRemoteSources =
        input.pending.marketplaceSourceCount > 0 ||
        input.pending.repositoryEnvironmentCount > 0;
      entry = {
        createdAt: now,
        generation: 0,
        refreshFailed: false,
        refreshOperationActive: false,
        remoteFreshUntil: hasRemoteSources ? 0 : Infinity,
        retryAfter: 0,
        visible: hasRemoteSources
          ? withRemoteDiscovery(input.local, input.pending, 'partial')
          : input.local,
      };
      this.pruneForInsert();
      this.entries.set(input.key, entry);
    }

    if (entry.next && input.page === 1) {
      entry.visible = entry.next;
      entry.next = undefined;
    }
    const hasRemoteSources =
      input.pending.marketplaceSourceCount > 0 ||
      input.pending.repositoryEnvironmentCount > 0;
    if (
      hasRemoteSources &&
      !entry.refreshOperationActive &&
      !entry.next &&
      entry.remoteFreshUntil <= now &&
      entry.retryAfter <= now &&
      this.activeRefreshes < SKILL_COMMAND_MAX_CONCURRENT_REFRESHES
    ) {
      this.startRefresh(input.key, entry, input.refresh);
    }

    const catalog = entry.next
      ? withRemoteDiscovery(entry.visible, input.pending, 'ready')
      : entry.refreshFailed
        ? withRemoteDiscovery(entry.visible, input.pending, 'failed')
        : entry.visible;
    return { catalog, status };
  }

  private pruneForInsert(): void {
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) return;
      this.entries.delete(oldestKey);
    }
  }

  private startRefresh(
    key: string,
    entry: UserCallableSkillCatalogCacheEntry,
    refresh: () => Promise<UserCallableSkillCatalog>,
  ): void {
    const generation = ++entry.generation;
    entry.refreshFailed = false;
    entry.refreshOperationActive = true;
    this.activeRefreshes += 1;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('Skill catalog refresh timed out.')),
        SKILL_COMMAND_REFRESH_TIMEOUT_MS,
      );
      timeout.unref?.();
    });
    const releaseOperation = () => {
      this.activeRefreshes -= 1;
      if (this.entries.get(key) === entry && entry.generation === generation) {
        entry.refreshOperationActive = false;
      }
    };
    const operation = Promise.resolve()
      .then(refresh)
      .then(
        (catalog) => {
          releaseOperation();
          return catalog;
        },
        (error: unknown) => {
          releaseOperation();
          throw error;
        },
      );
    entry.refresh = Promise.race([operation, timeoutPromise])
      .then(
        (catalog) => {
          if (
            this.entries.get(key) === entry &&
            entry.generation === generation
          ) {
            entry.next = catalog;
            entry.refreshFailed = false;
            entry.remoteFreshUntil = this.now() + SKILL_COMMAND_REMOTE_FRESH_MS;
          }
        },
        () => {
          if (
            this.entries.get(key) === entry &&
            entry.generation === generation
          ) {
            entry.refreshFailed = true;
            entry.retryAfter = this.now() + SKILL_COMMAND_REFRESH_RETRY_MS;
          }
        },
      )
      .finally(() => {
        if (timeout) clearTimeout(timeout);
        if (
          this.entries.get(key) === entry &&
          entry.generation === generation
        ) {
          entry.refresh = undefined;
        }
      });
  }
}

// Catalogs contain actor-visible instance and scoped skills. Actor/revision keys
// prevent cross-user reuse and replace snapshots when locally stored metadata changes.
const userCallableSkillCatalogCache = new UserCallableSkillCatalogCache();

function formatTiming(value: number): string {
  return value.toFixed(1);
}

function withRemoteDiscovery(
  catalog: UserCallableSkillCatalog,
  pending: RemoteDiscoveryPending,
  status: NonNullable<UserCallableSkillCatalog['remoteDiscovery']>['status'],
): UserCallableSkillCatalog {
  return {
    ...catalog,
    remoteDiscovery: { ...pending, status },
  };
}

function mergeSkillCatalogs(
  catalogs: FastAgentSkillListResult[],
): UserCallableSkillCatalog {
  const skillsById = new Map<string, FastAgentSkillSummary>();
  const warnings = new Set<string>();
  for (const catalog of catalogs) {
    for (const skill of catalog.skills) skillsById.set(skill.id, skill);
    for (const warning of catalog.warnings) warnings.add(warning);
  }

  const precedenceByInvocation = new Map<string, number>();
  for (const skill of skillsById.values()) {
    const invocation = skill.invocation ?? skill.name;
    const precedence = SOURCE_PRECEDENCE[skill.source];
    const current = precedenceByInvocation.get(invocation);
    if (current === undefined || precedence < current) {
      precedenceByInvocation.set(invocation, precedence);
    }
  }

  return {
    skills: [...skillsById.values()]
      .filter(
        (skill) =>
          SOURCE_PRECEDENCE[skill.source] ===
          precedenceByInvocation.get(skill.invocation ?? skill.name),
      )
      .sort((left, right) => {
        const invocationDifference = (
          left.invocation ?? left.name
        ).localeCompare(right.invocation ?? right.name);
        return invocationDifference || left.id.localeCompare(right.id);
      }),
    warnings: [...warnings],
  };
}

async function loadLocalSkillCatalog(
  userId: string,
): Promise<LocalSkillCatalog> {
  const environments = await getAvailableEnvironments();
  const environmentIds = environments.map((environment) => environment.id);
  const instanceSource = new RemoteFastAgentInstanceSkillSource(userId);
  const settingsSource = new RemoteFastAgentSettingsSkillSource({
    allowedEnvironmentIds: environmentIds,
  });
  const [packaged, instance, settings] = await Promise.all([
    fastAgentSkillStore.list(),
    instanceSource.list(),
    settingsSource.listPromptCatalog().catch((error: unknown) => ({
      catalogRevision: 'unavailable',
      marketplaceSources: [],
      skills: [],
      warnings: [
        `Skipped environment skills: ${error instanceof Error ? error.message : String(error)}`,
      ],
    })),
  ]);
  const catalog = mergeSkillCatalogs([
    packaged,
    instance,
    { skills: settings.skills, warnings: settings.warnings },
  ]);
  const pending = {
    marketplaceSourceCount: settings.marketplaceSources.reduce(
      (total, environment) => total + environment.sources.length,
      0,
    ),
    repositoryEnvironmentCount: environments.filter(
      (environment) => (environment.repositories?.length ?? 0) > 0,
    ).length,
  };
  const revision = createHash('sha256')
    .update(
      JSON.stringify({
        environments: environments
          .map((environment) => ({
            id: environment.id,
            repositories: (environment.repositories ?? [])
              .map((repository) => repository.id)
              .sort(),
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        marketplaceSources: [...settings.marketplaceSources]
          .map((environment) => ({
            environmentId: environment.environmentId,
            sources: [...environment.sources].sort(),
          }))
          .sort((left, right) =>
            left.environmentId.localeCompare(right.environmentId),
          ),
        settingsCatalogRevision: settings.catalogRevision,
        skills: catalog.skills.map((skill) => ({
          description: skill.description,
          environmentIds: skill.environmentIds,
          id: skill.id,
          invocation: skill.invocation,
          name: skill.name,
          source: skill.source,
          version: skill.version,
        })),
      }),
    )
    .digest('hex');
  return { catalog, environmentIds, pending, revision };
}

async function loadCompleteSkillCatalog(input: {
  environmentIds: string[];
  log: (message: string) => void;
  userId: string;
}): Promise<UserCallableSkillCatalog> {
  const sourceTimings = new Map<
    string,
    { calls: number; maxMs: number; totalMs: number }
  >();
  const skillStore = new FastAgentSkillStore(
    undefined,
    new RemoteFastAgentRepositorySkillSource({
      allowedEnvironmentIds: input.environmentIds,
    }),
    new RemoteFastAgentSettingsSkillSource({
      allowedEnvironmentIds: input.environmentIds,
    }),
    new RemoteFastAgentInstanceSkillSource(input.userId),
    (source, durationMs) => {
      const timing = sourceTimings.get(source) ?? {
        calls: 0,
        maxMs: 0,
        totalMs: 0,
      };
      timing.calls += 1;
      timing.maxMs = Math.max(timing.maxMs, durationMs);
      timing.totalMs += durationMs;
      sourceTimings.set(source, timing);
    },
  );
  const startedAt = performance.now();
  try {
    const catalog = mergeSkillCatalogs(
      await Promise.all([
        skillStore.list(),
        ...input.environmentIds.map((environmentId) =>
          skillStore.list({ environmentId }),
        ),
      ]),
    );
    const sourceSummary = [...sourceTimings.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([source, timing]) =>
          `${source}_calls=${timing.calls} ${source}_max_ms=${formatTiming(timing.maxMs)} ${source}_total_ms=${formatTiming(timing.totalMs)}`,
      )
      .join(' ');
    input.log(
      `[skills-command-source-timing] tier=remote catalog_ms=${formatTiming(performance.now() - startedAt)} ${sourceSummary} skills=${catalog.skills.length} warnings=${catalog.warnings.length}`,
    );
    return catalog;
  } finally {
    await skillStore.dispose();
  }
}

export async function listUserCallableFastAgentSkills(
  userId: string,
  dependencies: SkillCatalogDependencies = {},
): Promise<UserCallableSkillCatalog> {
  const startedAt = performance.now();
  const log = dependencies.log ?? ((message: string) => console.info(message));
  if (dependencies.list) {
    const environmentStartedAt = performance.now();
    const environmentIds =
      dependencies.environmentIds ??
      (await getAvailableEnvironments()).map((environment) => environment.id);
    const environmentDurationMs = performance.now() - environmentStartedAt;
    const catalogStartedAt = performance.now();
    const catalog = mergeSkillCatalogs(
      await Promise.all([
        dependencies.list(),
        ...environmentIds.map((environmentId) =>
          dependencies.list!(environmentId),
        ),
      ]),
    );
    log(
      `[skills-command-source-timing] tier=test environments_ms=${formatTiming(environmentDurationMs)} catalog_ms=${formatTiming(performance.now() - catalogStartedAt)} skills=${catalog.skills.length} warnings=${catalog.warnings.length}`,
    );
    return catalog;
  }

  const localStartedAt = performance.now();
  const local = await loadLocalSkillCatalog(userId);
  log(
    `[skills-command-source-timing] tier=local catalog_ms=${formatTiming(performance.now() - localStartedAt)} skills=${local.catalog.skills.length} warnings=${local.catalog.warnings.length} marketplace_sources=${local.pending.marketplaceSourceCount} repository_environments=${local.pending.repositoryEnvironmentCount}`,
  );
  const cache = dependencies.cache ?? userCallableSkillCatalogCache;
  const result = cache.get({
    key: `actor:${userId}:revision:${local.revision}`,
    local: local.catalog,
    page: dependencies.page ?? 1,
    pending: local.pending,
    refresh: () =>
      loadCompleteSkillCatalog({
        environmentIds: local.environmentIds,
        log,
        userId,
      }),
  });
  log(
    `[skills-command-timing] cache_status=${result.status} remote_status=${result.catalog.remoteDiscovery?.status ?? 'complete'} total_ms=${formatTiming(performance.now() - startedAt)} skills=${result.catalog.skills.length} warnings=${result.catalog.warnings.length}`,
  );
  return result.catalog;
}

function conciseDescription(description: string): string {
  const normalized = description.replace(/\s+/gu, ' ').trim();
  if (!normalized) return 'No description provided.';
  return normalized.length <= SKILL_DESCRIPTION_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, SKILL_DESCRIPTION_MAX_LENGTH - 1).trimEnd()}…`;
}

function formatSkillDescription(skill: FastAgentSkillSummary): string {
  return `${conciseDescription(skill.description)}${skill.repository ? ` (${skill.repository})` : ''}`;
}

export function formatUserCallableSkillsPage(input: {
  catalog: UserCallableSkillCatalog;
  page?: number;
  command: string;
}): string {
  const pageCount = Math.max(
    1,
    Math.ceil(input.catalog.skills.length / SKILLS_PER_PAGE),
  );
  const requestedPage = input.page ?? 1;
  const page = Math.min(Math.max(requestedPage, 1), pageCount);
  const start = (page - 1) * SKILLS_PER_PAGE;
  const skills = input.catalog.skills.slice(start, start + SKILLS_PER_PAGE);
  const partial = input.catalog.remoteDiscovery?.status === 'partial';
  const lines = [
    `**Available skills (${input.catalog.skills.length}${partial ? ' so far' : ''}) — page ${page}/${pageCount}**`,
    ...skills.map(
      (skill) =>
        `- \`$${skill.invocation ?? skill.name}\` — ${formatSkillDescription(skill)}`,
    ),
    '',
    'Invoke a skill by starting your request with its exact token, for example: `$review-code review these changes`.',
  ];
  if (page < pageCount)
    lines.push(`Next page: \`${input.command} ${page + 1}\`.`);
  if (requestedPage !== page) {
    lines.push(`Page ${requestedPage} is unavailable; showing page ${page}.`);
  }
  if (input.catalog.remoteDiscovery?.status === 'partial') {
    lines.push(
      `Still checking ${input.catalog.remoteDiscovery.marketplaceSourceCount} marketplace source(s) and ${input.catalog.remoteDiscovery.repositoryEnvironmentCount} repository environment(s). Send \`${input.command}\` again shortly for the full list.`,
    );
  } else if (input.catalog.remoteDiscovery?.status === 'ready') {
    lines.push(
      `The updated full list is ready. Send \`${input.command}\` to start again from page 1 without shifting this page sequence.`,
    );
  } else if (input.catalog.remoteDiscovery?.status === 'failed') {
    lines.push(
      `Remote skill discovery failed; showing the last available catalog. Send \`${input.command}\` again shortly to retry.`,
    );
  }
  if (input.catalog.warnings.length > 0) {
    lines.push(
      `Some scoped skill sources could not be fully inspected (${input.catalog.warnings.length}); the list does not claim skills from those sources.`,
    );
  }
  return lines.join('\n');
}

export function parseSkillsCommandPage(text: string): number | null {
  const match = /^\s*\/?skills(?:\s+(\d+))?\s*$/iu.exec(text);
  if (!match) return null;
  const page = Number.parseInt(match[1] ?? '1', 10);
  return Number.isSafeInteger(page) && page > 0 ? page : null;
}
