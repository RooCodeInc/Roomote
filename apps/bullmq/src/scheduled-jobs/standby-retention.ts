import {
  and,
  db,
  desc,
  eq,
  inArray,
  isNotNull,
  resolveComputeProviderEnvValues,
  taskRuns,
} from '@roomote/db/server';
import { createComputeProviderClient } from '@roomote/compute-providers';
import { Env } from '@roomote/env';
import { activeRunStatuses, type RunStatus } from '@roomote/types';

const LOG_PREFIX = '[standbyRetention]';
const MS_PER_HOUR = 60 * 60 * 1_000;
const STANDBY_PROVIDERS = ['docker', 'blaxel'] as const;

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

function getPolicy(provider: StandbyProvider): {
  maxCount: number;
  maxAgeMs: number;
} {
  return provider === 'docker'
    ? {
        maxCount: Env.DOCKER_STANDBY_MAX_COUNT,
        maxAgeMs: Env.DOCKER_STANDBY_MAX_AGE_HOURS * MS_PER_HOUR,
      }
    : {
        maxCount: Env.BLAXEL_STANDBY_MAX_COUNT,
        maxAgeMs: Env.BLAXEL_STANDBY_MAX_AGE_HOURS * MS_PER_HOUR,
      };
}

async function createClient(provider: StandbyProvider) {
  if (provider === 'docker') {
    return createComputeProviderClient({ provider: 'docker' });
  }

  return createComputeProviderClient({
    provider: 'blaxel',
    envFallback: await resolveComputeProviderEnvValues('blaxel'),
  });
}

async function getProtectedHandles(provider: StandbyProvider) {
  const rows = await db
    .select({ handle: taskRuns.sourceSnapshotId })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.vendor, provider),
        isNotNull(taskRuns.sourceSnapshotId),
        inArray(taskRuns.status, activeRunStatuses as readonly RunStatus[]),
      ),
    );

  return new Set(
    rows.flatMap(({ handle }) => (handle === null ? [] : [handle])),
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
  const policy = getPolicy(provider);
  const candidates = await getCandidates(provider);
  const protectedHandles = await getProtectedHandles(provider);
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

export async function standbyRetentionJob(
  now: Date = new Date(),
): Promise<void> {
  const results = await Promise.all(
    STANDBY_PROVIDERS.map(async (provider) => ({
      provider,
      removed: await enforceProviderRetention(provider, now),
    })),
  );

  console.log(
    `${LOG_PREFIX} completed ${results
      .map(({ provider, removed }) => `${provider}=${removed}`)
      .join(' ')}`,
  );
}
