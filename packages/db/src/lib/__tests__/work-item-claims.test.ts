// Real-DB coverage for the shared work_items launch claim helpers and the
// (source_task_id, kind, sort_order) unique index.
//
// The launch state machine lives on work_items and is claimed/released/
// finalized through one shared module so every surface (Slack reactions,
// Telegram buttons, automation act items, web implement) behaves identically:
// stale-`launching` claims are recoverable, a `launched` item is never
// reclaimed or reverted, and `failed` stays terminal.

import { db, eq, inArray, tasks, taskFactory, workItems } from '../../server';
import {
  claimWorkItem,
  finalizeWorkItemLaunched,
  releaseWorkItemClaim,
  WORK_ITEM_LAUNCH_STALE_CLAIM_MS,
} from '../work-item-claims';

describe('work_items launch claim helpers', () => {
  const workItemIds: string[] = [];
  const taskIds: string[] = [];

  async function seedWorkItem(overrides?: {
    kind?: 'suggestion' | 'onboarding' | 'auto_fix';
    status?: 'open' | 'launching' | 'launched' | 'failed' | 'dismissed';
    launchClaimedAt?: Date | null;
    launchedTaskId?: string | null;
    dismissedAt?: Date | null;
  }): Promise<string> {
    const [row] = await db
      .insert(workItems)
      .values({
        kind: overrides?.kind ?? 'suggestion',
        title: 'Fix the flaky test',
        brief: 'The retry loop never terminates.',
        sortOrder: workItemIds.length,
        status: overrides?.status ?? 'open',
        launchClaimedAt: overrides?.launchClaimedAt ?? null,
        launchedTaskId: overrides?.launchedTaskId ?? null,
        dismissedAt: overrides?.dismissedAt ?? null,
      })
      .returning({ id: workItems.id });

    const workItemId = row!.id;
    workItemIds.push(workItemId);
    return workItemId;
  }

  async function seedLaunchedTaskId(): Promise<string> {
    const task = await taskFactory.create({});
    taskIds.push(task.id);
    return task.id;
  }

  async function readStatus(id: string) {
    const [row] = await db
      .select({
        status: workItems.status,
        launchClaimedAt: workItems.launchClaimedAt,
        launchedTaskId: workItems.launchedTaskId,
      })
      .from(workItems)
      .where(eq(workItems.id, id))
      .limit(1);
    return row;
  }

  afterEach(async () => {
    if (workItemIds.length > 0) {
      await db.delete(workItems).where(inArray(workItems.id, workItemIds));
      workItemIds.length = 0;
    }
    if (taskIds.length > 0) {
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
      taskIds.length = 0;
    }
  });

  it('claims an open item exactly once and flips it to launching', async () => {
    const id = await seedWorkItem();

    const first = await claimWorkItem(db, { id });
    const second = await claimWorkItem(db, { id });

    expect(first?.id).toBe(id);
    expect(second).toBeNull();

    const row = await readStatus(id);
    expect(row?.status).toBe('launching');
    expect(row?.launchClaimedAt).toBeInstanceOf(Date);
  });

  it('reclaims a stale launching item (crash recovery)', async () => {
    const staleClaimedAt = new Date(
      Date.now() - WORK_ITEM_LAUNCH_STALE_CLAIM_MS - 60_000,
    );
    const id = await seedWorkItem({
      status: 'launching',
      launchClaimedAt: staleClaimedAt,
    });

    const claimed = await claimWorkItem(db, { id });

    expect(claimed?.id).toBe(id);
    const row = await readStatus(id);
    expect(row?.status).toBe('launching');
    // The claim timestamp was refreshed to now (later than the stale value).
    expect(row?.launchClaimedAt?.getTime()).toBeGreaterThan(
      staleClaimedAt.getTime(),
    );
  });

  it('does not reclaim a fresh launching item', async () => {
    const id = await seedWorkItem({
      status: 'launching',
      launchClaimedAt: new Date(),
    });

    const claimed = await claimWorkItem(db, { id });

    expect(claimed).toBeNull();
    expect((await readStatus(id))?.status).toBe('launching');
  });

  it('never reclaims a launched item, even with an ancient claim', async () => {
    const launchedTaskId = await seedLaunchedTaskId();
    const id = await seedWorkItem({
      status: 'launched',
      launchedTaskId,
      launchClaimedAt: new Date(
        Date.now() - WORK_ITEM_LAUNCH_STALE_CLAIM_MS - 60_000,
      ),
    });

    const claimed = await claimWorkItem(db, { id });

    expect(claimed).toBeNull();
    expect((await readStatus(id))?.status).toBe('launched');
  });

  it('never reclaims a failed item (terminal by design)', async () => {
    const id = await seedWorkItem({ status: 'failed' });

    const claimed = await claimWorkItem(db, { id });

    expect(claimed).toBeNull();
    expect((await readStatus(id))?.status).toBe('failed');
  });

  it('only claims a dismissed item when it is in the claimable set', async () => {
    const id = await seedWorkItem({
      status: 'dismissed',
      dismissedAt: new Date(),
    });

    // Default claimable set excludes dismissed.
    expect(await claimWorkItem(db, { id })).toBeNull();
    expect((await readStatus(id))?.status).toBe('dismissed');

    // The web surface opts dismissed into the claimable set.
    const claimed = await claimWorkItem(db, {
      id,
      additionalClaimableStatuses: ['dismissed'],
    });
    expect(claimed?.id).toBe(id);
    expect((await readStatus(id))?.status).toBe('launching');
  });

  it('release reverts a launching item to open but never a launched one', async () => {
    const launchingClaimedAt = new Date();
    const launchingId = await seedWorkItem({
      status: 'launching',
      launchClaimedAt: launchingClaimedAt,
    });
    const launchedTaskId = await seedLaunchedTaskId();
    const launchedId = await seedWorkItem({
      status: 'launched',
      launchedTaskId,
    });

    const releasedLaunching = await releaseWorkItemClaim(db, {
      id: launchingId,
      claimedAt: launchingClaimedAt,
    });
    const releasedLaunched = await releaseWorkItemClaim(db, {
      id: launchedId,
      claimedAt: new Date(),
    });

    expect(releasedLaunching).toBe(true);
    expect((await readStatus(launchingId))?.status).toBe('open');

    // The status='launching' guard makes this a no-op on a launched item, so
    // its task link is never dropped.
    expect(releasedLaunched).toBe(false);
    const launchedRow = await readStatus(launchedId);
    expect(launchedRow?.status).toBe('launched');
    expect(launchedRow?.launchedTaskId).toBe(launchedTaskId);
  });

  it('finalize is idempotent under a race', async () => {
    const launchedTaskId = await seedLaunchedTaskId();
    const claimedAt = new Date();
    const id = await seedWorkItem({
      status: 'launching',
      launchClaimedAt: claimedAt,
    });

    const first = await finalizeWorkItemLaunched(db, {
      id,
      taskId: launchedTaskId,
      claimedAt,
    });
    const second = await finalizeWorkItemLaunched(db, {
      id,
      taskId: launchedTaskId,
      claimedAt,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    const row = await readStatus(id);
    expect(row?.status).toBe('launched');
    expect(row?.launchedTaskId).toBe(launchedTaskId);
  });

  it('fresh claim -> finalize with the matching token succeeds', async () => {
    const launchedTaskId = await seedLaunchedTaskId();
    const id = await seedWorkItem();

    const claimed = await claimWorkItem(db, { id });
    expect(claimed).not.toBeNull();

    const finalized = await finalizeWorkItemLaunched(db, {
      id,
      taskId: launchedTaskId,
      claimedAt: claimed!.launchClaimedAt,
    });

    expect(finalized).toBe(true);
    const row = await readStatus(id);
    expect(row?.status).toBe('launched');
    expect(row?.launchedTaskId).toBe(launchedTaskId);
  });

  it('finalize with a stale token fails after a reclaim (fencing)', async () => {
    const launchedTaskId = await seedLaunchedTaskId();
    // Seed a stale launching claim so the second launcher can reclaim it.
    const staleClaimedAt = new Date(
      Date.now() - WORK_ITEM_LAUNCH_STALE_CLAIM_MS - 60_000,
    );
    const id = await seedWorkItem({
      status: 'launching',
      launchClaimedAt: staleClaimedAt,
    });

    // The second launcher reclaims, minting a fresh token.
    const reclaimed = await claimWorkItem(db, { id });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.launchClaimedAt.getTime()).toBeGreaterThan(
      staleClaimedAt.getTime(),
    );

    // The original (slow) launcher's stale token no longer matches, so its
    // finalize is rejected and cannot stomp the new claimant's state.
    const staleFinalize = await finalizeWorkItemLaunched(db, {
      id,
      taskId: launchedTaskId,
      claimedAt: staleClaimedAt,
    });
    expect(staleFinalize).toBe(false);
    expect((await readStatus(id))?.status).toBe('launching');

    // The new claimant's matching token still finalizes.
    const freshFinalize = await finalizeWorkItemLaunched(db, {
      id,
      taskId: launchedTaskId,
      claimedAt: reclaimed!.launchClaimedAt,
    });
    expect(freshFinalize).toBe(true);
    const row = await readStatus(id);
    expect(row?.status).toBe('launched');
    expect(row?.launchedTaskId).toBe(launchedTaskId);
  });

  it('release with a stale token fails after a reclaim (fencing)', async () => {
    const staleClaimedAt = new Date(
      Date.now() - WORK_ITEM_LAUNCH_STALE_CLAIM_MS - 60_000,
    );
    const id = await seedWorkItem({
      status: 'launching',
      launchClaimedAt: staleClaimedAt,
    });

    const reclaimed = await claimWorkItem(db, { id });
    expect(reclaimed).not.toBeNull();

    // The slow launcher's stale release must not revert the new claimant's
    // launching state back to open.
    const staleRelease = await releaseWorkItemClaim(db, {
      id,
      claimedAt: staleClaimedAt,
    });
    expect(staleRelease).toBe(false);
    expect((await readStatus(id))?.status).toBe('launching');

    // The new claimant's matching token still releases.
    const freshRelease = await releaseWorkItemClaim(db, {
      id,
      claimedAt: reclaimed!.launchClaimedAt,
    });
    expect(freshRelease).toBe(true);
    expect((await readStatus(id))?.status).toBe('open');
  });
});

describe('work_items (source_task_id, kind, sort_order) unique index', () => {
  const taskIds: string[] = [];

  afterEach(async () => {
    if (taskIds.length > 0) {
      // work_items cascade-delete with their source task.
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
      taskIds.length = 0;
    }
  });

  it('lets suggestion and onboarding rows share a source task at overlapping sort orders', async () => {
    const sourceTask = await taskFactory.create({});
    taskIds.push(sourceTask.id);

    // Suggestion rows for the source task at sort orders 0 and 1.
    await db.insert(workItems).values([
      {
        kind: 'suggestion',
        sourceTaskId: sourceTask.id,
        title: 'Suggestion A',
        sortOrder: 0,
      },
      {
        kind: 'suggestion',
        sourceTaskId: sourceTask.id,
        title: 'Suggestion B',
        sortOrder: 1,
      },
    ]);

    // Onboarding rows queued against the SAME source task reuse sort orders 0
    // and 1. Before `kind` joined the unique key this insert violated the
    // (source_task_id, sort_order) unique and broke every onboarding queue.
    await expect(
      db.insert(workItems).values([
        {
          kind: 'onboarding',
          sourceTaskId: sourceTask.id,
          title: 'Onboarding A',
          sortOrder: 0,
        },
        {
          kind: 'onboarding',
          sourceTaskId: sourceTask.id,
          title: 'Onboarding B',
          sortOrder: 1,
        },
      ]),
    ).resolves.not.toThrow();

    const rows = await db
      .select({ id: workItems.id })
      .from(workItems)
      .where(eq(workItems.sourceTaskId, sourceTask.id));
    expect(rows).toHaveLength(4);
  });

  it('still rejects a duplicate (source_task_id, kind, sort_order)', async () => {
    const sourceTask = await taskFactory.create({});
    taskIds.push(sourceTask.id);

    await db.insert(workItems).values({
      kind: 'suggestion',
      sourceTaskId: sourceTask.id,
      title: 'Suggestion A',
      sortOrder: 0,
    });

    await expect(
      db.insert(workItems).values({
        kind: 'suggestion',
        sourceTaskId: sourceTask.id,
        title: 'Suggestion A duplicate',
        sortOrder: 0,
      }),
    ).rejects.toThrow();
  });
});
