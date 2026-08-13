import {
  claimDuePrReviewDeliveries,
  createDb,
  type DatabaseOrTransaction,
  db,
  eq,
  persistPrReviewEvent,
  persistPrReviewEventInTransaction,
  prReviewEventDeliveries,
  prReviewEvents,
  projectPendingPrReviewEventsForAssociation,
  recordPrReviewCycleState,
  releasePrReviewDeliveries,
  renewPrReviewDeliveryClaim,
  sql,
  taskFactory,
  taskPullRequests,
} from '../../server';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function eventInput(repository: string, prNumber: number, eventKey: string) {
  return {
    eventKey,
    sourceControlProvider: 'github' as const,
    repository,
    prNumber,
    prUrl: `https://github.com/${repository}/pull/${prNumber}`,
    event: {
      kind: 'review_comment',
      authorLogin: 'alice',
      providerEventId: eventKey,
    },
    batchKind: 'human' as const,
    batchId: null,
    dueAt: new Date(),
    observedAt: new Date(),
  };
}

async function insertAssociation(
  executor: DatabaseOrTransaction,
  taskId: string,
  repository: string,
  prNumber: number,
) {
  await executor.insert(taskPullRequests).values({
    taskId,
    sourceControlProvider: 'github',
    repository,
    prNumber,
    prUrl: `https://github.com/${repository}/pull/${prNumber}`,
  });
  await projectPendingPrReviewEventsForAssociation(executor, {
    taskId,
    sourceControlProvider: 'github',
    repository,
    prNumber,
  });
}

async function associate(taskId: string, repository: string, prNumber: number) {
  await db.transaction((tx) =>
    insertAssociation(tx, taskId, repository, prNumber),
  );
}

async function transactionPid(executor: DatabaseOrTransaction) {
  const [row] = await executor.execute<{ pid: number }>(
    sql`select pg_backend_pid()::integer as pid`,
  );
  return row!.pid;
}

async function isWaitingForAdvisoryLock(pid: number) {
  const [row] = await db.execute<{ waiting: boolean }>(sql`
    select exists (
      select 1 from pg_stat_activity
      where pid = ${pid}
        and wait_event_type = 'Lock'
        and wait_event = 'advisory'
    ) as waiting
  `);
  return row?.waiting ?? false;
}

