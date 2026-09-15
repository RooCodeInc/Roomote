import {
  db,
  eq,
  fastAgentConversations,
  sessionFactory,
  sessionGoals,
  sessions,
  userFactory,
  users,
} from '../server';

import {
  claimSessionGoalContinuation,
  getSessionGoal,
  getSessionGoalForConversation,
  markSessionGoal,
  replaceSessionGoal,
} from './session-goals';

describe('Session goals', () => {
  let userId: string;
  let conversationId: string;
  let sessionId: string;

  beforeEach(async () => {
    const user = await userFactory.create();
    userId = user.id;
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId,
        surface: 'web',
        workspaceId: userId,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    conversationId = conversation!.id;
    const session = await sessionFactory
      .params({
        ownerKind: 'user',
        ownerUserId: userId,
        sourceSurface: 'web',
        fastConversationId: conversationId,
      })
      .create();
    sessionId = session.id;
  });

  afterEach(async () => {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, conversationId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it('replaces the Session goal and can roll back a failed delivery', async () => {
    const first = await replaceSessionGoal({
      sessionId,
      userId,
      goal: { objective: 'ship one', maxContinuations: 5 },
    });
    const replacement = await replaceSessionGoal({
      sessionId,
      userId,
      goal: { objective: 'ship two', maxContinuations: 5 },
    });

    await expect(getSessionGoal(sessionId)).resolves.toMatchObject({
      objective: 'ship two',
      status: 'active',
    });
    await expect(replacement.rollback()).resolves.toBe(true);
    await expect(getSessionGoal(sessionId)).resolves.toMatchObject({
      objective: 'ship one',
      generation: first.goal.generation,
    });
  });

  it('advances continuation generations and fences stale completion', async () => {
    const activation = await replaceSessionGoal({
      sessionId,
      userId,
      goal: { objective: 'ship it', maxContinuations: 2 },
    });
    const claim = await claimSessionGoalContinuation({
      conversationId,
      continuationId: 'continuation-1',
    });

    expect(claim).toMatchObject({
      updated: true,
      goal: { continuationsUsed: 1, generation: 'continuation-1' },
    });
    await expect(
      markSessionGoal({
        sessionId,
        generation: 'unrelated-generation',
        status: 'complete',
      }),
    ).resolves.toMatchObject({ updated: false, reason: 'generation_mismatch' });
    await expect(
      markSessionGoal({
        sessionId,
        generation: activation.goal.generation,
        status: 'complete',
      }),
    ).resolves.toMatchObject({
      updated: true,
      goal: { status: 'complete' },
    });
  });

  it('resolves the goal from the Fast conversation', async () => {
    await replaceSessionGoal({
      sessionId,
      userId,
      goal: { objective: 'verify transport', maxContinuations: 5 },
    });

    await expect(
      getSessionGoalForConversation(conversationId),
    ).resolves.toMatchObject({ objective: 'verify transport' });
    await expect(
      db.query.sessionGoals.findFirst({
        where: eq(sessionGoals.sessionId, sessionId),
      }),
    ).resolves.toBeTruthy();
  });

  it('requires repeated blocker evidence across continuation turns', async () => {
    const activation = await replaceSessionGoal({
      sessionId,
      userId,
      goal: { objective: 'Reach the external service', maxContinuations: 5 },
    });
    let generation = activation.goal.generation;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const blocked = await markSessionGoal({
        sessionId,
        generation,
        status: 'blocked',
        reason: 'API access is required',
      });
      if (attempt < 3) {
        expect(blocked).toMatchObject({
          updated: false,
          reason: 'blocker_pending',
        });
        const claim = await claimSessionGoalContinuation({
          conversationId,
          continuationId: `continuation-${attempt}`,
        });
        expect(claim.updated).toBe(true);
        generation = claim.goal!.generation;
      } else {
        expect(blocked).toMatchObject({
          updated: true,
          goal: { status: 'blocked', blockedReason: 'API access is required' },
        });
      }
    }
  });

  it('limits continuation claims and supports explicit cancellation', async () => {
    await replaceSessionGoal({
      sessionId,
      userId,
      goal: { objective: 'Use one continuation', maxContinuations: 1 },
    });
    await expect(
      claimSessionGoalContinuation({
        conversationId,
        continuationId: 'continuation-1',
      }),
    ).resolves.toMatchObject({ updated: true });
    await expect(
      claimSessionGoalContinuation({
        conversationId,
        continuationId: 'continuation-2',
      }),
    ).resolves.toMatchObject({
      updated: false,
      reason: 'budget_exhausted',
      goal: { status: 'budget_limited' },
    });

    const replacement = await replaceSessionGoal({
      sessionId,
      userId,
      goal: { objective: 'Cancel this goal', maxContinuations: 5 },
    });
    await expect(
      markSessionGoal({
        sessionId,
        generation: replacement.goal.generation,
        status: 'canceled',
      }),
    ).resolves.toMatchObject({ updated: true, goal: { status: 'canceled' } });
  });
});
