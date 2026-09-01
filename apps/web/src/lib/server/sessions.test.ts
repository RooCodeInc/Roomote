import {
  automations,
  db,
  eq,
  ensureSessionForFastConversation,
  fastAgentConversations,
  fastAgentMessages,
  llmUsageEvents,
  runFactory,
  sessionFactory,
  sessionTasks,
  taskArtifacts,
  taskFactory,
  taskMessages,
  taskPullRequests,
  tasks,
  userFactory,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
} from '@roomote/types';

const syncFastSlackTitle = vi.hoisted(() => vi.fn());

vi.mock('@roomote/sdk/server', () => ({
  syncFastAgentSlackTitleBestEffort: syncFastSlackTitle,
}));

import {
  findAccessibleSession,
  getLatestExternalSessionEvent,
  getSessionById,
  getSessionForTask,
  getSessionSources,
  getSessions,
  getSessionTimeline,
  setSessionPinned,
  updateSessionMetadata,
} from './sessions';

describe('unified Session queries', () => {
  beforeEach(() => {
    syncFastSlackTitle.mockReset();
    syncFastSlackTitle.mockResolvedValue(undefined);
  });
  it('opens detail reads to everyone but scopes the list like tasks', async () => {
    const owner = await userFactory.create();
    const stranger = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Visible Session',
    });

    // Anyone with the link can open the Session.
    await expect(
      findAccessibleSession({ userId: owner.id, isAdmin: false }, session.id),
    ).resolves.toMatchObject({ id: session.id });
    await expect(
      findAccessibleSession(
        { userId: stranger.id, isAdmin: false },
        session.id,
      ),
    ).resolves.toMatchObject({ id: session.id });

    // The list defaults mirror /tasks: admins see everything, other users
    // see only Sessions they own or participate in.
    const ownerList = await getSessions(
      { userId: owner.id, isAdmin: false },
      { scope: 'all' },
    );
    expect(ownerList.sessions.map((row) => row.id)).toContain(session.id);
    const strangerList = await getSessions(
      { userId: stranger.id, isAdmin: false },
      { scope: 'all' },
    );
    expect(strangerList.sessions.map((row) => row.id)).not.toContain(
      session.id,
    );
    const adminList = await getSessions(
      { userId: stranger.id, isAdmin: true },
      { scope: 'all' },
    );
    expect(adminList.sessions.map((row) => row.id)).toContain(session.id);
  });

  it('filters recent-session lookups by id without bypassing list scope', async () => {
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
    const otherOwned = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: stranger.id,
      title: 'Outside the list scope',
      activityAt: 200,
    });

    const result = await getSessions(
      { userId: owner.id, isAdmin: false },
      { ids: [included.id, otherOwned.id] },
    );

    expect(result.sessions.map((session) => session.id)).toEqual([included.id]);
  });

  it('filters Session owners by automation creator values', async () => {
    const user = await userFactory.create();
    await db
      .insert(automations)
      .values({ key: 'sentry_triage' })
      .onConflictDoNothing();
    const automationSession = await sessionFactory.create({
      ownerKind: 'automation',
      ownerAutomation: 'sentry_triage',
      title: 'Automation Session',
    });
    const userSession = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: user.id,
      title: 'User Session',
    });

    const result = await getSessions(
      { userId: user.id, isAdmin: true },
      {
        ids: [automationSession.id, userSession.id],
        user: 'automation:sentry_triage',
      },
    );

    expect(result.sessions.map((session) => session.id)).toEqual([
      automationSession.id,
    ]);
  });

  it('includes active pull requests from linked tasks in Session rows', async () => {
    const owner = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
    });
    const task = await taskFactory.create({ initiatorUserId: owner.id });
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'direct_launch',
    });
    await db.insert(taskPullRequests).values([
      {
        taskId: task.id,
        prUrl: 'https://github.com/RooCodeInc/Roomote/pull/1939',
        prNumber: 1939,
        repository: 'RooCodeInc/Roomote',
        sourceControlProvider: 'github',
        status: 'open',
      },
      {
        taskId: task.id,
        prUrl: 'https://github.com/RooCodeInc/Roomote/pull/1900',
        prNumber: 1900,
        repository: 'RooCodeInc/Roomote',
        sourceControlProvider: 'github',
        status: 'merged',
      },
    ]);

    const result = await getSessions(
      { userId: owner.id, isAdmin: false },
      { ids: [session.id] },
    );

    expect(result.sessions[0]?.pullRequests).toEqual([
      {
        repository: 'RooCodeInc/Roomote',
        number: 1939,
        url: 'https://github.com/RooCodeInc/Roomote/pull/1939',
      },
    ]);
  });

  it('lists only distinct visible sources within the list scope', async () => {
    const owner = await userFactory.create();
    const stranger = await userFactory.create();
    await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      sourceSurface: 'web',
    });
    await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      sourceSurface: 'web',
    });
    await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      sourceSurface: 'slack',
      archivedAt: new Date(),
    });
    await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: stranger.id,
      sourceSurface: 'discord',
    });

    await expect(
      getSessionSources({ userId: owner.id, isAdmin: false }),
    ).resolves.toEqual(['web']);
  });

  it('aggregates direct and attached-task inference costs exactly once', async () => {
    const owner = await userFactory.create();
    const nativeSessionId = `native-${crypto.randomUUID()}`;
    const currentNativeSessionId = `native-current-${crypto.randomUUID()}`;
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: owner.id,
        surface: 'web',
        workspaceId: owner.id,
        conversationId: crypto.randomUUID(),
        openCodeSessionId: currentNativeSessionId,
      })
      .returning();
    await db.insert(fastAgentMessages).values({
      conversationId: conversation!.id,
      eventId: `cost-message-${crypto.randomUUID()}`,
      turnId: 'turn-1',
      turnSeq: 0,
      ts: 1,
      eventType: 'roomote_runtime.assistant_message',
      role: 'assistant',
      nativeSessionId,
    });
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      fastConversationId: conversation!.id,
    });
    const [firstTask, secondTask, zeroCostTask] = await Promise.all([
      taskFactory.create({ initiatorUserId: owner.id, title: 'First task' }),
      taskFactory.create({ initiatorUserId: owner.id, title: 'Second task' }),
      taskFactory.create({
        initiatorUserId: owner.id,
        title: 'Zero cost task',
      }),
    ]);
    await db.insert(sessionTasks).values(
      [firstTask, secondTask, zeroCostTask].map((task) => ({
        sessionId: session.id,
        taskId: task.id,
        origin: 'fast_delegation' as const,
      })),
    );
    await db.insert(llmUsageEvents).values([
      {
        eventKey: `session-direct-${crypto.randomUUID()}`,
        sessionId: session.id,
        costSource: 'missing',
        costMicroUsd: 100_000,
      },
      {
        eventKey: `session-task-${crypto.randomUUID()}`,
        sessionId: session.id,
        taskId: firstTask.id,
        costSource: 'missing',
        costMicroUsd: 200_000,
      },
      {
        eventKey: `legacy-task-${crypto.randomUUID()}`,
        taskId: firstTask.id,
        costSource: 'missing',
        costMicroUsd: 300_000,
      },
      {
        eventKey: `legacy-fast-direct-${crypto.randomUUID()}`,
        harnessSessionId: nativeSessionId,
        messageId: `message-${crypto.randomUUID()}`,
        costSource: 'missing',
        costMicroUsd: 400_000,
      },
      {
        eventKey: `legacy-fast-task-${crypto.randomUUID()}`,
        harnessSessionId: nativeSessionId,
        messageId: `message-${crypto.randomUUID()}`,
        taskId: secondTask.id,
        costSource: 'missing',
        costMicroUsd: 500_000,
      },
      {
        eventKey: `current-fast-direct-${crypto.randomUUID()}`,
        harnessSessionId: currentNativeSessionId,
        messageId: `message-${crypto.randomUUID()}`,
        costSource: 'missing',
        costMicroUsd: 600_000,
      },
    ]);

    const detail = await getSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );
    const listed = await getSessions(
      { userId: owner.id, isAdmin: false },
      { ids: [session.id] },
    );

    expect(detail).toMatchObject({
      directInferenceCostMicroUsd: 1_100_000,
      inferenceCostMicroUsd: 2_100_000,
    });
    expect(detail?.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: firstTask.id,
          inferenceCostMicroUsd: 500_000,
        }),
        expect.objectContaining({
          taskId: secondTask.id,
          inferenceCostMicroUsd: 500_000,
        }),
        expect.objectContaining({
          taskId: zeroCostTask.id,
          inferenceCostMicroUsd: 0,
        }),
      ]),
    );
    expect(listed.sessions[0]).toMatchObject({
      directInferenceCostMicroUsd: 1_100_000,
      inferenceCostMicroUsd: 2_100_000,
    });
  });

  it('searches visible Fast and task transcript text', async () => {
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
    const fastSession = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Fast transcript search',
      fastConversationId: conversation!.id,
    });
    await db.insert(fastAgentMessages).values([
      {
        conversationId: conversation!.id,
        eventId: 'search-visible',
        turnId: 'turn-visible',
        turnSeq: 0,
        ts: 100,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant',
        contentBlocks: [
          { type: 'text', text: 'The uncommon heliotrope snippet is ready.' },
        ],
        metadata: { visibleInTranscript: true },
        payload: {},
      },
      {
        conversationId: conversation!.id,
        eventId: 'search-hidden',
        turnId: 'turn-hidden',
        turnSeq: 0,
        ts: 200,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant',
        contentBlocks: [
          { type: 'text', text: 'The private zephyr phrase is hidden.' },
        ],
        metadata: { visibleInTranscript: false },
        payload: {},
      },
    ]);

    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      title: 'Task transcript search',
      repositoryName: 'RooCodeInc/search-target',
    });
    const run = await runFactory.create({ taskId: task.id });
    const taskSession = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Linked execution details',
    });
    await db.insert(sessionTasks).values({
      sessionId: taskSession.id,
      taskId: task.id,
      origin: 'direct_launch',
    });
    await db.insert(taskMessages).values({
      runId: run.id,
      taskId: task.id,
      ts: 300,
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      role: 'user',
      protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
      contentBlocks: [
        {
          type: 'text',
          text: 'Please preserve the uncommon vermilion detail.',
        },
      ],
      metadata: { visibleInTranscript: true },
      payload: {},
    });

    const fastResult = await getSessions(
      { userId: owner.id, isAdmin: false },
      { q: 'heliotrope' },
    );
    expect(fastResult.sessions.map((session) => session.id)).toEqual([
      fastSession.id,
    ]);
    expect(fastResult.sessions[0]?.searchSnippet).toContain('heliotrope');

    const taskResult = await getSessions(
      { userId: owner.id, isAdmin: false },
      { q: 'vermilion' },
    );
    expect(taskResult.sessions.map((session) => session.id)).toEqual([
      taskSession.id,
    ]);
    expect(taskResult.sessions[0]?.searchSnippet).toContain('vermilion');

    const titleResult = await getSessions(
      { userId: owner.id, isAdmin: false },
      { q: 'Fast transcript search' },
    );
    expect(titleResult.sessions.map((session) => session.id)).toEqual([
      fastSession.id,
    ]);
    expect(titleResult.sessions[0]?.searchSnippet).toBeNull();

    const repositoryResult = await getSessions(
      { userId: owner.id, isAdmin: false },
      { q: 'search-target' },
    );
    expect(repositoryResult.sessions.map((session) => session.id)).toEqual([
      taskSession.id,
    ]);

    const hiddenResult = await getSessions(
      { userId: owner.id, isAdmin: false },
      { q: 'zephyr' },
    );
    expect(hiddenResult.sessions).toEqual([]);

    await db.insert(taskMessages).values({
      runId: run.id,
      taskId: task.id,
      ts: 400,
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      role: 'user',
      protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
      contentBlocks: [
        { type: 'text', text: 'The legacy indigo wrapper is not visible.' },
      ],
      payload: {},
    });
    const legacyHiddenResult = await getSessions(
      { userId: owner.id, isAdmin: false },
      { q: 'indigo' },
    );
    expect(legacyHiddenResult.sessions).toEqual([]);

    await db
      .update(tasks)
      .set({ deletedAt: new Date() })
      .where(eq(tasks.id, task.id));
    const deletedTaskResult = await getSessions(
      { userId: owner.id, isAdmin: false },
      { q: 'vermilion' },
    );
    expect(deletedTaskResult.sessions).toEqual([]);
    const deletedTaskTitleResult = await getSessions(
      { userId: owner.id, isAdmin: false },
      { q: 'Task transcript search' },
    );
    expect(deletedTaskTitleResult.sessions).toEqual([]);
    const deletedRepositoryResult = await getSessions(
      { userId: owner.id, isAdmin: false },
      { q: 'search-target' },
    );
    expect(deletedRepositoryResult.sessions).toEqual([]);
  });

  it('ranks search matches by relevance and recency across pages', async () => {
    const owner = await userFactory.create();
    const directOlder = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Ranking nebula older title',
      activityAt: 100,
    });
    const directNewer = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Ranking nebula newer title',
      activityAt: 200,
    });

    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      title: 'Ranking nebula linked task',
    });
    const taskSession = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Unrelated linked session',
      activityAt: 400,
    });
    await db.insert(sessionTasks).values({
      sessionId: taskSession.id,
      taskId: task.id,
      origin: 'direct_launch',
    });

    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: owner.id,
        surface: 'web',
        workspaceId: owner.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    const transcriptSession = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Unrelated transcript session',
      fastConversationId: conversation!.id,
      activityAt: 500,
    });
    await db.insert(fastAgentMessages).values({
      conversationId: conversation!.id,
      eventId: 'ranking-transcript',
      turnId: 'ranking-turn',
      turnSeq: 0,
      ts: 500,
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
      role: 'assistant',
      contentBlocks: [
        { type: 'text', text: 'Ranking nebula appears only in this message.' },
      ],
      metadata: { visibleInTranscript: true },
      payload: {},
    });

    const expectedOrder = [
      directNewer.id,
      directOlder.id,
      taskSession.id,
      transcriptSession.id,
    ];
    const receivedOrder: string[] = [];
    const receivedSnippets: Array<string | null> = [];
    let before: string | null = null;

    for (let index = 0; index < expectedOrder.length; index += 1) {
      const result = await getSessions(
        { userId: owner.id, isAdmin: false },
        { q: 'ranking nebula', limit: 1, before },
      );
      receivedOrder.push(...result.sessions.map((session) => session.id));
      receivedSnippets.push(
        ...result.sessions.map((session) => session.searchSnippet),
      );
      before = result.nextCursor;
    }

    expect(receivedOrder).toEqual(expectedOrder);
    expect(receivedSnippets).toEqual([
      null,
      null,
      null,
      expect.stringContaining('Ranking nebula'),
    ]);
    expect(before).toBeNull();
  });

  it('does not preview invisible or deleted transcript content', async () => {
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
    const fastSession = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Private legacy audit',
      fastConversationId: conversation!.id,
    });
    await db.insert(fastAgentMessages).values([
      {
        conversationId: conversation!.id,
        eventId: 'hidden-preview',
        turnId: 'hidden-turn',
        turnSeq: 0,
        ts: 100,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'Private transcript detail' }],
        metadata: { visibleInTranscript: false },
        payload: {},
      },
      {
        conversationId: conversation!.id,
        eventId: 'legacy-preview',
        turnId: 'legacy-turn',
        turnSeq: 0,
        ts: 200,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'Legacy transcript detail' }],
        payload: {},
      },
    ]);

    for (const query of ['private', 'legacy']) {
      const result = await getSessions(
        { userId: owner.id, isAdmin: false },
        { q: query },
      );
      expect(result.sessions).toEqual([
        expect.objectContaining({ id: fastSession.id, searchSnippet: null }),
      ]);
    }

    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      title: 'Unrelated deleted task',
    });
    const run = await runFactory.create({ taskId: task.id });
    const taskSession = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Crimson deletion audit',
    });
    await db.insert(sessionTasks).values({
      sessionId: taskSession.id,
      taskId: task.id,
      origin: 'direct_launch',
    });
    await db.insert(taskMessages).values({
      runId: run.id,
      taskId: task.id,
      ts: 300,
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
      role: 'assistant',
      protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
      contentBlocks: [{ type: 'text', text: 'Crimson deleted detail' }],
      metadata: { visibleInTranscript: true },
      payload: {},
    });
    await db
      .update(tasks)
      .set({ deletedAt: new Date() })
      .where(eq(tasks.id, task.id));

    const deletedResult = await getSessions(
      { userId: owner.id, isAdmin: false },
      { q: 'crimson' },
    );
    expect(deletedResult.sessions).toEqual([
      expect.objectContaining({ id: taskSession.id, searchSnippet: null }),
    ]);
  });

  it('requires three characters only for transcript-content matches', async () => {
    const owner = await userFactory.create();
    const directSession = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'QZ direct title',
    });
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: owner.id,
        surface: 'web',
        workspaceId: owner.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Unrelated short transcript',
      fastConversationId: conversation!.id,
    });
    await db.insert(fastAgentMessages).values({
      conversationId: conversation!.id,
      eventId: 'short-transcript',
      turnId: 'short-turn',
      turnSeq: 0,
      ts: 100,
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'ZX' }],
      metadata: { visibleInTranscript: true },
      payload: {},
    });

    const shortTranscriptResult = await getSessions(
      { userId: owner.id, isAdmin: false },
      { q: 'zx' },
    );
    expect(shortTranscriptResult.sessions).toEqual([]);

    const shortTitleResult = await getSessions(
      { userId: owner.id, isAdmin: false },
      { q: 'qz' },
    );
    expect(shortTitleResult.sessions.map((session) => session.id)).toEqual([
      directSession.id,
    ]);
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
    await db.insert(taskArtifacts).values([
      {
        taskId: task.id,
        path: 'screenshots/result.png',
        version: 2,
        contentType: 'image/png',
        size: 123,
        uploaded: true,
      },
      {
        taskId: task.id,
        path: 'screenshots/pending.png',
        contentType: 'image/png',
        size: 0,
      },
    ]);
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
      expect.objectContaining({
        taskId: task.id,
        title: 'Delegated work',
        artifacts: [
          expect.objectContaining({
            path: 'screenshots/result.png',
            version: 2,
            createdAt: expect.any(Date),
          }),
        ],
      }),
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

  it('hydrates uploaded artifacts for every associated task without collapsing shared paths', async () => {
    const owner = await userFactory.create();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Artifact session',
    });
    const firstTask = await taskFactory.create({
      initiatorUserId: owner.id,
      title: 'First task',
    });
    const secondTask = await taskFactory.create({
      initiatorUserId: owner.id,
      title: 'Second task',
    });
    // Explicit attachedAt values: rows inserted in one statement share a
    // timestamp, which makes the attachedAt ordering below nondeterministic.
    await db.insert(sessionTasks).values([
      {
        sessionId: session.id,
        taskId: firstTask.id,
        origin: 'direct_launch',
        attachedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        sessionId: session.id,
        taskId: secondTask.id,
        origin: 'fast_delegation',
        attachedAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    ]);
    await db.insert(taskArtifacts).values([
      {
        taskId: firstTask.id,
        path: 'reports/result.md',
        version: 2,
        contentType: 'text/markdown',
        size: 200,
        uploaded: true,
      },
      {
        taskId: secondTask.id,
        path: 'reports/result.md',
        version: 1,
        contentType: 'text/markdown',
        size: 100,
        uploaded: true,
      },
      {
        taskId: secondTask.id,
        path: 'reports/pending.md',
        version: 1,
        contentType: 'text/markdown',
        size: 0,
        uploaded: false,
      },
    ]);

    const detail = await getSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(detail?.tasks).toEqual([
      expect.objectContaining({
        taskId: firstTask.id,
        artifacts: [
          expect.objectContaining({ path: 'reports/result.md', version: 2 }),
        ],
      }),
      expect.objectContaining({
        taskId: secondTask.id,
        artifacts: [
          expect.objectContaining({ path: 'reports/result.md', version: 1 }),
        ],
      }),
    ]);
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

  it('persists and synchronizes manual Fast session title changes', async () => {
    const owner = await userFactory.create();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: owner.id,
        surface: 'slack',
        workspaceId: `T-manual-${Date.now()}`,
        conversationId: '100.001',
        currentReplyChannelId: 'C123',
        currentReplyThreadId: '100.001',
        title: 'Original title',
      })
      .returning();
    const session = await ensureSessionForFastConversation(
      db,
      conversation!.id,
    );

    await updateSessionMetadata(
      { userId: owner.id, isAdmin: false },
      session!.id,
      { title: 'Renamed Fast session' },
    );

    await expect(
      db.query.fastAgentConversations.findFirst({
        where: eq(fastAgentConversations.id, conversation!.id),
      }),
    ).resolves.toMatchObject({
      title: 'Renamed Fast session',
      titleEditedByUserAt: expect.any(Date),
    });
    expect(syncFastSlackTitle).toHaveBeenCalledWith({
      conversationId: conversation!.id,
    });
  });
});
