import { randomUUID } from 'node:crypto';

const {
  mockLaunchMissingEnvironmentSnapshot,
  mockResolveDefaultComputeProvider,
} = vi.hoisted(() => ({
  mockLaunchMissingEnvironmentSnapshot: vi.fn(),
  mockResolveDefaultComputeProvider: vi.fn(),
}));

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );
  return {
    ...actual,
    resolveDefaultComputeProvider: (...args: unknown[]) =>
      mockResolveDefaultComputeProvider(...args),
  };
});

vi.mock('../refresh-snapshots', async () => {
  const actual = await vi.importActual<typeof import('../refresh-snapshots')>(
    '../refresh-snapshots',
  );
  return {
    ...actual,
    launchMissingEnvironmentSnapshot: (...args: unknown[]) =>
      mockLaunchMissingEnvironmentSnapshot(...args),
  };
});

import {
  db,
  environments,
  environmentSnapshots,
  inArray,
  softDeleteEnvironmentSnapshots,
  upsertEnvironmentSnapshot,
} from '@roomote/db/server';

import {
  rebuildRetiredSnapshots,
  RETIRED_SNAPSHOT_REBUILD_QUIET_MS,
} from '../rebuild-retired-snapshots';
import { SNAPSHOT_REFRESH_LAUNCH_SPACING_MS } from '../refresh-snapshots';

type LaunchOptions = { paceBeforeLaunch: () => Promise<void> };

describe('retired snapshot rebuild job', () => {
  const provider = 'modal' as const;
  const now = new Date();
  const settled = new Date(
    now.getTime() - RETIRED_SNAPSHOT_REBUILD_QUIET_MS - 60_000,
  );
  // The job takes the oldest retirements first, up to its per-run cap. Retiring
  // these well before anything another test file creates keeps them inside it.
  const retiredAt = new Date(now.getTime() - 23 * 60 * 60 * 1000);
  const createdEnvironmentIds: string[] = [];

  async function createRetiredEnvironment() {
    const [environment] = await db
      .insert(environments)
      .values({
        name: `rebuild-retired-job-${randomUUID()}`,
        config: { name: 'rebuild-retired-job', repositories: [] },
        updatedAt: settled,
      })
      .returning({ id: environments.id });
    const environmentId = environment!.id;
    createdEnvironmentIds.push(environmentId);
    await upsertEnvironmentSnapshot(db, {
      environmentId,
      provider,
      snapshotId: `im-${randomUUID()}`,
      snapshotStatus: 'ready',
      snapshotCreatedAt: settled,
      snapshotExpiresAt: null,
    });
    await softDeleteEnvironmentSnapshots(db, {
      environmentId,
      updatedAt: retiredAt,
    });
    return environmentId;
  }

  const launchedEnvironmentIds = () =>
    mockLaunchMissingEnvironmentSnapshot.mock.calls
      .map(([target]) => (target as { environmentId: string }).environmentId)
      .filter((id) => createdEnvironmentIds.includes(id));

  beforeEach(() => {
    mockLaunchMissingEnvironmentSnapshot.mockReset();
    mockResolveDefaultComputeProvider.mockReset();
    mockResolveDefaultComputeProvider.mockResolvedValue(provider);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (createdEnvironmentIds.length > 0) {
      await db
        .delete(environmentSnapshots)
        .where(
          inArray(environmentSnapshots.environmentId, createdEnvironmentIds),
        );
      await db
        .delete(environments)
        .where(inArray(environments.id, createdEnvironmentIds));
      createdEnvironmentIds.length = 0;
    }
  });

  it('launches a rebuild for each retired environment on the default provider', async () => {
    const first = await createRetiredEnvironment();
    const second = await createRetiredEnvironment();
    mockLaunchMissingEnvironmentSnapshot.mockResolvedValue({
      kind: 'enqueued',
      runId: 1,
    });

    const result = await rebuildRetiredSnapshots(now);

    expect(launchedEnvironmentIds()).toEqual(
      expect.arrayContaining([first, second]),
    );
    for (const [target, options] of mockLaunchMissingEnvironmentSnapshot.mock
      .calls) {
      expect(target).toMatchObject({ provider });
      // A build that failed elsewhere since the query must not be repeated.
      expect(options).toMatchObject({ requireNoSnapshotRow: true });
    }
    expect(result.rebuilt).toBeGreaterThanOrEqual(2);
    expect(result.errors).toBe(0);
  });

  it('waits out the launch spacing before every launch after the first', async () => {
    await createRetiredEnvironment();
    await createRetiredEnvironment();
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      delay?: number,
    ) => {
      // Only the pacing sleep is this long; let every other timer run as is.
      if (delay !== undefined && delay > 1_000) {
        waits.push(delay);
        return realSetTimeout(callback, 0);
      }
      return realSetTimeout(callback, delay);
    }) as typeof setTimeout);
    mockLaunchMissingEnvironmentSnapshot.mockImplementation(
      async (_target: unknown, options: LaunchOptions) => {
        await options.paceBeforeLaunch();
        return { kind: 'enqueued', runId: 1 };
      },
    );

    const result = await rebuildRetiredSnapshots(now);

    expect(waits).toHaveLength(result.rebuilt - 1);
    for (const wait of waits) {
      expect(wait).toBeGreaterThan(SNAPSHOT_REFRESH_LAUNCH_SPACING_MS - 5_000);
      expect(wait).toBeLessThanOrEqual(SNAPSHOT_REFRESH_LAUNCH_SPACING_MS);
    }
  });

  it('keeps going when one launch fails or is already in flight', async () => {
    const first = await createRetiredEnvironment();
    const second = await createRetiredEnvironment();
    const third = await createRetiredEnvironment();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockLaunchMissingEnvironmentSnapshot.mockImplementation(
      async (target: { environmentId: string }) => {
        if (target.environmentId === first) throw new Error('launch failed');
        if (target.environmentId === second) return { kind: 'skipped' };
        return { kind: 'enqueued', runId: 1 };
      },
    );

    const result = await rebuildRetiredSnapshots(now);

    expect(launchedEnvironmentIds()).toEqual(
      expect.arrayContaining([first, second, third]),
    );
    expect(result.errors).toBe(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.rebuilt).toBeGreaterThanOrEqual(1);
  });
});
