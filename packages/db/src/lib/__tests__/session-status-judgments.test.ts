import {
  claimSessionStatusJudgmentRequests,
  completeSessionStatusJudgment,
  createSessionStatusJudgmentRequest,
  db,
  eq,
  pruneSessionStatusJudgmentHistory,
  sessionFactory,
  sessionStatusJudgments,
  sessions,
  setDeploymentExperimentEnabled,
  settleSessionStatusJudgmentTurn,
} from '../../server';

const sessionIds: string[] = [];

afterEach(async () => {
  await setDeploymentExperimentEnabled('sessionStatusJudgment', false);
  while (sessionIds.length > 0) {
    await db.delete(sessions).where(eq(sessions.id, sessionIds.pop()!));
  }
});

async function createSession() {
  const session = await sessionFactory.create({ cachedStatus: 'ready' });
  sessionIds.push(session.id);
  return session;
}

describe('Session status judgment requests', () => {
  it('deduplicates source events and marks an older generation stale', async () => {
    await setDeploymentExperimentEnabled('sessionStatusJudgment', true);
    const session = await createSession();
    const first = await createSessionStatusJudgmentRequest(db, {
      sessionId: session.id,
      sourceEventId: 'turn-1',
      sourceKind: 'fast_turn',
      state: 'pending',
    });
    const replay = await createSessionStatusJudgmentRequest(db, {
      sessionId: session.id,
      sourceEventId: 'turn-1',
      sourceKind: 'fast_turn',
      state: 'pending',
    });

    expect(replay?.id).toBe(first?.id);
    expect(replay?.generation).toBe(first?.generation);

    const second = await createSessionStatusJudgmentRequest(db, {
      sessionId: session.id,
      sourceEventId: 'turn-2',
      sourceKind: 'fast_turn',
      state: 'awaiting_settlement',
    });
    expect(second?.generation).toBeGreaterThan(first?.generation ?? 0);

    const rows = await db
      .select()
      .from(sessionStatusJudgments)
      .where(eq(sessionStatusJudgments.sessionId, session.id))
      .orderBy(sessionStatusJudgments.generation);
    expect(rows.map((row) => row.state)).toEqual([
      'stale',
      'awaiting_settlement',
    ]);

    const [updated] = await db
      .select({ cachedStatus: sessions.cachedStatus })
      .from(sessions)
      .where(eq(sessions.id, session.id));
    expect(updated?.cachedStatus).toBe('ready');
  });

  it('claims only settled current requests and rejects an old model response', async () => {
    await setDeploymentExperimentEnabled('sessionStatusJudgment', true);
    const session = await createSession();
    const first = await createSessionStatusJudgmentRequest(db, {
      sessionId: session.id,
      sourceEventId: 'turn-1',
      sourceKind: 'fast_turn',
      state: 'awaiting_settlement',
    });

    expect(await claimSessionStatusJudgmentRequests(db, 10)).toEqual([]);
    await settleSessionStatusJudgmentTurn(db, {
      sessionId: session.id,
      sourceEventId: 'turn-1',
      visible: true,
    });
    const [claimed] = await claimSessionStatusJudgmentRequests(db, 10);
    expect(claimed).toEqual(
      expect.objectContaining({
        id: first?.id,
        state: 'processing',
        attempts: 1,
      }),
    );

    await createSessionStatusJudgmentRequest(db, {
      sessionId: session.id,
      sourceEventId: 'turn-2',
      sourceKind: 'fast_turn',
      state: 'awaiting_settlement',
    });
    await expect(
      completeSessionStatusJudgment(db, {
        id: claimed!.id,
        sessionId: session.id,
        generation: claimed!.generation,
        state: 'applied',
        outcome: 'done',
        confidence: 0.98,
        probabilities: { done: 0.99 },
      }),
    ).resolves.toBe('stale');

    const [updated] = await db
      .select({ cachedStatus: sessions.cachedStatus })
      .from(sessions)
      .where(eq(sessions.id, session.id));
    expect(updated?.cachedStatus).toBe('ready');
  });

  it('discards a result if the deployment experiment is disabled mid-flight', async () => {
    await setDeploymentExperimentEnabled('sessionStatusJudgment', true);
    const session = await createSession();
    const [request] = await db
      .insert(sessionStatusJudgments)
      .values({
        sessionId: session.id,
        sourceEventId: 'turn-1',
        generation: 1,
        sourceKind: 'fast_turn',
        state: 'processing',
        attempts: 1,
      })
      .returning();

    await setDeploymentExperimentEnabled('sessionStatusJudgment', false);
    await expect(
      completeSessionStatusJudgment(db, {
        id: request!.id,
        sessionId: session.id,
        generation: 1,
        state: 'applied',
        outcome: 'done',
        confidence: 0.99,
        probabilities: { done: 1 },
      }),
    ).resolves.toBe('disabled');

    const [updatedRequest] = await db
      .select()
      .from(sessionStatusJudgments)
      .where(eq(sessionStatusJudgments.id, request!.id));
    expect(updatedRequest?.state).toBe('ignored');
    const [updatedSession] = await db
      .select({ cachedStatus: sessions.cachedStatus })
      .from(sessions)
      .where(eq(sessions.id, session.id));
    expect(updatedSession?.cachedStatus).toBe('ready');
  });

  it('prunes old terminal history while retaining the latest board projection', async () => {
    const session = await createSession();
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    await db.insert(sessionStatusJudgments).values([
      {
        sessionId: session.id,
        sourceEventId: 'old-turn',
        generation: 1,
        sourceKind: 'fast_turn',
        state: 'ignored',
        createdAt: oldDate,
        updatedAt: oldDate,
      },
      {
        sessionId: session.id,
        sourceEventId: 'current-turn',
        generation: 2,
        sourceKind: 'fast_turn',
        state: 'applied',
        outcome: 'done',
        confidence: 0.98,
      },
    ]);

    await expect(pruneSessionStatusJudgmentHistory(db)).resolves.toBe(1);
    const retained = await db
      .select()
      .from(sessionStatusJudgments)
      .where(eq(sessionStatusJudgments.sessionId, session.id));
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      sourceEventId: 'current-turn',
      outcome: 'done',
    });
  });
});
