import { getAvailableEnvironments } from '../available-environments';
import { RemoteFastAgentInstanceSkillSource } from './fast-agent-instance-skill-source';
import { RemoteFastAgentRepositorySkillSource } from './fast-agent-repository-skill-source';
import { RemoteFastAgentSettingsSkillSource } from './fast-agent-settings-skill-source';
import {
  FastAgentSkillStore,
  type FastAgentSkillListResult,
  type FastAgentSkillSummary,
} from './fast-agent-skill-store';

const SKILLS_PER_PAGE = 8;
const SKILL_DESCRIPTION_MAX_LENGTH = 120;
const SKILL_COMMAND_CATALOG_CACHE_TTL_MS = 30_000;
const SKILL_COMMAND_CATALOG_CACHE_MAX_ENTRIES = 100;
const SOURCE_PRECEDENCE = {
  packaged: 0,
  instance: 1,
  settings: 2,
  repository: 3,
} as const;

export type UserCallableSkillCatalog = {
  skills: FastAgentSkillSummary[];
  warnings: string[];
};

type SkillCatalogDependencies = {
  cache?: UserCallableSkillCatalogCache;
  environmentIds?: string[];
  list?: (environmentId?: string) => Promise<FastAgentSkillListResult>;
  log?: (message: string) => void;
};

type UserCallableSkillCatalogCacheEntry = {
  expiresAt: number;
  promise: Promise<UserCallableSkillCatalog>;
};

export class UserCallableSkillCatalogCache {
  private readonly entries = new Map<
    string,
    UserCallableSkillCatalogCacheEntry
  >();

  constructor(
    private readonly ttlMs = SKILL_COMMAND_CATALOG_CACHE_TTL_MS,
    maxEntries = SKILL_COMMAND_CATALOG_CACHE_MAX_ENTRIES,
    private readonly now = Date.now,
  ) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  private readonly maxEntries: number;

  async get(
    key: string,
    load: () => Promise<UserCallableSkillCatalog>,
  ): Promise<{
    catalog: UserCallableSkillCatalog;
    status: 'hit' | 'joined' | 'miss';
  }> {
    const now = this.now();
    for (const [entryKey, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(entryKey);
    }

    const current = this.entries.get(key);
    if (current) {
      const status = current.expiresAt === Infinity ? 'joined' : 'hit';
      return { catalog: await current.promise, status };
    }

    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }

    const entry: UserCallableSkillCatalogCacheEntry = {
      expiresAt: Infinity,
      promise: Promise.resolve().then(load),
    };
    entry.promise = entry.promise.then(
      (catalog) => {
        if (this.entries.get(key) === entry) {
          entry.expiresAt = this.now() + this.ttlMs;
        }
        return catalog;
      },
      (error: unknown) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      },
    );
    this.entries.set(key, entry);
    return { catalog: await entry.promise, status: 'miss' };
  }
}

// Catalogs contain actor-visible instance and scoped skills. Actor-specific keys
// prevent cross-user reuse; the short TTL bounds permission/config staleness.
const userCallableSkillCatalogCache = new UserCallableSkillCatalogCache();

function formatTiming(value: number): string {
  return value.toFixed(1);
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

export async function listUserCallableFastAgentSkills(
  userId: string,
  dependencies: SkillCatalogDependencies = {},
): Promise<UserCallableSkillCatalog> {
  const startedAt = performance.now();
  const log = dependencies.log ?? ((message: string) => console.info(message));
  const cache =
    dependencies.cache ??
    (dependencies.list ? undefined : userCallableSkillCatalogCache);
  const load = async () => {
    const environmentStartedAt = performance.now();
    const environmentIds =
      dependencies.environmentIds ??
      (await getAvailableEnvironments()).map((environment) => environment.id);
    const environmentDurationMs = performance.now() - environmentStartedAt;
    if (dependencies.list) {
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
        `[skills-command-source-timing] environments_ms=${formatTiming(environmentDurationMs)} catalog_ms=${formatTiming(performance.now() - catalogStartedAt)} skills=${catalog.skills.length} warnings=${catalog.warnings.length}`,
      );
      return catalog;
    }

    const sourceTimings = new Map<
      string,
      { calls: number; maxMs: number; totalMs: number }
    >();
    const skillStore = new FastAgentSkillStore(
      undefined,
      new RemoteFastAgentRepositorySkillSource({
        allowedEnvironmentIds: environmentIds,
      }),
      new RemoteFastAgentSettingsSkillSource({
        allowedEnvironmentIds: environmentIds,
      }),
      new RemoteFastAgentInstanceSkillSource(userId),
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
    const catalogStartedAt = performance.now();
    try {
      const catalog = mergeSkillCatalogs(
        await Promise.all([
          skillStore.list(),
          ...environmentIds.map((environmentId) =>
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
      log(
        `[skills-command-source-timing] environments_ms=${formatTiming(environmentDurationMs)} catalog_ms=${formatTiming(performance.now() - catalogStartedAt)} ${sourceSummary} skills=${catalog.skills.length} warnings=${catalog.warnings.length}`,
      );
      return catalog;
    } finally {
      await skillStore.dispose();
    }
  };

  const cacheContext = dependencies.environmentIds
    ? `environments:${JSON.stringify([...dependencies.environmentIds].sort())}`
    : 'all-authorized-environments';
  const result = cache
    ? await cache.get(`actor:${userId}:${cacheContext}`, load)
    : { catalog: await load(), status: 'miss' as const };
  log(
    `[skills-command-timing] cache_status=${result.status} total_ms=${formatTiming(performance.now() - startedAt)} skills=${result.catalog.skills.length} warnings=${result.catalog.warnings.length}`,
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
  const lines = [
    `**Available skills (${input.catalog.skills.length}) — page ${page}/${pageCount}**`,
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
