import {
  acquirePrReviewFixClaim,
  and,
  claimDurablePrReviewAction,
  db,
  eq,
  listPrReviewAggregateIdsNeedingDelivery,
  persistPrReviewEventAndFanOut,
  prReviewAggregates,
  prReviewEvents,
  prReviewNotificationDeliveries,
  releasePrReviewFixClaim,
  replayRecentPrReviewEventsForAssociation,
  taskFactory,
  taskPullRequests,
  userFactory,
} from '../../server';

async function createLinkedTask() {
  const user = await userFactory.create();
  const task = await taskFactory.create({ initiatorUserId: user.id });
  await db.insert(taskPullRequests).values({
    taskId: task.id,
    sourceControlProvider: 'github',
    repository: 'owner/repo',
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    status: 'open',
  });
  return { task, user };
}

describe('durable PR review notification state', () => {
  it('fans an idempotent provider event into one aggregate and two destinations', async () => {
    const { task } = await createLinkedTask();
    const input = {
      sourceControlProvider: 'github' as const,
      eventKey: 'review:100',
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      reviewHeadSha: 'abc123',
      kind: 'review' as const,
      authorLogin: 'reviewer',
      payload: { kind: 'review', authorLogin: 'reviewer' },
    };

    const first = await persistPrReviewEventAndFanOut(input);
    await persistPrReviewEventAndFanOut(input);

    expect(first.taskIds).toEqual([task.id]);
    const [aggregate] = await db
      .select()
      .from(prReviewAggregates)
      .where(eq(prReviewAggregates.taskId, task.id));
    expect(aggregate?.version).toBe(1);
    expect(aggregate?.events).toHaveLength(1);
    const deliveries = await db
      .select()
      .from(prReviewNotificationDeliveries)
      .where(eq(prReviewNotificationDeliveries.aggregateId, aggregate!.id));
    expect(deliveries.map((row) => row.destination).sort()).toEqual([
      'chat',
      'task_history',
    ]);

    await db
      .update(prReviewAggregates)
      .set({ followUpPrompt: 'Fix the latest findings.' })
      .where(eq(prReviewAggregates.id, aggregate!.id));
    await db
      .update(prReviewNotificationDeliveries)
      .set({
        actionNonce: 'durable-nonce',
        previousActionNonce: 'previous-durable-nonce',
        chatProvider: 'slack',
        chatChannelId: 'C123',
        chatThreadId: '111.222',
        chatMessageId: '333.444',
      })
      .where(
        and(
          eq(prReviewNotificationDeliveries.aggregateId, aggregate!.id),
          eq(prReviewNotificationDeliveries.destination, 'chat'),
        ),
      );
    const claims = await Promise.all([
      claimDurablePrReviewAction('durable-nonce'),
      claimDurablePrReviewAction('previous-durable-nonce'),
    ]);
    expect(claims.map((claim) => claim?.outcome).sort()).toEqual([
      'already_handled',
      'claimed',
    ]);

    const now = new Date();
    await db
      .update(prReviewNotificationDeliveries)
      .set({
        state: 'delivered',
        aggregateVersion: aggregate!.version,
        updatedAt: now,
      })
      .where(eq(prReviewNotificationDeliveries.aggregateId, aggregate!.id));
    await db
      .update(prReviewNotificationDeliveries)
      .set({
        state: 'sending',
        updatedAt: new Date(now.getTime() - 3 * 60_000),
      })
      .where(
        and(
          eq(prReviewNotificationDeliveries.aggregateId, aggregate!.id),
          eq(prReviewNotificationDeliveries.destination, 'chat'),
        ),
      );
    expect(await listPrReviewAggregateIdsNeedingDelivery(now)).toContain(
      aggregate!.id,
    );
  });

  it('replays events that won the pre-association race', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({ initiatorUserId: user.id });
    const persisted = await persistPrReviewEventAndFanOut({
      sourceControlProvider: 'github',
      eventKey: 'summary:200',
      repository: 'owner/repo',
      prNumber: 43,
      prUrl: 'https://github.com/owner/repo/pull/43',
      reviewHeadSha: 'def456',
      kind: 'review_summary',
      authorLogin: 'roomote[bot]',
      roomoteAuthored: true,
      payload: { kind: 'review_summary', authorLogin: 'roomote[bot]' },
    });
    expect(persisted.taskIds).toEqual([]);

    await db.insert(taskPullRequests).values({
      taskId: task.id,
      sourceControlProvider: 'github',
      repository: 'owner/repo',
      prNumber: 43,
      prUrl: 'https://github.com/owner/repo/pull/43',
      status: 'open',
    });
    const aggregateIds = await replayRecentPrReviewEventsForAssociation({
      taskId: task.id,
      sourceControlProvider: 'github',
      repository: 'owner/repo',
      prNumber: 43,
    });
    expect(aggregateIds).toHaveLength(1);
  });

  it('persists top-level pull request comments', async () => {
    await persistPrReviewEventAndFanOut({
      sourceControlProvider: 'github',
      eventKey: 'issue-comment:300',
      repository: 'owner/repo',
      prNumber: 44,
      prUrl: 'https://github.com/owner/repo/pull/44',
      reviewHeadSha: 'ghi789',
      kind: 'issue_comment',
      authorLogin: 'reviewer',
      payload: { kind: 'issue_comment', authorLogin: 'reviewer' },
    });

    const [event] = await db
      .select()
      .from(prReviewEvents)
      .where(eq(prReviewEvents.eventKey, 'issue-comment:300'));
    expect(event?.kind).toBe('issue_comment');
  });

  it('serializes fix work across every task linked to a PR', async () => {
    const { task, user } = await createLinkedTask();
    const { task: secondTask } = await createLinkedTask();
    const input = {
      taskId: task.id,
      sourceControlProvider: 'github' as const,
      repository: 'owner/repo',
      prNumber: 42,
      action: 'fix_review',
      actingUserId: user.id,
    };
    const first = await acquirePrReviewFixClaim(input);
    const second = await acquirePrReviewFixClaim({
      ...input,
      taskId: secondTask.id,
    });
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);

    if (first.acquired) await releasePrReviewFixClaim(first.claimId);
    expect((await acquirePrReviewFixClaim(input)).acquired).toBe(true);
  });
});
