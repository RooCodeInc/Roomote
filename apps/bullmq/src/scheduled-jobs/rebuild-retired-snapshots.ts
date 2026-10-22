import { isEnvironmentSnapshotFromRelease } from '@roomote/compute-providers';
import { Env } from '@roomote/env';
import {
  type ComputeProvider,
  resolveComputeProviderTarget,
  getComputeProviderCapabilities,
} from '@roomote/types';
import {
  db,
  environments,
  environmentSnapshots,
  resolveDefaultComputeProvider,
  and,
  asc,
  eq,
  exists,
  gte,
  isNotNull,
  isNull,
  lte,
  max,
  not,
} from '@roomote/db/server';

import {
  launchMissingEnvironmentSnapshot,
  SNAPSHOT_REFRESH_LAUNCH_SPACING_MS,
} from './refresh-snapshots';

const LOG_PREFIX = '[rebuildRetiredSnapshots]';

/**
 * How long an environment must go without an edit before its retired snapshot
 * is rebuilt. Edits often come in bursts (add a skill, then remove it), and
 * each one would otherwise start a build the next edit makes obsolete.
 */
export const RETIRED_SNAPSHOT_REBUILD_QUIET_MS = 5 * 60 * 1000;

/**
 * Retirements older than this are left to the daily refresh, which has run by
 * then and builds a snapshot for every environment that lacks one.
 */
export const RETIRED_SNAPSHOT_REBUILD_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Launches per run. With launches paced SNAPSHOT_REFRESH_LAUNCH_SPACING_MS
 * apart this keeps a run shorter than the five-minute schedule, so runs do
 * not overlap and halve the pacing. The rest are picked up by the next run.
 */
const RETIRED_SNAPSHOT_REBUILD_MAX_PER_RUN = 6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RetiredSnapshotRebuildCandidate {
  environmentId: string;
  environmentName: string;
  retiredAt: Date | null;
}

/**
 * Environments whose working snapshot was retired by a recent edit and that
 * have had no snapshot row since.
 *
 * Requiring a retired row that was ready leaves environments that never had a
 * working snapshot to the daily refresh. Requiring no live row is what makes
 * this one build per retirement: the launch claims a live row, and whether
 * that build ends ready or failed the environment no longer matches.
 */
export async function findRetiredSnapshotRebuildCandidates(
  now: Date,
  provider: ComputeProvider,
): Promise<RetiredSnapshotRebuildCandidate[]> {
  const quietSince = new Date(
    now.getTime() - RETIRED_SNAPSHOT_REBUILD_QUIET_MS,
  );
  const retiredSince = new Date(
    now.getTime() - RETIRED_SNAPSHOT_REBUILD_WINDOW_MS,
  );

  const retiredAt = max(environmentSnapshots.deletedAt);

  return db
    .select({
      environmentId: environments.id,
      environmentName: environments.name,
      retiredAt,
    })
    .from(environments)
    .innerJoin(
      environmentSnapshots,
      and(
        eq(environmentSnapshots.environmentId, environments.id),
        eq(environmentSnapshots.provider, provider),
        eq(environmentSnapshots.snapshotStatus, 'ready'),
        isNotNull(environmentSnapshots.snapshotId),
        isNotNull(environmentSnapshots.deletedAt),
        gte(environmentSnapshots.deletedAt, retiredSince),
      ),
    )
    .where(
      and(
        lte(environments.updatedAt, quietSince),
        not(
          exists(
            db
              .select({ id: environmentSnapshots.id })
              .from(environmentSnapshots)
              .where(
                and(
                  eq(environmentSnapshots.environmentId, environments.id),
                  eq(environmentSnapshots.provider, provider),
                  isNull(environmentSnapshots.deletedAt),
                ),
              ),
          ),
        ),
      ),
    )
    .groupBy(environments.id, environments.name)
    .orderBy(asc(retiredAt))
    .limit(RETIRED_SNAPSHOT_REBUILD_MAX_PER_RUN);
}

/**
 * Retires ready snapshots that another release built. Launches already skip
 * them, so retiring them lets the rebuild below replace them within minutes
 * of an upgrade instead of waiting for the daily refresh.
 */
