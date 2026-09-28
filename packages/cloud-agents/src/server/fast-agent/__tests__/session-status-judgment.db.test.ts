import {
  db,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  sessionFactory,
  sessionStatusJudgments,
  sessions,
  setDeploymentExperimentEnabled,
  taskFactory,
  sessionTasks,
  userFactory,
  tasks,
  users,
} from '@roomote/db/server';
import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

const { evaluateMock } = vi.hoisted(() => ({
  evaluateMock: vi.fn(),
}));

vi.mock('../../typesafe-judgment', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../typesafe-judgment')>();
  return { ...actual, evaluateTypeSafeJudgments: evaluateMock };
});

import {
  processSessionStatusJudgmentBatch,
  SESSION_STATUS_INACTIVITY_MS,
} from '../session-status-judgment';

const sessionIds: string[] = [];
const conversationIds: string[] = [];
const taskIds: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
  await setDeploymentExperimentEnabled('sessionStatusJudgment', false);
  evaluateMock.mockReset();
  while (sessionIds.length > 0) {
    await db.delete(sessions).where(eq(sessions.id, sessionIds.pop()!));
  }
  while (taskIds.length > 0) {
    await db.delete(tasks).where(eq(tasks.id, taskIds.pop()!));
  }
  while (conversationIds.length > 0) {
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, conversationIds.pop()!));
  }
  while (userIds.length > 0) {
    await db.delete(users).where(eq(users.id, userIds.pop()!));
  }
});

async function createSession(input: { fastConversationId?: string } = {}) {
  const user = await userFactory.create();
  userIds.push(user.id);
  const session = await sessionFactory.create({
    ownerKind: 'user',
    ownerUserId: user.id,
    cachedStatus: 'ready',
    fastConversationId: input.fastConversationId ?? null,
  });
  sessionIds.push(session.id);
  return { session, user };
}

function highConfidenceDone() {
  evaluateMock.mockResolvedValue({
    outcome: {
      type: 'choice',
      choice: 'done',
      confidence: 0.97,
      probabilities: {
        open: 0.01,
        done: 0.97,
        blocked: 0.01,
        needs_input: 0.01,
        unclear: 0,
      },
    },
  });
}

function highConfidenceNeedsInput() {
  evaluateMock.mockResolvedValue({
    outcome: {
      type: 'choice',
      choice: 'needs_input',
      confidence: 0.97,
      probabilities: {
        open: 0.01,
        done: 0.01,
        blocked: 0.01,
        needs_input: 0.97,
        unclear: 0,
      },
    },
  });
}

