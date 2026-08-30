import {
  claimPullRequestConflictNotification,
  db,
  eq,
  listTrackedPullRequestsForMergeability,
  markPullRequestConflictNotified,
  recordPullRequestMergeability,
  releasePullRequestConflictNotificationClaim,
  taskFactory,
  taskPullRequests,
  tasks,
} from '../../server';

describe('pull request mergeability state', () => {
  it('scopes candidates and notifies once per conflicting transition', async () => {
    const task = await taskFactory.create();
    const repository = `owner/mergeability-${task.id}`;
    const [tracked] = await db
      .insert(taskPullRequests)
      .values({
        taskId: task.id,
        sourceControlProvider: 'github',
        repository,
        prNumber: 42,
        prUrl: `https://github.com/${repository}/pull/42`,
        prBaseRef: 'main',
        createdByRoomote: true,
        status: 'open',
      })
      .returning({ id: taskPullRequests.id });
    await db.insert(taskPullRequests).values({
      taskId: task.id,
      sourceControlProvider: 'github',
      repository,
      prNumber: 43,
      prUrl: `https://github.com/${repository}/pull/43`,
      prBaseRef: 'develop',
      createdByRoomote: true,
      status: 'open',
    });

    try {
      const candidates = await listTrackedPullRequestsForMergeability({
        repository,
        baseRef: 'main',
        skipNotifiedConflicts: true,
      });
      expect(candidates.map((candidate) => candidate.prNumber)).toEqual([42]);

      const firstConflict = await recordPullRequestMergeability({
        id: tracked!.id,
        status: 'conflicting',
      });
      expect(firstConflict.shouldNotify).toBe(true);
      expect(firstConflict.conflictDetectedAt).toBeInstanceOf(Date);

      const claims = await Promise.all([
        claimPullRequestConflictNotification({
          id: tracked!.id,
          conflictDetectedAt: firstConflict.conflictDetectedAt!,
        }),
        claimPullRequestConflictNotification({
          id: tracked!.id,
          conflictDetectedAt: firstConflict.conflictDetectedAt!,
        }),
      ]);
      const firstClaim = claims.find((claim): claim is Date => claim !== null);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(firstClaim).toBeInstanceOf(Date);

      const staleClaim = new Date('2020-01-01T00:00:00.000Z');
      await db
        .update(taskPullRequests)
        .set({ conflictNotificationClaimedAt: staleClaim })
        .where(eq(taskPullRequests.id, tracked!.id));
      const reclaimed = await claimPullRequestConflictNotification({
        id: tracked!.id,
        conflictDetectedAt: firstConflict.conflictDetectedAt!,
      });
      expect(reclaimed).toBeInstanceOf(Date);

      await releasePullRequestConflictNotificationClaim({
        id: tracked!.id,
        conflictDetectedAt: firstConflict.conflictDetectedAt!,
        conflictNotificationClaimedAt: staleClaim,
      });
      expect(
        await claimPullRequestConflictNotification({
          id: tracked!.id,
          conflictDetectedAt: firstConflict.conflictDetectedAt!,
        }),
      ).toBeNull();
      await releasePullRequestConflictNotificationClaim({
        id: tracked!.id,
        conflictDetectedAt: firstConflict.conflictDetectedAt!,
        conflictNotificationClaimedAt: reclaimed!,
      });

      const finalClaim = await claimPullRequestConflictNotification({
        id: tracked!.id,
        conflictDetectedAt: firstConflict.conflictDetectedAt!,
      });

      await markPullRequestConflictNotified({
        id: tracked!.id,
        conflictDetectedAt: firstConflict.conflictDetectedAt!,
        conflictNotificationClaimedAt: finalClaim!,
      });
      const repeatedConflict = await recordPullRequestMergeability({
        id: tracked!.id,
        status: 'conflicting',
      });
      expect(repeatedConflict.shouldNotify).toBe(false);

      expect(
        await listTrackedPullRequestsForMergeability({
          repository,
          baseRef: 'main',
          skipNotifiedConflicts: true,
        }),
      ).toEqual([]);

      await recordPullRequestMergeability({ id: tracked!.id, status: 'clean' });
      const secondConflict = await recordPullRequestMergeability({
        id: tracked!.id,
        status: 'conflicting',
      });
      expect(secondConflict.shouldNotify).toBe(true);
      expect(secondConflict.conflictDetectedAt).not.toEqual(
        firstConflict.conflictDetectedAt,
      );
    } finally {
      await db.delete(tasks).where(eq(tasks.id, task.id));
    }
  });
});
