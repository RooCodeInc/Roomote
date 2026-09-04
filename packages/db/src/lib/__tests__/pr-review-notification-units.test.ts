import { randomUUID } from 'node:crypto';

import {
  and,
  attachCanonicalPrReviewActionMessage,
  claimCanonicalPrReviewAction,
  claimDueCanonicalPrReviewDeliveries,
  completeCanonicalPrReviewActionDispatch,
  db,
  deferPrReviewDeliveries,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  findPrReviewAutoPreference,
  lockPrReviewReference,
  persistPrReviewEvent,
  prReviewAutoPreferences,
  prReviewEvents,
  prReviewNotificationDeliveries,
  prReviewNotificationUnitEvents,
  prReviewNotificationUnits,
  releaseCanonicalPrReviewActionDispatch,
  releaseSupersededCanonicalPrReviewAction,
  retireCanonicalPrReviewActionsForPullRequest,
  runFactory,
  taskFactory,
  taskMessages,
  taskPullRequests,
  tasks,
  transitionCanonicalPrReviewDelivery,
  upsertPrReviewAutoPreference,
  userFactory,
  withCanonicalPrReviewAutoDispatchFence,
} from '../../server';
import { RunStatus } from '@roomote/types';

const CLAIM_AT = new Date('2099-01-01T00:00:00Z');

function claimForRepository(repository: string, now: Date = CLAIM_AT) {
  return claimDueCanonicalPrReviewDeliveries(now, { repository });
}

function eventInput(input: {
  repository: string;
  prNumber: number;
  eventKey: string;
  kind?: 'ci_failure' | 'review_comment' | 'review_summary';
  batchId?: string | null;
  headSha?: string;
  roomoteAuthored?: boolean;
  isSummary?: boolean;
  dueAt?: Date;
  observedAt?: Date;
}) {
  const kind = input.kind ?? 'review_comment';
  const observedAt = input.observedAt ?? new Date();
  return {
    eventKey: input.eventKey,
    sourceControlProvider: 'github' as const,
    repository: input.repository,
    prNumber: input.prNumber,
    prUrl: `https://github.com/${input.repository}/pull/${input.prNumber}`,
    event: {
      kind,
      authorLogin: input.roomoteAuthored ? 'roomote[bot]' : 'alice',
      providerEventId: input.eventKey,
      ...(input.headSha ? { reviewHeadSha: input.headSha } : {}),
      ...(input.roomoteAuthored ? { roomoteAuthored: true } : {}),
    },
    batchKind: input.roomoteAuthored
      ? ('roomote' as const)
      : ('human' as const),
    batchId: input.batchId ?? null,
    dueAt: input.dueAt ?? CLAIM_AT,
    observedAt,
    reviewHeadSha: input.headSha ?? null,
    roomoteAuthored: input.roomoteAuthored,
    isSummary: input.isSummary,
  };
}

async function associate(taskId: string, repository: string, prNumber: number) {
  await db.insert(taskPullRequests).values({
    taskId,
    sourceControlProvider: 'github',
    repository,
    prNumber,
    prUrl: `https://github.com/${repository}/pull/${prNumber}`,
  });
}

