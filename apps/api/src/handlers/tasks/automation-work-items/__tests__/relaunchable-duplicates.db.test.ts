// pnpm --filter @roomote/api test automation-work-items/__tests__/relaunchable-duplicates.db.test.ts
//
// Real-DB coverage for relaunching stranded automation work items. A
// transient launch failure (for example a Discord outage while creating the
// task thread) reopens the work item, and the reopened row blocks
// re-insertion as an active fingerprint duplicate — so the next scan that
// reports the same finding must pick the row back up for launch.

import { db, inArray, workItems } from '@roomote/db/server';

import { loadRelaunchableDuplicateWorkItems } from '../persistence';

describe('loadRelaunchableDuplicateWorkItems', () => {
  const workItemIds: string[] = [];

  async function seedAutoFixWorkItem(overrides?: {
    status?: 'open' | 'launching' | 'launched' | 'failed';
    kind?: 'auto_fix' | 'suggestion';
  }): Promise<string> {
    const [row] = await db
      .insert(workItems)
      .values({
        kind: overrides?.kind ?? 'auto_fix',
        title: 'Fix the flaky test',
        brief: 'The retry loop never terminates.',
        disposition: 'act',
        targetRepositoryFullName: 'acme/app',
        fingerprint: `fp-${workItemIds.length}-${process.hrtime.bigint()}`,
        sortOrder: workItemIds.length,
        status: overrides?.status ?? 'open',
      })
      .returning({ id: workItems.id });

    const workItemId = row!.id;
    workItemIds.push(workItemId);
    return workItemId;
  }

  afterEach(async () => {
    if (workItemIds.length > 0) {
      await db.delete(workItems).where(inArray(workItems.id, workItemIds));
      workItemIds.length = 0;
    }
  });

  it('returns open and launching duplicates that never linked a task', async () => {
    const reopenedId = await seedAutoFixWorkItem({ status: 'open' });
    const staleLaunchingId = await seedAutoFixWorkItem({ status: 'launching' });

    const relaunchable = await loadRelaunchableDuplicateWorkItems([
      reopenedId,
      staleLaunchingId,
    ]);

    expect(relaunchable.map((item) => item.id).sort()).toEqual(
      [reopenedId, staleLaunchingId].sort(),
    );
  });

  it('skips launched, failed, and non-auto-fix rows', async () => {
    const launchedId = await seedAutoFixWorkItem({ status: 'launched' });
    const failedId = await seedAutoFixWorkItem({ status: 'failed' });
    const suggestionId = await seedAutoFixWorkItem({ kind: 'suggestion' });

    await expect(
      loadRelaunchableDuplicateWorkItems([launchedId, failedId, suggestionId]),
    ).resolves.toEqual([]);
  });

  it('returns nothing for an empty id list without querying', async () => {
    await expect(loadRelaunchableDuplicateWorkItems([])).resolves.toEqual([]);
  });
});
