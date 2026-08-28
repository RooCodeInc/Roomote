import {
  db,
  eq,
  fastAgentConversations,
  llmUsageEvents,
  recordLlmUsage,
  sessionFactory,
  sessionParticipants,
  sessions,
  sessionTasks,
  taskFactory,
  tasks,
  userFactory,
  users,
} from '../../server';

import {
  advanceSessionReadCursor,
  advanceSessionNotifiedCursor,
  deriveSessionStatus,
  ensureSessionForFastConversation,
  ensureSessionForTask,
  touchSessionActivity,
} from '../sessions';

const createdTaskIds: string[] = [];
const createdSessionIds: string[] = [];
const createdConversationIds: string[] = [];
const createdUserIds: string[] = [];

afterEach(async () => {
  if (createdSessionIds.length > 0) {
    await db.delete(sessions).where(eq(sessions.id, createdSessionIds.pop()!));
  }
  while (createdTaskIds.length > 0) {
    await db.delete(tasks).where(eq(tasks.id, createdTaskIds.pop()!));
  }
  while (createdConversationIds.length > 0) {
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, createdConversationIds.pop()!));
  }
  while (createdUserIds.length > 0) {
    await db.delete(users).where(eq(users.id, createdUserIds.pop()!));
  }
});

describe('deriveSessionStatus', () => {
  const task = (
    overrides: Partial<
      Parameters<typeof deriveSessionStatus>[0]['tasks'][number]
    > = {},
  ) => ({
    state: 'completed' as const,
    taskPhase: null,
    goalStatus: null,
    ...overrides,
  });

  it('prioritizes needs input over responding conversation and active work', () => {
    expect(
      deriveSessionStatus({
        conversationResponding: true,
        tasks: [task({ state: 'active', taskPhase: 'waiting_for_user_input' })],
      }),
    ).toBe('needs_input');
  });

  it.each([
    ['a responding conversation', true, [task()], 'active'],
    ['an active task', false, [task({ state: 'active' })], 'active'],
    ['a failed task', false, [task({ state: 'failed' })], 'blocked'],
    ['a blocked goal', false, [task({ goalStatus: 'blocked' })], 'blocked'],
    [
      'a budget-limited goal',
      false,
      [task({ goalStatus: 'budget_limited' })],
      'blocked',
    ],
    ['only settled work', false, [task()], 'ready'],
    ['no work', false, [], 'ready'],
  ] as const)('derives %s as %s', (_label, responding, taskRows, expected) => {
    expect(
      deriveSessionStatus({
        conversationResponding: responding,
        tasks: [...taskRows],
      }),
    ).toBe(expected);
  });

  it('prioritizes active work over blocked settled work', () => {
    expect(
      deriveSessionStatus({
        conversationResponding: false,
        tasks: [task({ state: 'failed' }), task({ state: 'active' })],
      }),
    ).toBe('active');
  });
});