export async function retireEnvironmentSnapshotsFromOtherReleases(
  now: Date,
  provider: ComputeProvider,
  applicationProductVersion: string | null | undefined,
): Promise<number> {
  const liveReadySnapshots = await db
    .select({
      id: environmentSnapshots.id,
      snapshotId: environmentSnapshots.snapshotId,
      workerVersion: environmentSnapshots.workerVersion,
    })
    .from(environmentSnapshots)
    .where(
      and(
        eq(environmentSnapshots.provider, provider),
        eq(environmentSnapshots.snapshotStatus, 'ready'),
        isNotNull(environmentSnapshots.snapshotId),
        isNull(environmentSnapshots.deletedAt),
      ),
    );

  const staleSnapshots = liveReadySnapshots.filter(
    (snapshot) =>
      !isEnvironmentSnapshotFromRelease(
        snapshot.workerVersion,
        applicationProductVersion,
      ),
  );

  let retired = 0;

  for (const snapshot of staleSnapshots) {
    if (!snapshot.snapshotId) continue;
    // Compare-and-swap against the observed state: a concurrent claim or
    // attach may have turned this row into a pending build or a snapshot from
    // the running release since the read above, and neither may be retired.
    const rows = await db
      .update(environmentSnapshots)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(environmentSnapshots.id, snapshot.id),
          isNull(environmentSnapshots.deletedAt),
          eq(environmentSnapshots.snapshotStatus, 'ready'),
          eq(environmentSnapshots.snapshotId, snapshot.snapshotId),
          snapshot.workerVersion === null
            ? isNull(environmentSnapshots.workerVersion)
            : eq(environmentSnapshots.workerVersion, snapshot.workerVersion),
        ),
      )
      .returning({ id: environmentSnapshots.id });
    retired += rows.length;
  }

  return retired;
}

/**
 * Rebuilds environment snapshots soon after an edit retires them, instead of
 * leaving every launch to set the environment up from scratch until the next
 * daily refresh.
 */
export async function rebuildRetiredSnapshots(now: Date): Promise<{
  rebuilt: number;
  skipped: number;
  errors: number;
}> {
  const provider = resolveComputeProviderTarget(
    await resolveDefaultComputeProvider(),
  );
  if (!getComputeProviderCapabilities(provider).supportsSnapshots) {
    return { rebuilt: 0, skipped: 0, errors: 0 };
  }
  const retiredFromOtherReleases =
    await retireEnvironmentSnapshotsFromOtherReleases(
      now,
      provider,
      Env.RELEASE_PRODUCT_VERSION,
    );
  if (retiredFromOtherReleases > 0) {
    console.log(
      `${LOG_PREFIX} Retired ${retiredFromOtherReleases} snapshot(s) built by another release ${JSON.stringify(
        { provider, applicationProductVersion: Env.RELEASE_PRODUCT_VERSION },
      )}`,
    );
  }

  const candidates = await findRetiredSnapshotRebuildCandidates(now, provider);

  if (candidates.length === 0) {
    return { rebuilt: 0, skipped: 0, errors: 0 };
  }

  let lastLaunchAtMs: number | null = null;
  let rebuilt = 0;
  let skipped = 0;
  let errors = 0;

  for (const candidate of candidates) {
    const details = {
      environmentId: candidate.environmentId,
      environmentName: candidate.environmentName,
      provider,
      retiredAt: candidate.retiredAt?.toISOString() ?? null,
    };

    try {
      const launch = await launchMissingEnvironmentSnapshot(
        { environmentId: candidate.environmentId, provider },
        {
          // The candidate query saw no live row, but a build started elsewhere
          // may have claimed and failed since. The claim re-checks under the
          // snapshot lock so that attempt is not repeated here.
          requireNoSnapshotRow: true,
          paceBeforeLaunch: async () => {
            if (lastLaunchAtMs === null) return;
            const elapsedMs = Date.now() - lastLaunchAtMs;
            if (elapsedMs < SNAPSHOT_REFRESH_LAUNCH_SPACING_MS) {
              await sleep(SNAPSHOT_REFRESH_LAUNCH_SPACING_MS - elapsedMs);
            }
          },
        },
      );

      if (launch.kind !== 'enqueued') {
        skipped++;
        continue;
      }

      lastLaunchAtMs = Date.now();
      rebuilt++;
      console.log(
        `${LOG_PREFIX} Rebuilding retired snapshot ${JSON.stringify({ ...details, runId: launch.runId })}`,
      );
    } catch (error) {
      errors++;
      console.error(
        `${LOG_PREFIX} Failed to rebuild retired snapshot ${JSON.stringify({
          ...details,
          error: error instanceof Error ? error.message : String(error),
        })}`,
      );
    }
  }

  return { rebuilt, skipped, errors };
}

export const rebuildRetiredSnapshotsJob = async (): Promise<void> => {
  await rebuildRetiredSnapshots(new Date());
};
