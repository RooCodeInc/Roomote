import {
  db,
  fastAgentConversations,
  fastAgentMessages,
  sessionFactory,
  sessionTasks,
  taskFactory,
  userFactory,
} from '@roomote/db/server';

import {
  findAccessibleSession,
  getLatestExternalSessionEvent,
  getSessionById,
  getSessionForTask,
  getSessions,
  getSessionTimeline,
  setSessionPinned,
  updateSessionMetadata,
} from './sessions';

describe('unified Session queries', () => {
  it('scopes list and detail reads to owners, participants, and admins', async () => {
    const owner = await userFactory.create();
    const stranger = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Visible Session',
    });

    await expect(
      findAccessibleSession({ userId: owner.id, isAdmin: false }, session.id),
    ).resolves.toMatchObject({ id: session.id });
    await expect(
      findAccessibleSession(
        { userId: stranger.id, isAdmin: false },
        session.id,
      ),
    ).resolves.toBeNull();
    await expect(
      findAccessibleSession({ userId: stranger.id, isAdmin: true }, session.id),
    ).resolves.toMatchObject({ id: session.id });

    const list = await getSessions(
      { userId: owner.id, isAdmin: false },
      { scope: 'all' },
    );
    expect(list.sessions.map((row) => row.id)).toContain(session.id);
  });

  it('filters recent-session lookups by id without bypassing access scope', async () => {
    const owner = await userFactory.create();
    const stranger = await userFactory.create();
    const included = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Included Session',
      activityAt: 100,
    });
    await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Newer but not included',
      activityAt: 300,
    });
    const inaccessible = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: stranger.id,
      title: 'Inaccessible Session',
      activityAt: 200,
    });

    const result = await getSessions(
      { userId: owner.id, isAdmin: false },
      { ids: [included.id, inaccessible.id] },
    );

    expect(result.sessions.map((session) => session.id)).toEqual([included.id]);
  });

  it('returns task rollups, task resolution, and deterministic timeline events', async () => {
    const owner = await userFactory.create();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: owner.id,
        surface: 'web',
        workspaceId: owner.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Composed Session',
      fastConversationId: conversation!.id,
    });
    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      title: 'Delegated work',
    });
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'fast_delegation',
    });
    await db.insert(fastAgentMessages).values({
      conversationId: conversation!.id,
      eventId: 'message-1',
      turnId: 'turn-1',
      turnSeq: 0,
      ts: 100,
      eventType: 'roomote_runtime.user_prompt',
      role: 'user',
      contentBlocks: [{ type: 'text', text: 'Please delegate this' }],
      metadata: { userId: owner.id, visibleInTranscript: true },
      payload: {},
    });

    const detail = await getSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );
    expect(detail?.tasks).toEqual([
      expect.objectContaining({ taskId: task.id, title: 'Delegated work' }),
    ]);
    await expect(
      getSessionForTask({ userId: owner.id, isAdmin: false }, task.id),
    ).resolves.toEqual({ sessionId: session.id, title: 'Composed Session' });
    const timeline = await getSessionTimeline(
      { userId: owner.id, isAdmin: false },
      session.id,
    );
    expect(timeline?.events.map((event) => event.id)).toEqual(
      expect.arrayContaining([
        'fast:message-1',
        `task:${task.id}:delegated`,
        `task:${task.id}:${task.state}`,
      ]),
    );
    const taskEvent = timeline?.events.find(
      (event) => event.type === 'task_delegated',
    );
    expect(taskEvent).not.toHaveProperty('task.latestRun');
    expect(taskEvent).not.toHaveProperty('task.artifacts');
    expect(taskEvent).not.toHaveProperty('task.pullRequests');
  });

  it('resolves the latest external event from visible messages only', async () => {
    const owner = await userFactory.create();
    const other = await userFactory.create();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: owner.id,
        surface: 'web',
        workspaceId: owner.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Unread Session',
      fastConversationId: conversation!.id,
    });
    await db.insert(fastAgentMessages).values([
      {
        conversationId: conversation!.id,
        eventId: 'visible-1',
        turnId: 'turn-1',
        turnSeq: 0,
        ts: 100,
        eventType: 'roomote_runtime.user_prompt',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'hello' }],
        metadata: { userId: other.id, visibleInTranscript: true },
        payload: {},
      },
      {
        conversationId: conversation!.id,
        eventId: 'invisible-2',
        turnId: 'turn-2',
        turnSeq: 0,
        ts: 200,
        eventType: 'roomote_runtime.user_prompt',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'platform event' }],
        metadata: { userId: other.id, visibleInTranscript: false },
        payload: {},
      },
    ]);

    // The invisible newer message must count for neither the unread max nor
    // the read cursor, or the badge could never be cleared.
    const latest = await getLatestExternalSessionEvent(
      { userId: owner.id, isAdmin: false },
      session.id,
    );
    expect(latest).toEqual({ at: 100, id: 'fast:visible-1' });

    const list = await getSessions(
      { userId: owner.id, isAdmin: false },
      { scope: 'all' },
    );
    const row = list.sessions.find((entry) => entry.id === session.id);
    expect(row?.unread).toBe(true);
  });

  it('excludes soft-deleted tasks from Session detail, timeline, and live status', async () => {
    const owner = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      cachedStatus: 'blocked',
    });
    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      state: 'failed',
      deletedAt: new Date(),
    });
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'direct_launch',
    });

    const detail = await getSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );
    const timeline = await getSessionTimeline(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(detail?.tasks).toEqual([]);
    expect(detail?.status).toBe('ready');
    expect(
      timeline?.events.some((event) => event.id.startsWith(`task:${task.id}:`)),
    ).toBe(false);
  });

  it('keeps metadata changes owner-only and stores per-user pins', async () => {
    const owner = await userFactory.create();
    const stranger = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
    });

    await expect(
      updateSessionMetadata(
        { userId: stranger.id, isAdmin: false },
        session.id,
        { title: 'Nope' },
      ),
    ).resolves.toBeNull();
    await expect(
      updateSessionMetadata({ userId: owner.id, isAdmin: false }, session.id, {
        title: 'Renamed',
      }),
    ).resolves.toMatchObject({
      title: 'Renamed',
      titleEditedByUserAt: expect.any(Date),
    });
    await expect(
      setSessionPinned(
        { userId: owner.id, isAdmin: false },
        { sessionId: session.id, pinned: true },
      ),
    ).resolves.toEqual({ success: true, pinned: true });
  });
});
