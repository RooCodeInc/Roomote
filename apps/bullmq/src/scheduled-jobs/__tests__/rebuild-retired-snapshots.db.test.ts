import { randomUUID } from 'node:crypto';

import {
  db,
  environments,
  environmentSnapshots,
  inArray,
  claimPendingEnvironmentSnapshotForAttachment,
  softDeleteEnvironmentSnapshots,
  upsertEnvironmentSnapshot,
} from '@roomote/db/server';

import {
  findRetiredSnapshotRebuildCandidates,
  RETIRED_SNAPSHOT_REBUILD_QUIET_MS,
  RETIRED_SNAPSHOT_REBUILD_WINDOW_MS,
} from '../rebuild-retired-snapshots';

/**
 * Runs the real candidate query. Which environments it returns depends on the
 * rows an edit and a rebuild actually leave behind (a retired row stays, a
 * claim adds a live one), and mocks cannot show that.
 */
describe('retired snapshot rebuild candidates (real database)', () => {
  const provider = 'modal' as const;
  const now = new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const settled = ago(RETIRED_SNAPSHOT_REBUILD_QUIET_MS + 60_000);
  const createdEnvironmentIds: string[] = [];

  async function createEnvironment(updatedAt: Date) {
    const [environment] = await db
      .insert(environments)
      .values({
        name: `rebuild-retired-${randomUUID()}`,
        config: { name: 'rebuild-retired', repositories: [] },
        updatedAt,
      })
      .returning({ id: environments.id });
    createdEnvironmentIds.push(environment!.id);
    return environment!.id;
  }

  async function addSnapshot(
    environmentId: string,
    snapshotStatus: 'ready' | 'failed',
  ) {
    await upsertEnvironmentSnapshot(db, {
      environmentId,
      provider,
      snapshotId: snapshotStatus === 'ready' ? `im-${randomUUID()}` : null,
      snapshotStatus,
      snapshotCreatedAt: snapshotStatus === 'ready' ? ago(3_600_000) : null,
      snapshotExpiresAt: null,
    });
  }

  async function retireSnapshots(environmentId: string, retiredAt: Date) {
    await softDeleteEnvironmentSnapshots(db, {
      environmentId,
      updatedAt: retiredAt,
    });
  }

  const candidateIds = async () =>
    (await findRetiredSnapshotRebuildCandidates(now, provider))
      .map((candidate) => candidate.environmentId)
      .filter((id) => createdEnvironmentIds.includes(id));

  afterAll(async () => {
    if (createdEnvironmentIds.length > 0) {
      await db
        .delete(environmentSnapshots)
        .where(
          inArray(environmentSnapshots.environmentId, createdEnvironmentIds),
        );
      await db
        .delete(environments)
        .where(inArray(environments.id, createdEnvironmentIds));
    }
  });

  it('selects an environment whose ready snapshot was retired once edits have settled', async () => {
    const retired = await createEnvironment(settled);
    await addSnapshot(retired, 'ready');
    await retireSnapshots(retired, settled);

    // Same retirement, but the environment was edited a moment ago.
    const stillBeingEdited = await createEnvironment(ago(30_000));
    await addSnapshot(stillBeingEdited, 'ready');
    await retireSnapshots(stillBeingEdited, ago(30_000));

    const selected = await candidateIds();

    expect(selected).toContain(retired);
    expect(selected).not.toContain(stillBeingEdited);
  });

  it('leaves environments that never had a working snapshot to the daily refresh', async () => {
    const neverBuilt = await createEnvironment(settled);

    const onlyEverFailed = await createEnvironment(settled);
    await addSnapshot(onlyEverFailed, 'failed');
    await retireSnapshots(onlyEverFailed, settled);

    const selected = await candidateIds();

    expect(selected).not.toContain(neverBuilt);
    expect(selected).not.toContain(onlyEverFailed);
  });

  it('ignores a live snapshot and a retirement older than the window', async () => {
    const live = await createEnvironment(settled);
    await addSnapshot(live, 'ready');

    const retiredLongAgo = await createEnvironment(settled);
    await addSnapshot(retiredLongAgo, 'ready');
    await retireSnapshots(
      retiredLongAgo,
      ago(RETIRED_SNAPSHOT_REBUILD_WINDOW_MS + 3_600_000),
    );

    const selected = await candidateIds();

    expect(selected).not.toContain(live);
    expect(selected).not.toContain(retiredLongAgo);
  });

  it('stops selecting an environment once a rebuild has claimed it, and selects it again after the next retirement', async () => {
    const environmentId = await createEnvironment(settled);
    await addSnapshot(environmentId, 'ready');
    await retireSnapshots(environmentId, settled);
    expect(await candidateIds()).toContain(environmentId);

    const claim = await claimPendingEnvironmentSnapshotForAttachment(db, {
      environmentId,
      provider,
      requireMissingSnapshot: true,
    });
    expect(claim).not.toBeNull();
    expect(await candidateIds()).not.toContain(environmentId);

    // A later edit retires the rebuilt (or still pending) row too.
    await retireSnapshots(environmentId, settled);
    expect(await candidateIds()).toContain(environmentId);
  });

  it('returns each environment once however many snapshots it has had retired', async () => {
    const environmentId = await createEnvironment(settled);
    await addSnapshot(environmentId, 'ready');
    await retireSnapshots(environmentId, ago(3 * 3_600_000));
    await addSnapshot(environmentId, 'ready');
    await retireSnapshots(environmentId, settled);

    const selected = (await candidateIds()).filter(
      (id) => id === environmentId,
    );

    expect(selected).toEqual([environmentId]);
  });
});