describe('canonical PR review notification ownership', () => {
  it('deduplicates one provider event into one unit membership and delivery', async () => {
    const task = await taskFactory.create();
    const repository = `owner/canonical-dedupe-${task.id}`;
    await associate(task.id, repository, 1);
    const input = eventInput({
      repository,
      prNumber: 1,
      eventKey: `event-${task.id}`,
    });

    await Promise.all([
      persistPrReviewEvent(input),
      persistPrReviewEvent(input),
    ]);

    const [unit] = await db
      .select()
      .from(prReviewNotificationUnits)
      .where(eq(prReviewNotificationUnits.repository, repository));
    expect(unit).toBeDefined();
    expect(
      await db
        .select()
        .from(prReviewNotificationUnitEvents)
        .where(eq(prReviewNotificationUnitEvents.unitId, unit!.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(prReviewNotificationDeliveries)
        .where(eq(prReviewNotificationDeliveries.notificationUnitId, unit!.id)),
    ).toHaveLength(1);
  });

  it('coalesces CI-first activity into the sole unsealed Roomote cycle', async () => {
    const task = await taskFactory.create();
    const repository = `owner/ci-first-${task.id}`;
    await associate(task.id, repository, 2);
    const observedAt = new Date();
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 2,
        eventKey: `ci-${task.id}`,
        kind: 'ci_failure',
        headSha: 'same-head',
        observedAt,
      }),
    );
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 2,
        eventKey: `summary-${task.id}`,
        kind: 'review_summary',
        batchId: 'cycle-1',
        headSha: 'same-head',
        roomoteAuthored: true,
        isSummary: true,
        observedAt: new Date(observedAt.getTime() + 1_000),
      }),
    );

    const units = await db
      .select()
      .from(prReviewNotificationUnits)
      .where(eq(prReviewNotificationUnits.repository, repository));
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      episodeKind: 'roomote_cycle',
      episodeId: 'cycle-1',
    });
    expect(
      await db
        .select()
        .from(prReviewNotificationUnitEvents)
        .where(eq(prReviewNotificationUnitEvents.unitId, units[0]!.id)),
    ).toHaveLength(2);
    expect(
      await db
        .select()
        .from(prReviewNotificationDeliveries)
        .where(
          eq(prReviewNotificationDeliveries.notificationUnitId, units[0]!.id),
        ),
    ).toHaveLength(1);
  });

  it('promotes a provisional Roomote cycle for immediate canonical delivery', async () => {
    const task = await taskFactory.create();
    const repository = `owner/summary-promotion-${task.id}`;
    const inlineDueAt = new Date(CLAIM_AT.getTime() + 5 * 60 * 1000);
    await associate(task.id, repository, 16);

    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 16,
        eventKey: `inline-${task.id}`,
        batchId: 'cycle-1',
        headSha: 'same-head',
        roomoteAuthored: true,
        dueAt: inlineDueAt,
      }),
    );

    const [provisionalUnit] = await db
      .select()
      .from(prReviewNotificationUnits)
      .where(eq(prReviewNotificationUnits.repository, repository));
    const [provisionalDelivery] = await db
      .select()
      .from(prReviewNotificationDeliveries)
      .where(
        eq(
          prReviewNotificationDeliveries.notificationUnitId,
          provisionalUnit!.id,
        ),
      );
    expect(provisionalUnit?.dueAt).toEqual(inlineDueAt);
    expect(provisionalDelivery?.dueAt).toEqual(inlineDueAt);
    await expect(claimForRepository(repository, CLAIM_AT)).resolves.toEqual([]);

    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 16,
        eventKey: `summary-${task.id}`,
        kind: 'review_summary',
        batchId: 'cycle-1',
        headSha: 'same-head',
        roomoteAuthored: true,
        isSummary: true,
        dueAt: CLAIM_AT,
      }),
    );

    const units = await db
      .select()
      .from(prReviewNotificationUnits)
      .where(eq(prReviewNotificationUnits.repository, repository));
    const deliveries = await db
      .select()
      .from(prReviewNotificationDeliveries)
      .where(
        eq(prReviewNotificationDeliveries.notificationUnitId, units[0]!.id),
      );
    expect(units).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
    expect(units[0]).toMatchObject({
      id: provisionalUnit!.id,
      dueAt: CLAIM_AT,
    });
    expect(deliveries[0]).toMatchObject({
      id: provisionalDelivery!.id,
      dueAt: CLAIM_AT,
    });
    await expect(claimForRepository(repository, CLAIM_AT)).resolves.toEqual([
      expect.objectContaining({
        ownershipVersion: 'canonical',
        deliveryId: provisionalDelivery!.id,
        notificationUnitId: provisionalUnit!.id,
        repository,
      }),
    ]);
  });

  it('keeps review and CI coalescing on its independent 15-minute window', async () => {
    const observedAt = new Date('2026-08-26T05:00:00.000Z');

    for (const [suffix, ciOffsetMs, expectedUnits] of [
      ['inside', 15 * 60 * 1000 - 1, 1],
      ['outside', 15 * 60 * 1000 + 1, 2],
    ] as const) {
      const task = await taskFactory.create();
      const repository = `owner/ci-window-${suffix}-${task.id}`;
      await associate(task.id, repository, suffix === 'inside' ? 14 : 15);
      await persistPrReviewEvent(
        eventInput({
          repository,
          prNumber: suffix === 'inside' ? 14 : 15,
          eventKey: `summary-${suffix}-${task.id}`,
          kind: 'review_summary',
          batchId: `cycle-${suffix}`,
          headSha: 'same-head',
          roomoteAuthored: true,
          isSummary: true,
          observedAt,
        }),
      );
      await persistPrReviewEvent(
        eventInput({
          repository,
          prNumber: suffix === 'inside' ? 14 : 15,
          eventKey: `ci-${suffix}-${task.id}`,
          kind: 'ci_failure',
          headSha: 'same-head',
          observedAt: new Date(observedAt.getTime() + ciOffsetMs),
        }),
      );

      await expect(
        db
          .select({ id: prReviewNotificationUnits.id })
          .from(prReviewNotificationUnits)
          .where(eq(prReviewNotificationUnits.repository, repository)),
      ).resolves.toHaveLength(expectedUnits);
    }
  });

  it('keeps the same episode id separate across head SHAs', async () => {
    const task = await taskFactory.create();
    const repository = `owner/head-identity-${task.id}`;
    await associate(task.id, repository, 11);
    for (const headSha of ['head-a', 'head-b']) {
      await persistPrReviewEvent(
        eventInput({
          repository,
          prNumber: 11,
          eventKey: `${headSha}-${task.id}`,
          kind: 'review_summary',
          batchId: 'same-cycle-id',
          headSha,
          roomoteAuthored: true,
          isSummary: true,
        }),
      );
    }

    const units = await db
      .select({
        headSha: prReviewNotificationUnits.headSha,
        headIdentityKey: prReviewNotificationUnits.headIdentityKey,
      })
      .from(prReviewNotificationUnits)
      .where(eq(prReviewNotificationUnits.repository, repository));
    expect(units).toEqual(
      expect.arrayContaining([
        { headSha: 'head-a', headIdentityKey: 'head-a' },
        { headSha: 'head-b', headIdentityKey: 'head-b' },
      ]),
    );
  });

  it('maps sibling Fast tasks to one conversation destination', async () => {
    const first = await taskFactory.create();
    const second = await taskFactory.create();
    const repository = `owner/fast-destination-${first.id}`;
    const parent = {
      sessionId: '11111111-1111-4111-8111-111111111111',
      conversation: {
        surface: 'slack' as const,
        workspaceId: 'T123',
        conversationId: 'C123:111.222',
        replyTarget: { channelId: 'C123', threadId: '111.222' },
      },
    };
    await Promise.all([
      runFactory.create({
        taskId: first.id,
        payload: { fastAgentParent: parent },
      }),
      runFactory.create({
        taskId: second.id,
        payload: { fastAgentParent: parent },
      }),
      associate(first.id, repository, 3),
      associate(second.id, repository, 3),
    ]);

    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 3,
        eventKey: `fast-${first.id}`,
      }),
    );

    const [unit] = await db
      .select()
      .from(prReviewNotificationUnits)
      .where(eq(prReviewNotificationUnits.repository, repository));
    const deliveries = await db
      .select()
      .from(prReviewNotificationDeliveries)
      .where(eq(prReviewNotificationDeliveries.notificationUnitId, unit!.id));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      destinationKind: 'fast_conversation',
      destinationKey: '["slack","T123","C123:111.222"]',
      routeProvider: 'slack',
      routeChannelId: 'C123',
      routeThreadId: '111.222',
    });
  });

  it('allows one concurrent lease and rejects a stale completion fence', async () => {
    const task = await taskFactory.create();
    const repository = `owner/fenced-claim-${task.id}`;
    await associate(task.id, repository, 4);
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 4,
        eventKey: `fence-${task.id}`,
      }),
    );

    const concurrent = (
      await Promise.all([
        claimForRepository(repository),
        claimForRepository(repository),
      ])
    )
      .flat()
      .filter(
        ({ repository: claimedRepository }) => claimedRepository === repository,
      );
    expect(concurrent).toHaveLength(1);
    const first = concurrent[0]!;
    expect(first.ownershipVersion).toBe('canonical');
    if (first.ownershipVersion !== 'canonical') throw new Error('canonical');

    await db
      .update(prReviewNotificationDeliveries)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(prReviewNotificationDeliveries.id, first.deliveryId));
    const second = (await claimForRepository(repository)).find(
      ({ repository: claimedRepository }) => claimedRepository === repository,
    )!;
    expect(second.ownershipVersion).toBe('canonical');
    if (second.ownershipVersion !== 'canonical') throw new Error('canonical');

    await expect(
      transitionCanonicalPrReviewDelivery({
        deliveryId: first.deliveryId,
        leaseToken: first.leaseToken,
        expected: 'claimed',
        status: 'prepared',
      }),
    ).resolves.toBe(false);
    await expect(
      transitionCanonicalPrReviewDelivery({
        deliveryId: second.deliveryId,
        leaseToken: second.leaseToken,
        expected: 'claimed',
        status: 'prepared',
      }),
    ).resolves.toBe(true);
  });

  it('does not seal while ingestion owns the PR advisory lock', async () => {
    const task = await taskFactory.create();
    const repository = `owner/ingestion-lock-${task.id}`;
    await associate(task.id, repository, 12);
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 12,
        eventKey: `lock-${task.id}`,
      }),
    );

    await db.transaction(async (tx) => {
      await lockPrReviewReference(tx, 'github', repository, 12);
      await expect(claimForRepository(repository)).resolves.toEqual([]);
      await expect(
        tx.query.prReviewNotificationUnits.findFirst({
          where: eq(prReviewNotificationUnits.repository, repository),
          columns: { sealedAt: true },
        }),
      ).resolves.toEqual({ sealedAt: null });
    });

    await expect(claimForRepository(repository)).resolves.toEqual([
      expect.objectContaining({
        ownershipVersion: 'canonical',
        repository,
      }),
    ]);
  });

  it('does not attach later events to a sealed unit', async () => {
    const task = await taskFactory.create();
    const repository = `owner/sealed-unit-${task.id}`;
    await associate(task.id, repository, 5);
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 5,
        eventKey: `first-${task.id}`,
        batchId: 'review-1',
      }),
    );
    await claimForRepository(repository);
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 5,
        eventKey: `late-${task.id}`,
        batchId: 'review-1',
      }),
    );

    const units = await db
      .select()
      .from(prReviewNotificationUnits)
      .where(
        and(
          eq(prReviewNotificationUnits.repository, repository),
          eq(prReviewNotificationUnits.prNumber, 5),
        ),
      );
    expect(units).toHaveLength(2);
    expect(units.map(({ episodeId }) => episodeId)).toEqual(
      expect.arrayContaining([
        'review-1',
        expect.stringMatching(/^review-1:late:/),
      ]),
    );
  });

  it('reclaims deferred automatic work with the same delivery identity', async () => {
    const task = await taskFactory.create();
    const repository = `owner/deferred-canonical-${task.id}`;
    await associate(task.id, repository, 8);
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 8,
        eventKey: `deferred-${task.id}`,
      }),
    );
    const first = (await claimForRepository(repository)).find(
      ({ repository: claimedRepository }) => claimedRepository === repository,
    );
    expect(first?.ownershipVersion).toBe('canonical');
    if (!first || first.ownershipVersion !== 'canonical') {
      throw new Error('expected canonical claim');
    }
    await transitionCanonicalPrReviewDelivery({
      deliveryId: first.deliveryId,
      leaseToken: first.leaseToken,
      expected: 'claimed',
      status: 'auto_dispatch_pending',
      values: {
        followUpPrompt: 'Resolve feedback.',
        targetTaskId: task.id,
      },
    });
    const dueAt = new Date(CLAIM_AT.getTime() + 60_000);
    await deferPrReviewDeliveries(first, dueAt);

    expect(
      (
        await claimForRepository(repository, new Date(dueAt.getTime() - 1))
      ).some(
        ({ repository: claimedRepository }) => claimedRepository === repository,
      ),
    ).toBe(false);
    const reclaimed = (await claimForRepository(repository, dueAt)).find(
      ({ repository: claimedRepository }) => claimedRepository === repository,
    );
    expect(reclaimed).toMatchObject({
      ownershipVersion: 'canonical',
      deliveryId: first.deliveryId,
      state: 'auto_dispatch_pending',
      followUpPrompt: 'Resolve feedback.',
      targetTaskId: task.id,
    });
  });

  it('preserves prepared state across lease reclaim', async () => {
    const task = await taskFactory.create();
    const repository = `owner/prepared-reclaim-${task.id}`;
    await associate(task.id, repository, 9);
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 9,
        eventKey: `prepared-${task.id}`,
      }),
    );
    const first = (await claimForRepository(repository)).find(
      ({ repository: claimedRepository }) => claimedRepository === repository,
    );
    if (!first || first.ownershipVersion !== 'canonical') {
      throw new Error('expected canonical claim');
    }
    await transitionCanonicalPrReviewDelivery({
      deliveryId: first.deliveryId,
      leaseToken: first.leaseToken,
      expected: 'claimed',
      status: 'prepared',
      values: { followUpPrompt: 'Resolve feedback.' },
    });
    await db
      .update(prReviewNotificationDeliveries)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(prReviewNotificationDeliveries.id, first.deliveryId));

    const reclaimed = (await claimForRepository(repository)).find(
      ({ repository: claimedRepository }) => claimedRepository === repository,
    );
    expect(reclaimed).toMatchObject({
      ownershipVersion: 'canonical',
      deliveryId: first.deliveryId,
      state: 'prepared',
      followUpPrompt: 'Resolve feedback.',
    });
  });

  it('suppresses a delivery whose unit has no live events', async () => {
    const task = await taskFactory.create();
    const repository = `owner/superseded-unit-${task.id}`;
    await associate(task.id, repository, 10);
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 10,
        eventKey: `superseded-${task.id}`,
      }),
    );
    await db
      .update(prReviewEvents)
      .set({ superseded: true })
      .where(eq(prReviewEvents.repository, repository));

    expect(
      (await claimForRepository(repository)).some(
        ({ repository: claimedRepository }) => claimedRepository === repository,
      ),
    ).toBe(false);
    const [unit] = await db
      .select({ id: prReviewNotificationUnits.id })
      .from(prReviewNotificationUnits)
      .where(eq(prReviewNotificationUnits.repository, repository));
    await expect(
      db.query.prReviewNotificationDeliveries.findFirst({
        where: eq(prReviewNotificationDeliveries.notificationUnitId, unit!.id),
        columns: { status: true },
      }),
    ).resolves.toEqual({ status: 'suppressed' });
  });

  it('falls back only to a live task in the same Fast destination', async () => {
    const user = await userFactory.create();
    const source = await taskFactory.create({ initiatorUserId: user.id });
    const replacement = await taskFactory.create({ initiatorUserId: user.id });
    const unrelated = await taskFactory.create({ initiatorUserId: user.id });
    const repository = `owner/preference-${source.id}`;
    const sharedParent = {
      sessionId: '22222222-2222-4222-8222-222222222222',
      conversation: {
        surface: 'slack' as const,
        workspaceId: 'T-pref',
        conversationId: 'C-pref:1',
        replyTarget: { channelId: 'C-pref', threadId: '1' },
      },
    };
    const unrelatedParent = {
      ...sharedParent,
      conversation: {
        ...sharedParent.conversation,
        conversationId: 'C-pref:other',
        replyTarget: { channelId: 'C-pref', threadId: 'other' },
      },
    };
    await Promise.all([
      associate(source.id, repository, 6),
      associate(replacement.id, repository, 6),
      associate(unrelated.id, repository, 6),
      runFactory.create({
        taskId: source.id,
        payload: { fastAgentParent: sharedParent },
      }),
      runFactory.create({
        taskId: replacement.id,
        payload: { fastAgentParent: sharedParent },
      }),
      runFactory.create({
        taskId: unrelated.id,
        payload: { fastAgentParent: unrelatedParent },
      }),
    ]);
    await db.insert(taskPullRequests).values({
      taskId: source.id,
      sourceControlProvider: 'gitlab',
      repository,
      prNumber: 6,
      prUrl: `https://gitlab.com/${repository}/-/merge_requests/6`,
    });
    await upsertPrReviewAutoPreference({
      sourceControlProvider: 'github',
      repository,
      prNumber: 6,
      enabledByUserId: user.id,
      sourceTaskId: source.id,
      sourceDestinationKey: '["slack","T-pref","C-pref:1"]',
    });
    await expect(
      db.query.taskPullRequests.findFirst({
        where: and(
          eq(taskPullRequests.taskId, source.id),
          eq(taskPullRequests.sourceControlProvider, 'gitlab'),
          eq(taskPullRequests.repository, repository),
          eq(taskPullRequests.prNumber, 6),
        ),
        columns: { autoHandleFeedbackByUserId: true },
      }),
    ).resolves.toEqual({ autoHandleFeedbackByUserId: null });
    await db.delete(tasks).where(eq(tasks.id, source.id));

    await expect(
      findPrReviewAutoPreference({
        sourceControlProvider: 'github',
        repository,
        prNumber: 6,
      }),
    ).resolves.toEqual({
      taskId: replacement.id,
      userId: user.id,
      destinationKey: '["slack","T-pref","C-pref:1"]',
    });
  });

  it('preserves a PR auto preference while its source task is between resumable states', async () => {
    const user = await userFactory.create();
    const source = await taskFactory.create({ initiatorUserId: user.id });
    const repository = `owner/temporarily-unavailable-preference-${source.id}`;
    await associate(source.id, repository, 6);
    await runFactory.create({
      taskId: source.id,
      status: RunStatus.Completed,
      snapshotId: null,
    });
    await upsertPrReviewAutoPreference({
      sourceControlProvider: 'github',
      repository,
      prNumber: 6,
      enabledByUserId: user.id,
      sourceTaskId: source.id,
    });

    await expect(
      findPrReviewAutoPreference({
        sourceControlProvider: 'github',
        repository,
        prNumber: 6,
      }),
    ).resolves.toEqual({
      taskId: source.id,
      userId: user.id,
      destinationKey: null,
    });
  });

  it('does not preserve a PR auto preference for a canceled source task', async () => {
    const user = await userFactory.create();
    const source = await taskFactory.create({ initiatorUserId: user.id });
    const repository = `owner/canceled-preference-${source.id}`;
    await associate(source.id, repository, 6);
    await runFactory.create({
      taskId: source.id,
      status: RunStatus.Canceled,
      canceledAt: new Date(),
    });
    await upsertPrReviewAutoPreference({
      sourceControlProvider: 'github',
      repository,
      prNumber: 6,
      enabledByUserId: user.id,
      sourceTaskId: source.id,
    });

    await expect(
      findPrReviewAutoPreference({
        sourceControlProvider: 'github',
        repository,
        prNumber: 6,
      }),
    ).resolves.toBeNull();
  });

  it('claims through a resumable Fast sibling when the original task cannot resume', async () => {
    const original = await taskFactory.create();
    const sibling = await taskFactory.create();
    const repository = `owner/fast-resumable-sibling-${original.id}`;
    const parent = {
      sessionId: '33333333-3333-4333-8333-333333333333',
      conversation: {
        surface: 'slack' as const,
        workspaceId: 'T-sibling',
        conversationId: 'C-sibling:1',
        replyTarget: { channelId: 'C-sibling', threadId: '1' },
      },
    };
    await associate(original.id, repository, 13);
    await associate(sibling.id, repository, 13);
    await runFactory.create({
      taskId: original.id,
      status: RunStatus.Completed,
      snapshotId: null,
      payload: { fastAgentParent: parent },
    });
    await runFactory.create({
      taskId: sibling.id,
      status: RunStatus.Completed,
      snapshotId: 'snapshot-sibling',
      snapshotCreatedAt: new Date(),
      payload: { fastAgentParent: parent },
    });
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 13,
        eventKey: `sibling-${original.id}`,
      }),
    );
    const [deliveryBeforeClaim] = await db
      .select({ id: prReviewNotificationDeliveries.id })
      .from(prReviewNotificationDeliveries)
      .innerJoin(
        prReviewNotificationUnits,
        eq(
          prReviewNotificationUnits.id,
          prReviewNotificationDeliveries.notificationUnitId,
        ),
      )
      .where(eq(prReviewNotificationUnits.repository, repository));
    if (!deliveryBeforeClaim) throw new Error('expected canonical delivery');
    await db
      .update(prReviewNotificationDeliveries)
      .set({ taskId: original.id })
      .where(eq(prReviewNotificationDeliveries.id, deliveryBeforeClaim.id));

    await expect(claimForRepository(repository)).resolves.toEqual([
      expect.objectContaining({
        ownershipVersion: 'canonical',
        taskId: sibling.id,
        repository,
      }),
    ]);
    await expect(
      db.query.prReviewNotificationDeliveries.findFirst({
        where: eq(prReviewNotificationDeliveries.id, deliveryBeforeClaim.id),
        columns: { taskId: true },
      }),
    ).resolves.toEqual({ taskId: sibling.id });
  });

  it('claims one canonical action and upserts Fix all atomically', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({ initiatorUserId: user.id });
    const repository = `owner/action-${task.id}`;
    await associate(task.id, repository, 7);
    await db.insert(taskPullRequests).values({
      taskId: task.id,
      sourceControlProvider: 'gitlab',
      repository,
      prNumber: 7,
      prUrl: `https://gitlab.com/${repository}/-/merge_requests/7`,
    });
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 7,
        eventKey: `action-${task.id}`,
      }),
    );
    const claim = (await claimForRepository(repository)).find(
      ({ repository: claimedRepository }) => claimedRepository === repository,
    );
    expect(claim?.ownershipVersion).toBe('canonical');
    if (!claim || claim.ownershipVersion !== 'canonical') {
      throw new Error('expected canonical claim');
    }
    await transitionCanonicalPrReviewDelivery({
      deliveryId: claim.deliveryId,
      leaseToken: claim.leaseToken,
      expected: 'claimed',
      status: 'prepared',
    });
    await transitionCanonicalPrReviewDelivery({
      deliveryId: claim.deliveryId,
      leaseToken: claim.leaseToken,
      expected: 'prepared',
      status: 'prompt_posting',
      values: {
        followUpPrompt: 'Resolve the feedback.',
        routeProvider: 'slack',
        routeWorkspaceId: 'T-action',
        routeChannelId: 'C-action',
        routeThreadId: '1',
      },
    });
    await expect(
      attachCanonicalPrReviewActionMessage(
        claim.deliveryId,
        'stale-message',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ),
    ).resolves.toBe(false);
    await attachCanonicalPrReviewActionMessage(
      claim.deliveryId,
      '123.456',
      claim.leaseToken,
    );

    await expect(
      claimCanonicalPrReviewAction({
        deliveryId: claim.deliveryId,
        choice: 'auto',
        actingUserId: user.id,
        expectedSlackTeamId: 'T-action',
      }),
    ).resolves.toMatchObject({ taskId: task.id, repository, prNumber: 7 });
    await expect(
      completeCanonicalPrReviewActionDispatch({
        deliveryId: claim.deliveryId,
        runId: 123,
      }),
    ).resolves.toBe(true);
    await expect(
      claimCanonicalPrReviewAction({
        deliveryId: claim.deliveryId,
        choice: 'dismiss',
      }),
    ).resolves.toBeNull();
    await expect(
      db.query.prReviewNotificationDeliveries.findFirst({
        where: eq(prReviewNotificationDeliveries.id, claim.deliveryId),
        columns: { status: true, providerMessageId: true },
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      providerMessageId: '123.456',
    });
    await expect(
      db.query.prReviewAutoPreferences.findFirst({
        where: and(
          eq(prReviewAutoPreferences.repository, repository),
          eq(prReviewAutoPreferences.prNumber, 7),
        ),
      }),
    ).resolves.toMatchObject({
      enabledByUserId: user.id,
      sourceTaskId: task.id,
      sourceDestinationKey: task.id,
    });
    await expect(
      db.query.taskPullRequests.findFirst({
        where: and(
          eq(taskPullRequests.taskId, task.id),
          eq(taskPullRequests.sourceControlProvider, 'gitlab'),
          eq(taskPullRequests.repository, repository),
          eq(taskPullRequests.prNumber, 7),
        ),
        columns: { autoHandleFeedbackByUserId: true },
      }),
    ).resolves.toEqual({ autoHandleFeedbackByUserId: null });
  });

  it('authorizes and atomically claims a web Fast action by destination', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({ initiatorUserId: user.id });
    const repository = `owner/web-action-${task.id}`;
    const destinationKey = '["web","user-1","session-1"]';
    await Promise.all([
      runFactory.create({
        taskId: task.id,
        payload: {
          fastAgentParent: {
            sessionId: '11111111-1111-4111-8111-111111111111',
            conversation: {
              surface: 'web',
              workspaceId: 'user-1',
              conversationId: 'session-1',
            },
          },
        },
      }),
      associate(task.id, repository, 8),
    ]);
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 8,
        eventKey: `web-action-${task.id}`,
      }),
    );
    const claim = (await claimForRepository(repository)).find(
      ({ repository: claimedRepository }) => claimedRepository === repository,
    );
    expect(claim?.ownershipVersion).toBe('canonical');
    if (!claim || claim.ownershipVersion !== 'canonical') {
      throw new Error('expected canonical claim');
    }
    await transitionCanonicalPrReviewDelivery({
      deliveryId: claim.deliveryId,
      leaseToken: claim.leaseToken,
      expected: 'claimed',
      status: 'prepared',
    });
    await transitionCanonicalPrReviewDelivery({
      deliveryId: claim.deliveryId,
      leaseToken: claim.leaseToken,
      expected: 'prepared',
      status: 'prompt_posting',
      values: { followUpPrompt: 'Resolve the feedback.' },
    });
    await attachCanonicalPrReviewActionMessage(
      claim.deliveryId,
      claim.deliveryId,
      claim.leaseToken,
    );

    await expect(
      claimCanonicalPrReviewAction({
        deliveryId: claim.deliveryId,
        choice: 'yes',
        actingUserId: user.id,
        expectedDestinationKind: 'fast_conversation',
        expectedDestinationKey: '["web","other","session"]',
      }),
    ).resolves.toBeNull();
    await expect(
      claimCanonicalPrReviewAction({
        deliveryId: claim.deliveryId,
        choice: 'yes',
        actingUserId: user.id,
        expectedDestinationKind: 'fast_conversation',
        expectedDestinationKey: destinationKey,
      }),
    ).resolves.toMatchObject({ taskId: task.id });
    await expect(
      releaseCanonicalPrReviewActionDispatch(claim.deliveryId),
    ).resolves.toBe(true);
    await expect(
      db.query.prReviewNotificationDeliveries.findFirst({
        where: eq(prReviewNotificationDeliveries.id, claim.deliveryId),
        columns: { status: true, actingUserId: true, targetTaskId: true },
      }),
    ).resolves.toEqual({
      status: 'awaiting_user_action',
      actingUserId: null,
      targetTaskId: null,
    });
    const concurrent = await Promise.all([
      claimCanonicalPrReviewAction({
        deliveryId: claim.deliveryId,
        choice: 'yes',
        actingUserId: user.id,
        expectedDestinationKind: 'fast_conversation',
        expectedDestinationKey: destinationKey,
      }),
      claimCanonicalPrReviewAction({
        deliveryId: claim.deliveryId,
        choice: 'yes',
        actingUserId: user.id,
        expectedDestinationKind: 'fast_conversation',
        expectedDestinationKey: destinationKey,
      }),
    ]);
    expect(concurrent.filter(Boolean)).toHaveLength(1);
    expect(concurrent.find(Boolean)).toMatchObject({
      destinationKind: 'fast_conversation',
      destinationKey,
      taskId: task.id,
    });
  });

  const fastParentPayload = (conversationId: string) => ({
    fastAgentParent: {
      sessionId: '11111111-1111-4111-8111-111111111111',
      conversation: {
        surface: 'web' as const,
        workspaceId: 'user-1',
        conversationId,
      },
    },
  });

  const setUpSessionDelivery = async (input: {
    conversationId: string;
    prNumber: number;
  }) => {
    const task = await taskFactory.create();
    const repository = `owner/supersede-${task.id}`;
    await Promise.all([
      runFactory.create({
        taskId: task.id,
        payload: fastParentPayload(input.conversationId),
      }),
      associate(task.id, repository, input.prNumber),
    ]);
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: input.prNumber,
        eventKey: `supersede-${task.id}`,
      }),
    );
    return repository;
  };

  const claimToPromptPosting = async (repository: string) => {
    const claim = (await claimForRepository(repository)).find(
      ({ repository: claimedRepository }) => claimedRepository === repository,
    );
    if (!claim || claim.ownershipVersion !== 'canonical') {
      throw new Error('expected canonical claim');
    }
    await transitionCanonicalPrReviewDelivery({
      deliveryId: claim.deliveryId,
      leaseToken: claim.leaseToken,
      expected: 'claimed',
      status: 'prepared',
    });
    await transitionCanonicalPrReviewDelivery({
      deliveryId: claim.deliveryId,
      leaseToken: claim.leaseToken,
      expected: 'prepared',
      status: 'prompt_posting',
      values: { followUpPrompt: 'Resolve the feedback.' },
    });
    return claim;
  };

  const postAction = async (repository: string) => {
    const claim = await claimToPromptPosting(repository);
    await expect(
      attachCanonicalPrReviewActionMessage(
        claim.deliveryId,
        claim.deliveryId,
        claim.leaseToken,
      ),
    ).resolves.toBe(true);
    return claim.deliveryId;
  };

  const deliveryStatusOf = async (deliveryId: string) =>
    (
      await db.query.prReviewNotificationDeliveries.findFirst({
        where: eq(prReviewNotificationDeliveries.id, deliveryId),
        columns: { status: true },
      })
    )?.status;

  it('retires older awaiting actions in the same destination when a new one attaches', async () => {
    const sessionConversation = `supersede-session-${randomUUID()}`;
    const otherConversation = `supersede-other-${randomUUID()}`;

    const [first, second, other] = await Promise.all(
      [
        { conversationId: sessionConversation, prNumber: 21 },
        { conversationId: sessionConversation, prNumber: 22 },
        { conversationId: otherConversation, prNumber: 23 },
      ].map(setUpSessionDelivery),
    );

    const otherDeliveryId = await postAction(other!);
    const firstDeliveryId = await postAction(first!);

    // The rendered session card caches the offer status in the transcript
    // message payload; retirement must dismiss it there too.
    const user = await userFactory.create();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: user.id,
        conversationId: `supersede-transcript-${randomUUID()}`,
      })
      .returning();
    await db.insert(fastAgentMessages).values({
      conversationId: conversation!.id,
      eventId: 'turn-1:assistant:0',
      turnId: 'turn-1',
      turnSeq: 1,
      ts: 1,
      eventType: 'roomote_runtime.assistant_message',
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'Resolve these CI failures?' }],
      metadata: { visibleInTranscript: true },
      payload: {
        prReviewAction: { deliveryId: firstDeliveryId, status: 'pending' },
      },
      source: 'web',
    });

    const secondDeliveryId = await postAction(second!);

    // The newest offer in the session stays actionable; the older one is
    // retired, and a different conversation's offer is untouched.
    await expect(deliveryStatusOf(firstDeliveryId)).resolves.toBe('dismissed');
    await expect(deliveryStatusOf(secondDeliveryId)).resolves.toBe(
      'awaiting_user_action',
    );
    await expect(deliveryStatusOf(otherDeliveryId)).resolves.toBe(
      'awaiting_user_action',
    );
    await expect(
      db.query.fastAgentMessages.findFirst({
        where: eq(fastAgentMessages.conversationId, conversation!.id),
        columns: { payload: true },
      }),
    ).resolves.toMatchObject({
      payload: {
        prReviewAction: { deliveryId: firstDeliveryId, status: 'dismissed' },
      },
    });
  });

  it('retires only awaiting offers from older PR heads after a new commit', async () => {
    const task = await taskFactory.create();
    const run = await runFactory.create({ taskId: task.id });
    const repository = `owner/new-commit-${task.id}`;
    await associate(task.id, repository, 24);

    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 24,
        eventKey: `old-head-${task.id}`,
        headSha: 'old-head',
      }),
    );
    const oldDeliveryId = await postAction(repository);
    const user = await userFactory.create();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: user.id,
        conversationId: `new-commit-${randomUUID()}`,
      })
      .returning();
    await Promise.all([
      db.insert(fastAgentMessages).values({
        conversationId: conversation!.id,
        eventId: 'new-commit:assistant:0',
        turnId: 'new-commit',
        turnSeq: 1,
        ts: 1,
        eventType: 'roomote_runtime.assistant_message',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'Resolve this feedback?' }],
        metadata: { visibleInTranscript: true },
        payload: {
          prReviewAction: { deliveryId: oldDeliveryId, status: 'pending' },
        },
        source: 'web',
      }),
      db.insert(taskMessages).values({
        runId: run.id,
        taskId: task.id,
        ts: Date.now(),
        eventType: 'roomote_runtime.assistant_message',
        role: 'assistant',
        protocol: 'roomote_runtime',
        contentBlocks: [{ type: 'text', text: 'Resolve this feedback?' }],
        payload: {
          prReviewAction: { deliveryId: oldDeliveryId, status: 'pending' },
        },
      }),
    ]);

    await expect(
      retireCanonicalPrReviewActionsForPullRequest({
        sourceControlProvider: 'github',
        repository,
        prNumber: 24,
        currentHeadSha: 'new-head',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        deliveryId: oldDeliveryId,
        repository,
        prNumber: 24,
      }),
    ]);
    await expect(deliveryStatusOf(oldDeliveryId)).resolves.toBe('dismissed');
    await expect(
      db.query.fastAgentMessages.findFirst({
        where: eq(fastAgentMessages.conversationId, conversation!.id),
        columns: { payload: true },
      }),
    ).resolves.toMatchObject({
      payload: {
        prReviewAction: { deliveryId: oldDeliveryId, status: 'dismissed' },
      },
    });
    await expect(
      db.query.taskMessages.findFirst({
        where: eq(taskMessages.taskId, task.id),
        columns: { payload: true },
      }),
    ).resolves.toMatchObject({
      payload: {
        prReviewAction: { deliveryId: oldDeliveryId, status: 'dismissed' },
      },
    });

    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 24,
        eventKey: `new-head-${task.id}`,
        headSha: 'new-head',
      }),
    );
    const newDeliveryId = await postAction(repository);
    await expect(
      retireCanonicalPrReviewActionsForPullRequest({
        sourceControlProvider: 'github',
        repository,
        prNumber: 24,
        currentHeadSha: 'new-head',
      }),
    ).resolves.toEqual([]);
    await expect(deliveryStatusOf(newDeliveryId)).resolves.toBe(
      'awaiting_user_action',
    );
  });

  it('fences an older-head offer that is still posting', async () => {
    const task = await taskFactory.create();
    const repository = `owner/posting-new-commit-${task.id}`;
    await associate(task.id, repository, 25);
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 25,
        eventKey: `posting-old-head-${task.id}`,
        headSha: 'old-head',
      }),
    );
    const claim = await claimToPromptPosting(repository);

    await expect(
      retireCanonicalPrReviewActionsForPullRequest({
        sourceControlProvider: 'github',
        repository,
        prNumber: 25,
        currentHeadSha: 'new-head',
      }),
    ).resolves.toEqual([
      expect.objectContaining({ deliveryId: claim.deliveryId }),
    ]);
    await expect(deliveryStatusOf(claim.deliveryId)).resolves.toBe('dismissed');
    await expect(
      attachCanonicalPrReviewActionMessage(
        claim.deliveryId,
        'late-message',
        claim.leaseToken,
      ),
    ).resolves.toBe(false);
  });

  it.each(['claimed', 'prepared'] as const)(
    'fences an older-head delivery in the %s state without discarding it',
    async (state) => {
      const task = await taskFactory.create();
      const repository = `owner/${state}-new-commit-${task.id}`;
      await associate(task.id, repository, 26);
      await persistPrReviewEvent(
        eventInput({
          repository,
          prNumber: 26,
          eventKey: `${state}-old-head-${task.id}`,
          headSha: 'old-head',
        }),
      );
      const claim = (await claimForRepository(repository)).find(
        ({ repository: claimedRepository }) => claimedRepository === repository,
      );
      if (!claim || claim.ownershipVersion !== 'canonical') {
        throw new Error('expected canonical claim');
      }
      if (state === 'prepared') {
        await transitionCanonicalPrReviewDelivery({
          deliveryId: claim.deliveryId,
          leaseToken: claim.leaseToken,
          expected: 'claimed',
          status: 'prepared',
        });
      }

      await expect(
        retireCanonicalPrReviewActionsForPullRequest({
          sourceControlProvider: 'github',
          repository,
          prNumber: 26,
          currentHeadSha: 'new-head',
        }),
      ).resolves.toEqual([]);

      await expect(deliveryStatusOf(claim.deliveryId)).resolves.toBe(state);
      await expect(
        db.query.prReviewNotificationDeliveries.findFirst({
          where: eq(prReviewNotificationDeliveries.id, claim.deliveryId),
          columns: { actionClaimedAt: true },
        }),
      ).resolves.toEqual({ actionClaimedAt: expect.any(Date) });
      if (state === 'claimed') {
        await expect(
          transitionCanonicalPrReviewDelivery({
            deliveryId: claim.deliveryId,
            leaseToken: claim.leaseToken,
            expected: 'claimed',
            status: 'prepared',
          }),
        ).resolves.toBe(true);
      }
      await expect(
        transitionCanonicalPrReviewDelivery({
          deliveryId: claim.deliveryId,
          leaseToken: claim.leaseToken,
          expected: 'prepared',
          status: 'prompt_posting',
        }),
      ).resolves.toBe(false);
      await expect(
        transitionCanonicalPrReviewDelivery({
          deliveryId: claim.deliveryId,
          leaseToken: claim.leaseToken,
          expected: 'prepared',
          status: 'auto_dispatch_pending',
        }),
      ).resolves.toBe(false);
      await expect(deliveryStatusOf(claim.deliveryId)).resolves.toBe(
        'prepared',
      );
      await db
        .update(prReviewEvents)
        .set({ superseded: true })
        .where(eq(prReviewEvents.eventKey, `${state}-old-head-${task.id}`));
      await expect(
        releaseSupersededCanonicalPrReviewAction({
          deliveryId: claim.deliveryId,
          leaseToken: claim.leaseToken,
        }),
      ).resolves.toBe(true);
      await expect(claimForRepository(repository, CLAIM_AT)).resolves.toEqual([
        expect.objectContaining({
          deliveryId: claim.deliveryId,
          state: 'claimed',
          reviewActionSuperseded: true,
        }),
      ]);
    },
  );

  it('releases an automatic dispatch fenced before remediation starts', async () => {
    const task = await taskFactory.create();
    const repository = `owner/auto-dispatch-new-commit-${task.id}`;
    await associate(task.id, repository, 30);
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 30,
        eventKey: `auto-dispatch-old-head-${task.id}`,
        headSha: 'old-head',
      }),
    );
    const claim = (await claimForRepository(repository)).find(
      ({ repository: claimedRepository }) => claimedRepository === repository,
    );
    if (!claim || claim.ownershipVersion !== 'canonical') {
      throw new Error('expected canonical claim');
    }
    await transitionCanonicalPrReviewDelivery({
      deliveryId: claim.deliveryId,
      leaseToken: claim.leaseToken,
      expected: 'claimed',
      status: 'prepared',
    });
    await transitionCanonicalPrReviewDelivery({
      deliveryId: claim.deliveryId,
      leaseToken: claim.leaseToken,
      expected: 'prepared',
      status: 'auto_dispatch_pending',
    });

    await retireCanonicalPrReviewActionsForPullRequest({
      sourceControlProvider: 'github',
      repository,
      prNumber: 30,
      currentHeadSha: 'new-head',
    });
    await expect(
      releaseSupersededCanonicalPrReviewAction({
        deliveryId: claim.deliveryId,
        leaseToken: claim.leaseToken,
      }),
    ).resolves.toBe(true);
    await expect(claimForRepository(repository, CLAIM_AT)).resolves.toEqual([
      expect.objectContaining({
        deliveryId: claim.deliveryId,
        state: 'claimed',
        reviewActionSuperseded: true,
      }),
    ]);
  });

  it('suppresses a superseded ordinary automatic dispatch after its lease expires', async () => {
    const task = await taskFactory.create();
    const repository = `owner/superseded-auto-dispatch-${task.id}`;
    const eventKey = `superseded-auto-dispatch-${task.id}`;
    await associate(task.id, repository, 31);
    await persistPrReviewEvent(
      eventInput({ repository, prNumber: 31, eventKey }),
    );
    const claim = (await claimForRepository(repository)).find(
      ({ repository: claimedRepository }) => claimedRepository === repository,
    );
    if (!claim || claim.ownershipVersion !== 'canonical') {
      throw new Error('expected canonical claim');
    }
    await transitionCanonicalPrReviewDelivery({
      deliveryId: claim.deliveryId,
      leaseToken: claim.leaseToken,
      expected: 'claimed',
      status: 'prepared',
    });
    await transitionCanonicalPrReviewDelivery({
      deliveryId: claim.deliveryId,
      leaseToken: claim.leaseToken,
      expected: 'prepared',
      status: 'auto_dispatch_pending',
      values: { actionClaimedAt: CLAIM_AT },
    });
    await db
      .update(prReviewEvents)
      .set({ superseded: true })
      .where(eq(prReviewEvents.eventKey, eventKey));

    await expect(
      claimForRepository(
        repository,
        new Date(CLAIM_AT.getTime() + 11 * 60 * 1000),
      ),
    ).resolves.toEqual([]);
    await expect(deliveryStatusOf(claim.deliveryId)).resolves.toBe(
      'suppressed',
    );
  });

  it('holds the old-head retirement fence through automatic dispatch', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({ initiatorUserId: user.id });
    const repository = `owner/locked-auto-dispatch-${task.id}`;
    await associate(task.id, repository, 33);
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 33,
        eventKey: `locked-auto-dispatch-${task.id}`,
        headSha: 'old-head',
      }),
    );
    const claim = (await claimForRepository(repository)).find(
      ({ repository: claimedRepository }) => claimedRepository === repository,
    );
    if (!claim || claim.ownershipVersion !== 'canonical') {
      throw new Error('expected canonical claim');
    }
    await transitionCanonicalPrReviewDelivery({
      deliveryId: claim.deliveryId,
      leaseToken: claim.leaseToken,
      expected: 'claimed',
      status: 'prepared',
    });

    let releaseDispatch!: () => void;
    const dispatchBlocked = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    let dispatchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const order: string[] = [];
    const dispatch = withCanonicalPrReviewAutoDispatchFence(
      {
        deliveryId: claim.deliveryId,
        leaseToken: claim.leaseToken,
        followUpPrompt: 'Resolve the review feedback.',
        targetTaskId: task.id,
        actingUserId: user.id,
        routeProvider: 'slack',
        routeWorkspaceId: 'T123',
        routeChannelId: 'C123',
        routeThreadId: '111.222',
      },
      async () => {
        order.push('dispatch-start');
        dispatchStarted();
        await dispatchBlocked;
        order.push('dispatch-end');
        return 'queued';
      },
    );
    await started;

    const retirement = retireCanonicalPrReviewActionsForPullRequest({
      sourceControlProvider: 'github',
      repository,
      prNumber: 33,
      currentHeadSha: 'new-head',
    }).then((result) => {
      order.push('retirement-end');
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(order).toEqual(['dispatch-start']);

    releaseDispatch();
    await expect(dispatch).resolves.toEqual({
      acquired: true,
      result: 'queued',
    });
    await expect(retirement).resolves.toEqual([]);
    expect(order).toEqual(['dispatch-start', 'dispatch-end', 'retirement-end']);
  });

  it('leaves a pending older-head delivery for the reviewer text to be delivered', async () => {
    const task = await taskFactory.create();
    const repository = `owner/pending-new-commit-${task.id}`;
    await associate(task.id, repository, 27);
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 27,
        eventKey: `pending-old-head-${task.id}`,
        headSha: 'old-head',
      }),
    );
    const [delivery] = await db
      .select({ id: prReviewNotificationDeliveries.id })
      .from(prReviewNotificationDeliveries)
      .innerJoin(
        prReviewNotificationUnits,
        eq(
          prReviewNotificationUnits.id,
          prReviewNotificationDeliveries.notificationUnitId,
        ),
      )
      .where(eq(prReviewNotificationUnits.repository, repository));
    if (!delivery) throw new Error('expected a pending delivery');

    await expect(
      retireCanonicalPrReviewActionsForPullRequest({
        sourceControlProvider: 'github',
        repository,
        prNumber: 27,
        currentHeadSha: 'new-head',
      }),
    ).resolves.toEqual([]);
    await expect(deliveryStatusOf(delivery.id)).resolves.toBe('pending');
    await expect(claimForRepository(repository)).resolves.toEqual([
      expect.objectContaining({ deliveryId: delivery.id }),
    ]);
  });

  it('treats an abbreviated recorded head as current when it prefixes the live head', async () => {
    const task = await taskFactory.create();
    const repository = `owner/short-sha-${task.id}`;
    await associate(task.id, repository, 29);
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 29,
        eventKey: `short-sha-${task.id}`,
        headSha: 'abc1234',
      }),
    );
    const deliveryId = await postAction(repository);

    await expect(
      retireCanonicalPrReviewActionsForPullRequest({
        sourceControlProvider: 'github',
        repository,
        prNumber: 29,
        currentHeadSha: 'abc1234def5678901234567890abcdef12345678',
      }),
    ).resolves.toEqual([]);
    await expect(deliveryStatusOf(deliveryId)).resolves.toBe(
      'awaiting_user_action',
    );

    await expect(
      retireCanonicalPrReviewActionsForPullRequest({
        sourceControlProvider: 'github',
        repository,
        prNumber: 29,
        currentHeadSha: 'def5678abc1234567890abcdef1234567890abcd',
      }),
    ).resolves.toEqual([expect.objectContaining({ deliveryId })]);
    await expect(deliveryStatusOf(deliveryId)).resolves.toBe('dismissed');
  });

  it('leaves an awaiting offer whose unit has no recorded head', async () => {
    const task = await taskFactory.create();
    const repository = `owner/headless-new-commit-${task.id}`;
    await associate(task.id, repository, 28);
    await persistPrReviewEvent(
      eventInput({
        repository,
        prNumber: 28,
        eventKey: `headless-${task.id}`,
      }),
    );
    const deliveryId = await postAction(repository);

    await expect(
      retireCanonicalPrReviewActionsForPullRequest({
        sourceControlProvider: 'github',
        repository,
        prNumber: 28,
        currentHeadSha: 'new-head',
      }),
    ).resolves.toEqual([]);
    await expect(deliveryStatusOf(deliveryId)).resolves.toBe(
      'awaiting_user_action',
    );
  });

  it('keeps exactly one awaiting offer when two actions attach concurrently', async () => {
    const sessionConversation = `supersede-race-${randomUUID()}`;

    const [firstRepository, secondRepository] = await Promise.all(
      [
        { conversationId: sessionConversation, prNumber: 31 },
        { conversationId: sessionConversation, prNumber: 32 },
      ].map(setUpSessionDelivery),
    );
    const firstClaim = await claimToPromptPosting(firstRepository!);
    const secondClaim = await claimToPromptPosting(secondRepository!);

    await expect(
      Promise.all([
        attachCanonicalPrReviewActionMessage(
          firstClaim.deliveryId,
          firstClaim.deliveryId,
          firstClaim.leaseToken,
        ),
        attachCanonicalPrReviewActionMessage(
          secondClaim.deliveryId,
          secondClaim.deliveryId,
          secondClaim.leaseToken,
        ),
      ]),
    ).resolves.toEqual([true, true]);

    const statuses = await Promise.all(
      [firstClaim.deliveryId, secondClaim.deliveryId].map(deliveryStatusOf),
    );
    expect(statuses.filter((s) => s === 'awaiting_user_action')).toHaveLength(
      1,
    );
    expect(statuses.filter((s) => s === 'dismissed')).toHaveLength(1);
  });
});
