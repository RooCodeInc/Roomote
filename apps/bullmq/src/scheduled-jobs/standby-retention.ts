import {
  and,
  db,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  resolveComputeProviderEnvValues,
  taskRuns,
} from '@roomote/db/server';
import { createComputeProviderClient } from '@roomote/compute-providers';
import { activeRunStatuses, type RunStatus } from '@roomote/types';

const LOG_PREFIX = '[standbyRetention]';
const MS_PER_HOUR = 60 * 60 * 1_000;
const WAIT_RECOVERY_MARGIN_MS = MS_PER_HOUR;
const STANDBY_PROVIDERS = ['docker', 'blaxel', 'box', 'azure'] as const;

// Providers whose retained handles are live instances that can (and must) be
// re-suspended when found Running with no managing run.
const RE_SUSPEND_PROVIDERS: readonly StandbyProvider[] = ['box', 'azure'];

type StandbyProvider = (typeof STANDBY_PROVIDERS)[number];

type StandbyCandidate = {
  runId: number;
  taskId: string;
  provider: StandbyProvider;
  handle: string;
  createdAt: Date;
};

export function selectStandbyEvictions(
  candidates: StandbyCandidate[],
  protectedHandles: ReadonlySet<string>,
  policy: { maxCount: number; maxAgeMs: number },
  now: Date,
): StandbyCandidate[] {
  const cutoffMs = now.getTime() - policy.maxAgeMs;
  return candidates.filter(
    (candidate, index) =>
      !protectedHandles.has(candidate.handle) &&
      (candidate.createdAt.getTime() < cutoffMs || index >= policy.maxCount),
  );
}

const DEFAULT_POLICY = {
  docker: { maxCount: 10, maxAgeHours: 24 },
  blaxel: { maxCount: 25, maxAgeHours: 168 },
  box: { maxCount: 25, maxAgeHours: 168 },
  // Suspended ACA sandboxes cost almost nothing, so azure retention is generous.
  azure: { maxCount: 50, maxAgeHours: 720 },
} as const;

function parsePolicyInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max = Number.POSITIVE_INFINITY,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

export function resolveStandbyRetentionPolicy(
  provider: StandbyProvider,
  env: Partial<Record<string, string>>,
): {
  maxCount: number;
  maxAgeMs: number;
} {
  const prefix = provider.toUpperCase();
  const defaults = DEFAULT_POLICY[provider];
  const maxCount = parsePolicyInteger(
    env[`${prefix}_STANDBY_MAX_COUNT`],
    defaults.maxCount,
    0,
  );
  const maxAgeHours = parsePolicyInteger(
    env[`${prefix}_STANDBY_MAX_AGE_HOURS`],
    defaults.maxAgeHours,
    1,
    // Providers with a higher default keep their ceiling (azure: 720h);
    // others stay capped at 168h as before.
    Math.max(168, defaults.maxAgeHours),
  );

  return { maxCount, maxAgeMs: maxAgeHours * MS_PER_HOUR };
}

async function createClient(provider: StandbyProvider) {
  if (provider === 'docker') {
    return createComputeProviderClient({ provider: 'docker' });
  }

  if (provider === 'azure') {
    return createComputeProviderClient({
      provider: 'azure',
      envFallback: await resolveComputeProviderEnvValues('azure'),
    });
  }

  if (provider === 'box') {
    return createComputeProviderClient({
      provider: 'box',
      envFallback: await resolveComputeProviderEnvValues('box'),
    });
  }

  return createComputeProviderClient({
    provider: 'blaxel',
    envFallback: await resolveComputeProviderEnvValues('blaxel'),
  });
}

/**
 * Handles referenced by any active run — as its machine (a live wake session
 * owns the sandbox) or as its retained standby handle. Re-suspending one of
 * these would kill a live session, so the orphan sweep must skip them.
 */
async function getInUseHandles(
  provider: StandbyProvider,
  handles: string[],
): Promise<Set<string>> {
  if (handles.length === 0) return new Set();

  const rows = await db
    .select({
      machineId: taskRuns.machineId,
      snapshotId: taskRuns.snapshotId,
    })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.vendor, provider),
        inArray(taskRuns.status, activeRunStatuses as readonly RunStatus[]),
        or(
          inArray(taskRuns.machineId, handles),
          inArray(taskRuns.snapshotId, handles),
        ),
      ),
    );

  return new Set(
    rows.flatMap((row) =>
      [row.machineId, row.snapshotId].flatMap((handle) =>
        handle === null ? [] : [handle],
      ),
    ),
  );
}

async function getProtectedHandles(provider: StandbyProvider, now: Date) {
  const activeResumeRows = await db
    .select({ handle: taskRuns.sourceSnapshotId })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.vendor, provider),
        isNotNull(taskRuns.sourceSnapshotId),
        inArray(taskRuns.status, activeRunStatuses as readonly RunStatus[]),
      ),
    );

  const pendingWaitRows = await db
    .select({ handle: taskRuns.snapshotId })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.vendor, provider),
        isNotNull(taskRuns.snapshotId),
        isNotNull(taskRuns.waitUntil),
        isNull(taskRuns.waitResumedAt),
        isNull(taskRuns.waitResumeRunId),
        gt(
          taskRuns.waitUntil,
          new Date(now.getTime() - WAIT_RECOVERY_MARGIN_MS),
        ),
      ),
    );

  return new Set(
    [...activeResumeRows, ...pendingWaitRows].flatMap(({ handle }) =>
      handle === null ? [] : [handle],
    ),
  );
}