describe('durable PR review events', () => {
  it('projects exactly once when the event commits before association', async () => {
    const task = await taskFactory.create();
    const repository = `owner/event-first-${task.id}`;
    await persistPrReviewEvent(
      eventInput(repository, 1, `event-first-${task.id}`),
    );
    await associate(task.id, repository, 1);

    expect(
      await db
        .select()
        .from(prReviewEventDeliveries)
        .where(eq(prReviewEventDeliveries.taskId, task.id)),
    ).toHaveLength(1);
  });

  it('projects exactly once when association commits before the event', async () => {
    const task = await taskFactory.create();
    const repository = `owner/association-first-${task.id}`;
    await associate(task.id, repository, 2);
    await persistPrReviewEvent(
      eventInput(repository, 2, `association-first-${task.id}`),
    );

    expect(
      await db
        .select()
        .from(prReviewEventDeliveries)
        .where(eq(prReviewEventDeliveries.taskId, task.id)),
    ).toHaveLength(1);
  });

  it('preserves the event when association overlaps an uncommitted event', async () => {
    const eventDb = createDb(process.env.DATABASE_URL!);
    const associationDb = createDb(process.env.DATABASE_URL!);
    const task = await taskFactory.create();
    const repository = `owner/overlap-event-${task.id}`;
    const eventReady = deferred();
    const commitEvent = deferred();
    const associationStarted = deferred();

    const eventTransaction = eventDb.transaction(async (tx) => {
      await persistPrReviewEventInTransaction(
        tx,
        eventInput(repository, 3, `overlap-event-${task.id}`),
      );
      eventReady.resolve();
      await commitEvent.promise;
    });
    await eventReady.promise;

    let associationPid!: number;
    const associationTransaction = associationDb.transaction(async (tx) => {
      associationPid = await transactionPid(tx);
      associationStarted.resolve();
      await insertAssociation(tx, task.id, repository, 3);
    });

    await associationStarted.promise;
    await expect
      .poll(() => isWaitingForAdvisoryLock(associationPid))
      .toBe(true);
    commitEvent.resolve();
    await Promise.all([eventTransaction, associationTransaction]);

    expect(
      await db
        .select()
        .from(prReviewEventDeliveries)
        .where(eq(prReviewEventDeliveries.taskId, task.id)),
    ).toHaveLength(1);
  });

  it('preserves the event when ingestion overlaps an uncommitted association', async () => {
    const eventDb = createDb(process.env.DATABASE_URL!);
    const associationDb = createDb(process.env.DATABASE_URL!);
    const task = await taskFactory.create();
    const repository = `owner/overlap-association-${task.id}`;
    const associationReady = deferred();
    const commitAssociation = deferred();
    const eventStarted = deferred();

    const associationTransaction = associationDb.transaction(async (tx) => {
      await insertAssociation(tx, task.id, repository, 4);
      associationReady.resolve();
      await commitAssociation.promise;
    });
    await associationReady.promise;

    let eventPid!: number;
    const eventTransaction = eventDb.transaction(async (tx) => {
      eventPid = await transactionPid(tx);
      eventStarted.resolve();
      await persistPrReviewEventInTransaction(
        tx,
        eventInput(repository, 4, `overlap-association-${task.id}`),
      );
    });

    await eventStarted.promise;
    await expect.poll(() => isWaitingForAdvisoryLock(eventPid)).toBe(true);
    commitAssociation.resolve();
    await Promise.all([associationTransaction, eventTransaction]);

    expect(
      await db
        .select()
        .from(prReviewEventDeliveries)
        .where(eq(prReviewEventDeliveries.taskId, task.id)),
    ).toHaveLength(1);
  });

  it('deduplicates duplicate webhooks and projections', async () => {
    const task = await taskFactory.create();
    const repository = `owner/dedupe-${task.id}`;
    await associate(task.id, repository, 5);
    const input = eventInput(repository, 5, `dedupe-${task.id}`);
    await Promise.all([
      persistPrReviewEvent(input),
      persistPrReviewEvent(input),
    ]);
    await db.transaction((tx) =>
      projectPendingPrReviewEventsForAssociation(tx, {
        taskId: task.id,
        sourceControlProvider: 'github',
        repository,
        prNumber: 5,
      }),
    );

    expect(
      await db
        .select()
        .from(prReviewEvents)
        .where(eq(prReviewEvents.eventKey, input.eventKey)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(prReviewEventDeliveries)
        .where(eq(prReviewEventDeliveries.taskId, task.id)),
    ).toHaveLength(1);
  });

  it('rolls back the association and projection together, then retries cleanly', async () => {
    const task = await taskFactory.create();
    const repository = `owner/association-rollback-${task.id}`;
    await persistPrReviewEvent(
      eventInput(repository, 54, `association-rollback-${task.id}`),
    );

    await expect(
      db.transaction(async (tx) => {
        await insertAssociation(tx, task.id, repository, 54);
        throw new Error('force association rollback');
      }),
    ).rejects.toThrow('force association rollback');

    expect(
      await db
        .select()
        .from(taskPullRequests)
        .where(eq(taskPullRequests.taskId, task.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(prReviewEventDeliveries)
        .where(eq(prReviewEventDeliveries.taskId, task.id)),
    ).toHaveLength(0);

    await associate(task.id, repository, 54);
    expect(
      await db
        .select()
        .from(taskPullRequests)
        .where(eq(taskPullRequests.taskId, task.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(prReviewEventDeliveries)
        .where(eq(prReviewEventDeliveries.taskId, task.id)),
    ).toHaveLength(1);
  });

  it('applies the 24-hour association window to observation time exactly', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = new Date('2030-01-02T12:00:00.000Z');
    vi.setSystemTime(now);

    try {
      const task = await taskFactory.create();
      const repository = `owner/window-${task.id}`;
      const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
      const inputs = [
        { key: `before-${task.id}`, observedAt: new Date(cutoff - 1) },
        { key: `at-${task.id}`, observedAt: new Date(cutoff) },
        { key: `after-${task.id}`, observedAt: new Date(cutoff + 1) },
      ];

      for (const input of inputs) {
        await persistPrReviewEvent({
          ...eventInput(repository, 55, input.key),
          // A future due time must not extend association eligibility.
          dueAt: new Date(now.getTime() + 15 * 60 * 1000),
          observedAt: input.observedAt,
        });
      }
      await associate(task.id, repository, 55);

      const events = await db
        .select({ id: prReviewEvents.id, eventKey: prReviewEvents.eventKey })
        .from(prReviewEvents)
        .where(eq(prReviewEvents.repository, repository));
      const deliveries = await db
        .select({ eventId: prReviewEventDeliveries.eventId })
        .from(prReviewEventDeliveries)
        .where(eq(prReviewEventDeliveries.taskId, task.id));
      const deliveredEventIds = new Set(
        deliveries.map(({ eventId }) => eventId),
      );

      expect(
        events
          .filter(({ id }) => deliveredEventIds.has(id))
          .map(({ eventKey }) => eventKey)
          .sort(),
      ).toEqual([`after-${task.id}`, `at-${task.id}`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fans one source event out once per associated task', async () => {
    const firstTask = await taskFactory.create();
    const secondTask = await taskFactory.create();
    const repository = `owner/multi-${firstTask.id}`;
    await associate(firstTask.id, repository, 6);
    await associate(secondTask.id, repository, 6);
    await persistPrReviewEvent(
      eventInput(repository, 6, `multi-${firstTask.id}`),
    );

    const deliveries = await db
      .select({ taskId: prReviewEventDeliveries.taskId })
      .from(prReviewEventDeliveries)
      .where(
        eq(
          prReviewEventDeliveries.eventId,
          (await db.query.prReviewEvents.findFirst({
            where: eq(prReviewEvents.eventKey, `multi-${firstTask.id}`),
          }))!.id,
        ),
      );
    expect(new Set(deliveries.map(({ taskId }) => taskId))).toEqual(
      new Set([firstTask.id, secondTask.id]),
    );
  });

  it('claims a due row once and reclaims only an expired lease', async () => {
    const task = await taskFactory.create();
    const repository = `owner/claim-${task.id}`;
    await associate(task.id, repository, 7);
    await persistPrReviewEvent(eventInput(repository, 7, `claim-${task.id}`));
    const [target] = await db
      .select({ id: prReviewEventDeliveries.id })
      .from(prReviewEventDeliveries)
      .where(eq(prReviewEventDeliveries.taskId, task.id));

    const claims = (
      await Promise.all([
        claimDuePrReviewDeliveries(),
        claimDuePrReviewDeliveries(),
      ])
    ).flat();
    expect(
      claims
        .flatMap(({ deliveryIds }) => deliveryIds)
        .filter((id) => id === target!.id),
    ).toHaveLength(1);

    await db
      .update(prReviewEventDeliveries)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(prReviewEventDeliveries.id, target!.id));
    const reclaimed = await claimDuePrReviewDeliveries();
    expect(reclaimed.flatMap(({ deliveryIds }) => deliveryIds)).toContain(
      target!.id,
    );
  });

  it('does not renew an expired or reclaimed delivery claim', async () => {
    const task = await taskFactory.create();
    const repository = `owner/renew-${task.id}`;
    await associate(task.id, repository, 56);
    await persistPrReviewEvent(eventInput(repository, 56, `renew-${task.id}`));
    const firstClaim = (await claimDuePrReviewDeliveries()).find(
      ({ taskId }) => taskId === task.id,
    )!;

    await db
      .update(prReviewEventDeliveries)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(prReviewEventDeliveries.id, firstClaim.deliveryIds[0]!));
    expect(await renewPrReviewDeliveryClaim(firstClaim)).toBe(false);

    const secondClaim = (await claimDuePrReviewDeliveries()).find(
      ({ taskId }) => taskId === task.id,
    )!;
    expect(secondClaim.leaseToken).not.toBe(firstClaim.leaseToken);
    expect(await renewPrReviewDeliveryClaim(firstClaim)).toBe(false);
    expect(await renewPrReviewDeliveryClaim(secondClaim)).toBe(true);
  });

  it('leaves a failed BullMQ wake pending for the next dispatcher', async () => {
    const task = await taskFactory.create();
    const repository = `owner/wake-${task.id}`;
    await associate(task.id, repository, 8);
    await persistPrReviewEvent(eventInput(repository, 8, `wake-${task.id}`));
    const claim = (await claimDuePrReviewDeliveries()).find(
      ({ taskId }) => taskId === task.id,
    )!;

    await releasePrReviewDeliveries(claim);
    expect(
      await db.query.prReviewEventDeliveries.findFirst({
        where: eq(prReviewEventDeliveries.id, claim.deliveryIds[0]!),
        columns: { status: true, leaseToken: true },
      }),
    ).toMatchObject({ status: 'pending', leaseToken: null });
    expect(
      (await claimDuePrReviewDeliveries()).flatMap(
        ({ deliveryIds }) => deliveryIds,
      ),
    ).toContain(claim.deliveryIds[0]);
  });

  it('claims an entire review batch larger than the claim limit exactly once', async () => {
    const task = await taskFactory.create();
    const repository = `owner/large-batch-${task.id}`;
    await associate(task.id, repository, 57);
    for (let index = 0; index < 101; index += 1) {
      await persistPrReviewEvent({
        ...eventInput(repository, 57, `large-batch-${task.id}-${index}`),
        batchId: 'large-batch',
        dueAt: new Date(0),
      });
    }

    const claims = (
      await Promise.all([
        claimDuePrReviewDeliveries(),
        claimDuePrReviewDeliveries(),
      ])
    )
      .flat()
      .filter(({ taskId }) => taskId === task.id);

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      batchId: 'large-batch',
      deliveryIds: expect.arrayContaining([expect.any(String)]),
    });
    expect(claims[0]!.deliveryIds).toHaveLength(101);
    expect(claims[0]!.events).toHaveLength(101);
    expect(
      (await claimDuePrReviewDeliveries()).filter(
        ({ taskId }) => taskId === task.id,
      ),
    ).toHaveLength(0);
  });

  it('suppresses same-SHA Roomote activity by observation time, not batch id', async () => {
    const task = await taskFactory.create();
    const repository = `owner/cycle-${task.id}`;
    await associate(task.id, repository, 9);
    await recordPrReviewCycleState({
      sourceControlProvider: 'github',
      repository,
      prNumber: 9,
      reviewHeadSha: 'abc123',
      cycleId: 'summary-batch',
      phase: 'open',
      observedAt: new Date(200),
    });
    await persistPrReviewEvent({
      ...eventInput(repository, 9, `inline-${task.id}`),
      event: {
        kind: 'review_comment',
        authorLogin: 'roomote[bot]',
        roomoteAuthored: true,
        batchId: 'inline-batch',
      },
      batchKind: 'roomote',
      batchId: 'inline-batch',
      reviewHeadSha: 'abc123',
      roomoteAuthored: true,
      observedAt: new Date(250),
    });
    await persistPrReviewEvent({
      ...eventInput(repository, 9, `summary-${task.id}`),
      event: {
        kind: 'review_summary',
        authorLogin: 'roomote[bot]',
        roomoteAuthored: true,
        batchId: 'summary-batch',
      },
      batchKind: 'roomote',
      batchId: 'summary-batch',
      reviewHeadSha: 'abc123',
      roomoteAuthored: true,
      isSummary: true,
      observedAt: new Date(300),
    });
    await persistPrReviewEvent({
      ...eventInput(repository, 9, `late-${task.id}`),
      event: {
        kind: 'review_comment',
        authorLogin: 'roomote[bot]',
        roomoteAuthored: true,
      },
      batchKind: 'roomote',
      batchId: null,
      reviewHeadSha: 'abc123',
      roomoteAuthored: true,
      observedAt: new Date(350),
    });

    const rows = await db
      .select({
        event: prReviewEvents.event,
        superseded: prReviewEvents.superseded,
      })
      .from(prReviewEvents)
      .where(eq(prReviewEvents.repository, repository));
    expect(rows.filter(({ event }) => event.kind === 'review_summary')).toEqual(
      [expect.objectContaining({ superseded: false })],
    );
    expect(
      rows
        .filter(({ event }) => event.kind === 'review_comment')
        .map(({ superseded }) => superseded)
        .sort(),
    ).toEqual([false, true]);
    const statuses = await db
      .select({ status: prReviewEventDeliveries.status })
      .from(prReviewEventDeliveries)
      .where(eq(prReviewEventDeliveries.taskId, task.id));
    expect(statuses.map(({ status }) => status).sort()).toEqual([
      'pending',
      'pending',
      'suppressed',
    ]);
  });

  it('completes the matching earlier review cycle after a newer same-SHA cycle opens', async () => {
    const task = await taskFactory.create();
    const repository = `owner/overlapping-cycles-${task.id}`;
    await associate(task.id, repository, 58);
    await recordPrReviewCycleState({
      sourceControlProvider: 'github',
      repository,
      prNumber: 58,
      reviewHeadSha: 'same-head',
      cycleId: 'cycle-a',
      phase: 'open',
      observedAt: new Date(100),
    });
    await persistPrReviewEvent({
      ...eventInput(repository, 58, `cycle-a-inline-${task.id}`),
      batchKind: 'roomote',
      batchId: null,
      reviewHeadSha: 'same-head',
      roomoteAuthored: true,
      observedAt: new Date(150),
    });
    await recordPrReviewCycleState({
      sourceControlProvider: 'github',
      repository,
      prNumber: 58,
      reviewHeadSha: 'same-head',
      cycleId: 'cycle-b',
      phase: 'open',
      observedAt: new Date(200),
    });
    await persistPrReviewEvent({
      ...eventInput(repository, 58, `cycle-b-inline-${task.id}`),
      batchKind: 'roomote',
      batchId: null,
      reviewHeadSha: 'same-head',
      roomoteAuthored: true,
      observedAt: new Date(225),
    });
    const summary = await persistPrReviewEvent({
      ...eventInput(repository, 58, `cycle-a-summary-${task.id}`),
      event: { kind: 'review_summary', roomoteAuthored: true },
      batchKind: 'roomote',
      batchId: null,
      reviewHeadSha: 'same-head',
      roomoteAuthored: true,
      isSummary: true,
      observedAt: new Date(175),
    });
    const lateCycleA = await persistPrReviewEvent({
      ...eventInput(repository, 58, `cycle-a-late-${task.id}`),
      batchKind: 'roomote',
      batchId: null,
      reviewHeadSha: 'same-head',
      roomoteAuthored: true,
      observedAt: new Date(160),
    });

    expect(summary.projectedTaskCount).toBe(1);
    expect(lateCycleA).toMatchObject({
      projectedTaskCount: 0,
      reason: 'review_cycle_completed',
    });
    const rows = await db
      .select({
        eventKey: prReviewEvents.eventKey,
        batchId: prReviewEvents.batchId,
        superseded: prReviewEvents.superseded,
      })
      .from(prReviewEvents)
      .where(eq(prReviewEvents.repository, repository));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventKey: `cycle-a-inline-${task.id}`,
          batchId: 'cycle-a',
          superseded: true,
        }),
        expect.objectContaining({
          eventKey: `cycle-b-inline-${task.id}`,
          batchId: 'cycle-b',
          superseded: false,
        }),
        expect.objectContaining({
          eventKey: `cycle-a-summary-${task.id}`,
          batchId: 'cycle-a',
          superseded: false,
        }),
      ]),
    );
    const statuses = await db
      .select({
        eventId: prReviewEventDeliveries.eventId,
        status: prReviewEventDeliveries.status,
      })
      .from(prReviewEventDeliveries)
      .where(eq(prReviewEventDeliveries.taskId, task.id));
    expect(statuses.map(({ status }) => status).sort()).toEqual([
      'pending',
      'pending',
      'suppressed',
    ]);
  });

  it('persists but never projects activity older than a completed same-SHA cycle', async () => {
    const task = await taskFactory.create();
    const repository = `owner/late-old-${task.id}`;
    await associate(task.id, repository, 10);
    await persistPrReviewEvent({
      ...eventInput(repository, 10, `summary-${task.id}`),
      event: {
        kind: 'review_summary',
        authorLogin: 'roomote[bot]',
        roomoteAuthored: true,
      },
      batchKind: 'roomote',
      batchId: 'cycle',
      reviewHeadSha: 'def456',
      roomoteAuthored: true,
      isSummary: true,
      observedAt: new Date(500),
    });
    const result = await persistPrReviewEvent({
      ...eventInput(repository, 10, `old-inline-${task.id}`),
      event: {
        kind: 'review_comment',
        authorLogin: 'roomote[bot]',
        roomoteAuthored: true,
      },
      batchKind: 'roomote',
      batchId: 'different-cycle',
      reviewHeadSha: 'def456',
      roomoteAuthored: true,
      observedAt: new Date(450),
    });

    expect(result).toMatchObject({
      projectedTaskCount: 0,
      reason: 'review_cycle_completed',
    });
    expect(
      await db
        .select()
        .from(prReviewEvents)
        .where(eq(prReviewEvents.eventKey, `old-inline-${task.id}`)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(prReviewEventDeliveries)
        .where(eq(prReviewEventDeliveries.taskId, task.id)),
    ).toHaveLength(1);
  });

  it('suppresses older activity when materializing a legacy completed cycle', async () => {
    const task = await taskFactory.create();
    const repository = `owner/legacy-cycle-${task.id}`;
    await associate(task.id, repository, 59);
    await recordPrReviewCycleState({
      sourceControlProvider: 'github',
      repository,
      prNumber: 59,
      reviewHeadSha: 'legacy-head',
      cycleId: 'legacy-cycle',
      phase: 'completed',
      observedAt: new Date(500),
    });

    const result = await persistPrReviewEvent({
      ...eventInput(repository, 59, `legacy-inline-${task.id}`),
      batchKind: 'roomote',
      batchId: 'legacy-inline-batch',
      reviewHeadSha: 'legacy-head',
      roomoteAuthored: true,
      observedAt: new Date(450),
    });

    expect(result).toMatchObject({
      projectedTaskCount: 0,
      reason: 'review_cycle_completed',
    });
  });
});