describe('session helpers', () => {
  it('updates activity monotonically', async () => {
    const session = await sessionFactory.create({ activityAt: 100 });
    createdSessionIds.push(session.id);

    await touchSessionActivity(db, session.id, 200);
    const updated = await touchSessionActivity(db, session.id, 150);

    expect(updated.activityAt).toBe(200);
  });

  it('keeps Fast-only Sessions active while a conversation is responding', async () => {
    const session = await sessionFactory.create({ cachedStatus: 'ready' });
    createdSessionIds.push(session.id);

    const active = await touchSessionActivity(db, session.id, 200, {
      respondingUntil: new Date(Date.now() + 60_000),
    });
    const ready = await touchSessionActivity(db, session.id, 201, {
      respondingUntil: null,
    });

    expect(active.cachedStatus).toBe('active');
    expect(ready.cachedStatus).toBe('ready');
  });

  it('honors the stored responding lease when recomputing without options', async () => {
    const session = await sessionFactory.create({ cachedStatus: 'ready' });
    createdSessionIds.push(session.id);

    await touchSessionActivity(db, session.id, 200, {
      respondingUntil: new Date(Date.now() + 60_000),
    });
    const recomputed = await touchSessionActivity(db, session.id, 201);

    expect(recomputed.cachedStatus).toBe('active');
  });

  it('treats an expired responding lease as not responding', async () => {
    const session = await sessionFactory.create({ cachedStatus: 'active' });
    createdSessionIds.push(session.id);

    await touchSessionActivity(db, session.id, 200, {
      respondingUntil: new Date(Date.now() - 1_000),
    });
    const recomputed = await touchSessionActivity(db, session.id, 201);

    expect(recomputed.cachedStatus).toBe('ready');
  });

  it('skips the write when nothing changed', async () => {
    const session = await sessionFactory.create({
      activityAt: 200,
      cachedStatus: 'ready',
    });
    createdSessionIds.push(session.id);

    const touched = await touchSessionActivity(db, session.id, 100);

    expect(touched.updatedAt).toEqual(session.updatedAt);
  });

  it('recomputes cached status from linked tasks while touching activity', async () => {
    const session = await sessionFactory.create({
      activityAt: 100,
      cachedStatus: 'ready',
    });
    createdSessionIds.push(session.id);
    const task = await taskFactory.create({
      state: 'active',
      activityAt: 200,
    });
    createdTaskIds.push(task.id);
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'direct_launch',
    });

    const updated = await touchSessionActivity(db, session.id, 200);

    expect(updated).toEqual(
      expect.objectContaining({ activityAt: 200, cachedStatus: 'active' }),
    );
  });

  it('excludes soft-deleted tasks when recomputing cached status', async () => {
    const session = await sessionFactory.create({
      activityAt: 100,
      cachedStatus: 'blocked',
    });
    createdSessionIds.push(session.id);
    const task = await taskFactory.create({
      state: 'failed',
      deletedAt: new Date(),
    });
    createdTaskIds.push(task.id);
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'direct_launch',
    });

    const updated = await touchSessionActivity(db, session.id, 100);

    expect(updated.cachedStatus).toBe('ready');
  });

  it('serializes concurrent status refreshes before reading linked tasks', async () => {
    const session = await sessionFactory.create({
      activityAt: 100,
      cachedStatus: 'active',
    });
    createdSessionIds.push(session.id);
    const firstTask = await taskFactory.create({ state: 'active' });
    const secondTask = await taskFactory.create({ state: 'active' });
    createdTaskIds.push(firstTask.id, secondTask.id);
    await db.insert(sessionTasks).values([
      {
        sessionId: session.id,
        taskId: firstTask.id,
        origin: 'direct_launch',
      },
      {
        sessionId: session.id,
        taskId: secondTask.id,
        origin: 'follow_up',
      },
    ]);

    let releaseFirst!: () => void;
    const firstCanCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstRefreshed!: () => void;
    const firstRefreshComplete = new Promise<void>((resolve) => {
      firstRefreshed = resolve;
    });

    const first = db.transaction(async (tx) => {
      await tx
        .update(tasks)
        .set({ state: 'completed' })
        .where(eq(tasks.id, firstTask.id));
      await touchSessionActivity(tx, session.id, 200);
      firstRefreshed();
      await firstCanCommit;
    });
    await firstRefreshComplete;

    let secondUpdated!: () => void;
    const secondTaskUpdated = new Promise<void>((resolve) => {
      secondUpdated = resolve;
    });
    const second = db.transaction(async (tx) => {
      await tx
        .update(tasks)
        .set({ state: 'completed' })
        .where(eq(tasks.id, secondTask.id));
      secondUpdated();
      await touchSessionActivity(tx, session.id, 300);
    });
    await secondTaskUpdated;
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseFirst();
    await Promise.all([first, second]);

    const [refreshed] = await db
      .select({ cachedStatus: sessions.cachedStatus })
      .from(sessions)
      .where(eq(sessions.id, session.id));
    expect(refreshed?.cachedStatus).toBe('ready');
  });

  it('creates one canonical session and owner participant for a visible task', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);
    const task = await taskFactory.create({ initiatorUserId: user.id });
    createdTaskIds.push(task.id);

    const first = await db.transaction((tx) =>
      ensureSessionForTask(tx, { taskId: task.id }),
    );
    const second = await db.transaction((tx) =>
      ensureSessionForTask(tx, { taskId: task.id, existingTaskReused: true }),
    );

    expect(first).not.toBeNull();
    expect(second?.id).toBe(first?.id);
    if (first) createdSessionIds.push(first.id);

    const links = await db
      .select()
      .from(sessionTasks)
      .where(eq(sessionTasks.taskId, task.id));
    const participants = await db
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, first!.id));

    expect(links).toHaveLength(1);
    expect(participants).toEqual([
      expect.objectContaining({ userId: user.id, role: 'owner' }),
    ]);
  });

  it('does not create a session for a hidden task', async () => {
    const task = await taskFactory.create({ visibility: 'hidden' });
    createdTaskIds.push(task.id);

    const result = await db.transaction((tx) =>
      ensureSessionForTask(tx, { taskId: task.id }),
    );

    expect(result).toBeNull();
    expect(
      await db
        .select()
        .from(sessionTasks)
        .where(eq(sessionTasks.taskId, task.id)),
    ).toEqual([]);
  });

  it('retains a session when its owner user is deleted', async () => {
    const user = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: user.id,
    });
    createdSessionIds.push(session.id);

    await db.delete(users).where(eq(users.id, user.id));

    const [retained] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, session.id));
    expect(retained).toEqual(
      expect.objectContaining({ ownerKind: 'user', ownerUserId: null }),
    );
  });

  it('attaches Fast-delegated tasks to the conversation session', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: `workspace-${crypto.randomUUID()}`,
        conversationId: `conversation-${crypto.randomUUID()}`,
      })
      .returning();
    createdConversationIds.push(conversation!.id);

    const firstTask = await taskFactory.create({
      initiatorUserId: user.id,
      activityAt: 100,
    });
    const secondTask = await taskFactory.create({
      initiatorUserId: user.id,
      activityAt: 200,
    });
    createdTaskIds.push(firstTask.id, secondTask.id);

    const first = await db.transaction((tx) =>
      ensureSessionForTask(tx, {
        taskId: firstTask.id,
        fastConversationId: conversation!.id,
        origin: 'fast_delegation',
      }),
    );
    const second = await db.transaction((tx) =>
      ensureSessionForTask(tx, {
        taskId: secondTask.id,
        fastConversationId: conversation!.id,
        origin: 'fast_delegation',
      }),
    );

    expect(second?.id).toBe(first?.id);
    expect(second?.activityAt).toBe(200);
    if (first) createdSessionIds.push(first.id);
    expect(
      await db
        .select()
        .from(sessionTasks)
        .where(eq(sessionTasks.sessionId, first!.id)),
    ).toHaveLength(2);
  });

  it('creates one Session when a Fast conversation is created repeatedly', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: `workspace-${crypto.randomUUID()}`,
        conversationId: `conversation-${crypto.randomUUID()}`,
      })
      .returning();
    createdConversationIds.push(conversation!.id);

    const first = await db.transaction((tx) =>
      ensureSessionForFastConversation(tx, conversation!.id),
    );
    const second = await db.transaction((tx) =>
      ensureSessionForFastConversation(tx, conversation!.id),
    );
    createdSessionIds.push(first.id);

    expect(second.id).toBe(first.id);
    expect(
      await db
        .select()
        .from(sessions)
        .where(eq(sessions.fastConversationId, conversation!.id)),
    ).toHaveLength(1);
  });

  it('never regresses a participant read cursor', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: user.id,
    });
    createdSessionIds.push(session.id);

    await advanceSessionReadCursor(db, {
      sessionId: session.id,
      userId: user.id,
      eventAt: 200,
      eventId: 'event-b',
    });
    const current = await advanceSessionReadCursor(db, {
      sessionId: session.id,
      userId: user.id,
      eventAt: 100,
      eventId: 'event-a',
    });

    expect(current.lastReadEventAt).toBe(200);
    expect(current.lastReadEventId).toBe('event-b');
  });

  it('advances participant notification cursors monotonically', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: user.id,
    });
    createdSessionIds.push(session.id);
    await db.insert(sessionParticipants).values({
      sessionId: session.id,
      userId: user.id,
      role: 'owner',
    });

    await advanceSessionNotifiedCursor(db, {
      sessionId: session.id,
      eventAt: 200,
      eventId: 'event-b',
    });
    await advanceSessionNotifiedCursor(db, {
      sessionId: session.id,
      eventAt: 100,
      eventId: 'event-a',
    });

    const [participant] = await db
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, session.id));
    expect(participant?.lastNotifiedEventAt).toBe(200);
    expect(participant?.lastNotifiedEventId).toBe('event-b');
  });

  it('stamps new task usage with the owning Session', async () => {
    const task = await taskFactory.create();
    createdTaskIds.push(task.id);
    const session = await sessionFactory.create();
    createdSessionIds.push(session.id);
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'direct_launch',
    });

    await recordLlmUsage({
      taskId: task.id,
      eventKey: `session-usage:${crypto.randomUUID()}`,
      inputTokens: 10,
      outputTokens: 5,
    });

    const [usage] = await db
      .select({ sessionId: llmUsageEvents.sessionId })
      .from(llmUsageEvents)
      .where(eq(llmUsageEvents.taskId, task.id));
    expect(usage?.sessionId).toBe(session.id);
  });
});