async function getCandidates(
  provider: StandbyProvider,
): Promise<StandbyCandidate[]> {
  const rows = await db
    .select({
      runId: taskRuns.id,
      taskId: taskRuns.taskId,
      provider: taskRuns.vendor,
      handle: taskRuns.snapshotId,
      createdAt: taskRuns.snapshotCreatedAt,
    })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.vendor, provider),
        isNotNull(taskRuns.snapshotId),
        isNotNull(taskRuns.snapshotCreatedAt),
      ),
    )
    .orderBy(desc(taskRuns.snapshotCreatedAt));

  const seen = new Set<string>();
  return rows.flatMap((row) => {
    if (
      row.provider !== provider ||
      row.handle === null ||
      row.createdAt === null ||
      seen.has(row.handle)
    ) {
      return [];
    }

    seen.add(row.handle);
    return [{ ...row, provider, handle: row.handle, createdAt: row.createdAt }];
  });
}

async function enforceProviderRetention(
  provider: StandbyProvider,
  now: Date,
): Promise<number> {
  const resolvedEnv = await resolveComputeProviderEnvValues(provider);
  const policy = resolveStandbyRetentionPolicy(provider, resolvedEnv);
  const candidates = await getCandidates(provider);
  const protectedHandles = await getProtectedHandles(provider, now);
  const evicted = selectStandbyEvictions(
    candidates,
    protectedHandles,
    policy,
    now,
  );

  if (evicted.length === 0) return 0;

  const client = await createClient(provider);
  let removed = 0;

  for (const candidate of evicted) {
    try {
      await client.destroyInstance({ instanceId: candidate.handle });
      await db
        .update(taskRuns)
        .set({
          snapshotId: null,
          snapshotCreatedAt: null,
        })
        .where(
          and(
            eq(taskRuns.vendor, provider),
            eq(taskRuns.snapshotId, candidate.handle),
          ),
        );
      removed += 1;
      console.log(
        `${LOG_PREFIX} removed ${provider} standby ${candidate.handle} from task run #${candidate.runId}`,
      );
    } catch (error) {
      console.error(
        `${LOG_PREFIX} failed to remove ${provider} standby ${candidate.handle}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return removed;
}

/**
 * Re-suspend retained standby instances found Running. A retained instance
 * has no living run: its worker token was finalized at suspend time, so any
 * out-of-band wake (traffic on legacy OnDemand ports, portal actions, a wake
 * that resumed the sandbox before bootstrap failed) leaves it idling and
 * billing with no Roomote run to manage it. Sleep-check deliberately
 * excludes retained runs (its candidacy requires snapshotId IS NULL), so
 * this sweep is the only re-suspend path.
 *
 * Wake-race note: a deliberate wake stamps the resume run's sourceSnapshotId
 * with the handle at enqueue time, which getProtectedHandles covers, so the
 * window for stopping a sandbox mid-wake is limited to the wake's own
 * resume+launch seconds. A lost race fails that wake attempt cleanly and the
 * user retries; the next sweep re-heals the orphan either way.
 */
async function reSuspendOrphanedStandbys(
  provider: StandbyProvider,
  now: Date,
): Promise<number> {
  const candidates = await getCandidates(provider);
  if (candidates.length === 0) return 0;

  const protectedHandles = await getProtectedHandles(provider, now);
  const inUseHandles = await getInUseHandles(
    provider,
    candidates.map((candidate) => candidate.handle),
  );
  const client = await createClient(provider);

  if (!client.enterStandby) return 0;

  let resuspended = 0;

  for (const candidate of candidates) {
    if (
      protectedHandles.has(candidate.handle) ||
      inUseHandles.has(candidate.handle)
    ) {
      continue;
    }

    let status: string;
    try {
      const result = await client.getInstanceStatus({
        instanceId: candidate.handle,
      });
      status = result.status;
    } catch {
      // Not a live instance (a genuine snapshot id, or already deleted) —
      // the retention eviction policy owns its lifecycle.
      continue;
    }

    if (status !== 'running') continue;

    try {
      await client.enterStandby({ instanceId: candidate.handle });
      resuspended += 1;
      console.log(
        `${LOG_PREFIX} re-suspended orphaned ${provider} standby ${candidate.handle} from task run #${candidate.runId}`,
      );
    } catch (error) {
      console.error(
        `${LOG_PREFIX} failed to re-suspend ${provider} standby ${candidate.handle}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return resuspended;
}

export async function standbyRetentionJob(
  now: Date = new Date(),
): Promise<void> {
  const results = await Promise.all(
    STANDBY_PROVIDERS.map(async (provider) => ({
      provider,
      removed: await enforceProviderRetention(provider, now),
      resuspended: RE_SUSPEND_PROVIDERS.includes(provider)
        ? await reSuspendOrphanedStandbys(provider, now)
        : 0,
    })),
  );

  console.log(
    `${LOG_PREFIX} completed ${results
      .map(
        ({ provider, removed, resuspended }) =>
          `${provider}(removed=${removed},resuspended=${resuspended})`,
      )
      .join(' ')}`,
  );
}