describe('processSessionStatusJudgmentBatch', () => {
  it('judges only visible transcript text and leaves cached runtime state unchanged', async () => {
    await setDeploymentExperimentEnabled('sessionStatusJudgment', true);
    const visibleUserTs = Date.now();
    const user = await userFactory.create();
    userIds.push(user.id);
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: user.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    conversationIds.push(conversation!.id);
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: user.id,
      cachedStatus: 'ready',
      fastConversationId: conversation!.id,
      title: 'Answer the question',
    });
    sessionIds.push(session.id);
    await db.insert(fastAgentMessages).values([
      {
        conversationId: conversation!.id,
        eventId: 'visible-user-event',
        turnId: 'visible-user-turn',
        turnSeq: 1,
        ts: visibleUserTs,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'What does this service do?' }],
        metadata: { visibleInTranscript: true, userId: user.id },
      },
      {
        conversationId: conversation!.id,
        eventId: 'hidden-event',
        turnId: 'hidden-turn',
        turnSeq: 2,
        ts: Date.now() + 1,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'hidden internal detail' }],
        metadata: { visibleInTranscript: false, userId: user.id },
      },
    ]);
    await db.insert(sessionStatusJudgments).values({
      sessionId: session.id,
      sourceEventId: 'turn-1',
      generation: 1,
      sourceKind: 'fast_turn',
      state: 'pending',
    });
    highConfidenceDone();

    await expect(processSessionStatusJudgmentBatch()).resolves.toBe(1);

    expect(evaluateMock).toHaveBeenCalledOnce();
    expect(evaluateMock).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'session-status-judgment' }),
    );
    const state = evaluateMock.mock.calls[0]?.[0].state as {
      latestVisibleUserMessageAt: string | null;
      recentMessages: Array<{ text: string }>;
    };
    expect(state.latestVisibleUserMessageAt).toBe(
      new Date(visibleUserTs).toISOString(),
    );
    expect(state.recentMessages.map((message) => message.text)).toEqual([
      'What does this service do?',
    ]);
    const [judgment] = await db
      .select()
      .from(sessionStatusJudgments)
      .where(eq(sessionStatusJudgments.sessionId, session.id));
    expect(judgment).toMatchObject({ state: 'applied', outcome: 'done' });
    const [persistedSession] = await db
      .select({ cachedStatus: sessions.cachedStatus })
      .from(sessions)
      .where(eq(sessions.id, session.id));
    expect(persistedSession?.cachedStatus).toBe('ready');
  });

  it('does not apply a done result while a linked task is active', async () => {
    await setDeploymentExperimentEnabled('sessionStatusJudgment', true);
    const { session } = await createSession();
    const childTasks = [];
    for (let index = 0; index < 13; index += 1) {
      const task = await taskFactory.create({ state: 'completed' });
      childTasks.push(task);
      taskIds.push(task.id);
    }
    const activeTask = [...childTasks].sort((left, right) =>
      left.id.localeCompare(right.id),
    )[12]!;
    await db
      .update(tasks)
      .set({ state: 'active' })
      .where(eq(tasks.id, activeTask.id));
    await db.insert(sessionTasks).values(
      childTasks.map((task) => ({
        sessionId: session.id,
        taskId: task.id,
        origin: 'direct_launch' as const,
      })),
    );
    await db.insert(sessionStatusJudgments).values({
      sessionId: session.id,
      sourceEventId: 'task-event',
      generation: 1,
      sourceKind: 'task_terminal',
      state: 'pending',
    });
    highConfidenceDone();

    await processSessionStatusJudgmentBatch();

    const [judgment] = await db
      .select()
      .from(sessionStatusJudgments)
      .where(eq(sessionStatusJudgments.sessionId, session.id));
    expect(judgment).toMatchObject({
      state: 'ignored',
      outcome: 'done',
      errorCode: 'live_work',
    });
  });

  it('applies inactivity done precedence over a needs-input judgment', async () => {
    await setDeploymentExperimentEnabled('sessionStatusJudgment', true);
    const user = await userFactory.create();
    userIds.push(user.id);
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: user.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    conversationIds.push(conversation!.id);
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: user.id,
      cachedStatus: 'ready',
      fastConversationId: conversation!.id,
    });
    sessionIds.push(session.id);
    await db.insert(fastAgentMessages).values({
      conversationId: conversation!.id,
      eventId: 'inactive-user-event',
      turnId: 'inactive-user-turn',
      turnSeq: 1,
      ts: Date.now() - SESSION_STATUS_INACTIVITY_MS,
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      role: 'user',
      contentBlocks: [{ type: 'text', text: 'Please investigate this.' }],
      metadata: { visibleInTranscript: true, userId: user.id },
    });
    await db.insert(sessionStatusJudgments).values({
      sessionId: session.id,
      sourceEventId: 'inactive-turn',
      generation: 1,
      sourceKind: 'fast_turn',
      state: 'pending',
    });
    highConfidenceNeedsInput();

    await processSessionStatusJudgmentBatch();

    const [judgment] = await db
      .select()
      .from(sessionStatusJudgments)
      .where(eq(sessionStatusJudgments.sessionId, session.id));
    expect(judgment).toMatchObject({
      state: 'applied',
      outcome: 'done',
      confidence: 1,
    });
  });

  it('marks an unconfigured judgment backend ignored without applying a status', async () => {
    await setDeploymentExperimentEnabled('sessionStatusJudgment', true);
    const { session } = await createSession();
    await db.insert(sessionStatusJudgments).values({
      sessionId: session.id,
      sourceEventId: 'turn-1',
      generation: 1,
      sourceKind: 'fast_turn',
      state: 'pending',
    });
    evaluateMock.mockResolvedValue(null);

    await processSessionStatusJudgmentBatch();

    const [judgment] = await db
      .select()
      .from(sessionStatusJudgments)
      .where(eq(sessionStatusJudgments.sessionId, session.id));
    expect(judgment).toMatchObject({
      state: 'ignored',
      errorCode: 'judgment_unconfigured',
    });
  });
});
