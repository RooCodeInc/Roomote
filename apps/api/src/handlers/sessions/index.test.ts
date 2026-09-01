const mocks = vi.hoisted(() => ({
  getOrCreateFastAgentSession: vi.fn(),
  getSessionForFastConversation: vi.fn(),
  queueFastAgentSurfaceReply: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/cloud-agents/server')>()),
  getOrCreateFastAgentSession: mocks.getOrCreateFastAgentSession,
}));

vi.mock('@roomote/sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/sdk/server')>()),
  queueFastAgentSurfaceReply: mocks.queueFastAgentSurfaceReply,
}));

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  getSessionForFastConversation: mocks.getSessionForFastConversation,
}));

import { Hono } from 'hono';
import {
  ACP_UI_TOOL_OUTPUT_MAX_CHARS,
  type AuthTokenContext,
  type RunTokenContext,
  TaskPayloadKind,
} from '@roomote/types';
import {
  db,
  eq,
  ensureAutomationRows,
  fastAgentConversations,
  fastAgentMessages,
  sessionFactory,
  sessions,
  sessionTasks,
  taskFactory,
  taskRuns,
  tasks,
  userFactory,
  users,
} from '@roomote/db/server';

import type { Variables } from '../../types';
import { mcpAuthMiddleware } from '../mcp/middleware';
import { sessionsRouter } from '.';

const createdSessionIds: string[] = [];
const createdTaskIds: string[] = [];
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

function createApp(userIdOrAuth: string | AuthTokenContext | RunTokenContext) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    const auth: AuthTokenContext | RunTokenContext =
      typeof userIdOrAuth === 'string'
        ? { userId: userIdOrAuth, tokenType: 'auth', version: 1 }
        : userIdOrAuth;
    c.set('authContext', auth);
    await next();
  });
  app.use('*', mcpAuthMiddleware);
  app.route('/sessions', sessionsRouter);
  return app;
}

afterEach(async () => {
  while (createdSessionIds.length > 0) {
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
  vi.clearAllMocks();
});

describe('MCP session routes', () => {
  it('starts a unified session and queues its first turn', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);
    const sessionId = crypto.randomUUID();
    const fastConversationId = crypto.randomUUID();
    mocks.getOrCreateFastAgentSession.mockResolvedValue({
      id: fastConversationId,
      created: true,
    });
    mocks.getSessionForFastConversation.mockResolvedValue({ id: sessionId });
    mocks.queueFastAgentSurfaceReply.mockResolvedValue(true);

    const response = await createApp(user.id).request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Investigate the failing deployment' }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      sessionId,
      fastConversationId,
      queued: true,
    });
    expect(mocks.queueFastAgentSurfaceReply).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: fastConversationId,
        userId: user.id,
        question: 'Investigate the failing deployment',
      }),
    );
  });

  it('starts as the durable owner of a bot-triggered task with no acting user', async () => {
    await ensureAutomationRows(db);
    const owner = await userFactory.create();
    createdUserIds.push(owner.id);
    const parentSession = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
    });
    createdSessionIds.push(parentSession.id);
    const parentTask = await taskFactory.create({
      initiatorKind: 'automation',
      initiatorUserId: null,
      initiatorAutomation: 'slack_channel_auto_start',
    });
    createdTaskIds.push(parentTask.id);
    await db.insert(sessionTasks).values({
      sessionId: parentSession.id,
      taskId: parentTask.id,
      origin: 'fast_delegation',
    });
    const [parentRun] = await db
      .insert(taskRuns)
      .values({
        taskId: parentTask.id,
        actingUserId: null,
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { repo: '', description: 'Automated request' },
      })
      .returning({ id: taskRuns.id });
    const sessionId = crypto.randomUUID();
    const fastConversationId = crypto.randomUUID();
    mocks.getOrCreateFastAgentSession.mockResolvedValue({
      id: fastConversationId,
      created: true,
    });
    mocks.getSessionForFastConversation.mockResolvedValue({ id: sessionId });
    mocks.queueFastAgentSurfaceReply.mockResolvedValue(true);

    const response = await createApp({
      runId: parentRun!.id,
      userId: null,
      principal: 'deployment',
      tokenType: 'run',
      version: 1,
    } as RunTokenContext).request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Continue in a Session' }),
    });

    expect(response.status).toBe(201);
    expect(mocks.getOrCreateFastAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: owner.id }),
    );
    expect(mocks.queueFastAgentSurfaceReply).toHaveBeenCalledWith(
      expect.objectContaining({ userId: owner.id }),
    );
  });

  it('starts as the current acting user instead of the run token mint-time user', async () => {
    const originalUser = await userFactory.create();
    const currentUser = await userFactory.create();
    createdUserIds.push(originalUser.id, currentUser.id);
    const parentSession = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: originalUser.id,
    });
    createdSessionIds.push(parentSession.id);
    const parentTask = await taskFactory.create({
      initiatorUserId: originalUser.id,
    });
    createdTaskIds.push(parentTask.id);
    await db.insert(sessionTasks).values({
      sessionId: parentSession.id,
      taskId: parentTask.id,
      origin: 'direct_launch',
    });
    const [parentRun] = await db
      .insert(taskRuns)
      .values({
        taskId: parentTask.id,
        actingUserId: currentUser.id,
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { repo: '', description: 'Current user request' },
      })
      .returning({ id: taskRuns.id });
    const sessionId = crypto.randomUUID();
    const fastConversationId = crypto.randomUUID();
    mocks.getOrCreateFastAgentSession.mockResolvedValue({
      id: fastConversationId,
      created: true,
    });
    mocks.getSessionForFastConversation.mockResolvedValue({ id: sessionId });
    mocks.queueFastAgentSurfaceReply.mockResolvedValue(true);

    const response = await createApp({
      runId: parentRun!.id,
      userId: originalUser.id,
      principal: 'user',
      tokenType: 'run',
      version: 1,
    } as RunTokenContext).request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Continue as the current user' }),
    });

    expect(response.status).toBe(201);
    expect(mocks.getOrCreateFastAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: currentUser.id }),
    );
    expect(mocks.queueFastAgentSurfaceReply).toHaveBeenCalledWith(
      expect.objectContaining({ userId: currentUser.id }),
    );
  });

  it('returns accessible sessions with nested child-task state', async () => {
    const owner = await userFactory.create();
    createdUserIds.push(owner.id);
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      title: 'Release investigation',
      sourceSurface: 'web',
      sourceTrigger: 'message',
    });
    createdSessionIds.push(session.id);
    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      title: 'Inspect release checks',
      repositoryName: 'RooCodeInc/Roomote',
    });
    createdTaskIds.push(task.id);
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'fast_delegation',
    });

    const listResponse = await createApp(owner.id).request(
      '/sessions?query=release',
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      sessions: [
        {
          id: session.id,
          title: 'Release investigation',
          tasks: [
            {
              taskId: task.id,
              title: 'Inspect release checks',
              origin: 'fast_delegation',
              latestRun: null,
            },
          ],
        },
      ],
    });

    const summaryResponse = await createApp(owner.id).request(
      `/sessions/${session.id}/summary`,
    );
    expect(summaryResponse.status).toBe(200);
    await expect(summaryResponse.json()).resolves.toMatchObject({
      id: session.id,
      tasks: [{ taskId: task.id }],
    });
  });

  it('shares sessions with every deployment user like tasks', async () => {
    const owner = await userFactory.create();
    const bystander = await userFactory.create();
    createdUserIds.push(owner.id, bystander.id);
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
    });
    createdSessionIds.push(session.id);

    const response = await createApp(bystander.id).request(
      `/sessions/${session.id}/summary`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: session.id });
    const messagesResponse = await createApp(bystander.id).request(
      `/sessions/${session.id}/messages`,
    );
    expect(messagesResponse.status).toBe(200);
    await expect(messagesResponse.json()).resolves.toMatchObject({
      sessionId: session.id,
    });
  });

  it('returns visible, sanitized session messages newest first', async () => {
    const owner = await userFactory.create();
    createdUserIds.push(owner.id);
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: owner.id,
        surface: 'web',
        workspaceId: owner.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    createdConversationIds.push(conversation!.id);
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      fastConversationId: conversation!.id,
      sourceSurface: 'web',
      sourceTrigger: 'message',
    });
    createdSessionIds.push(session.id);
    mocks.queueFastAgentSurfaceReply.mockResolvedValue(true);
    await db.insert(fastAgentMessages).values([
      {
        conversationId: conversation!.id,
        eventId: 'visible-old',
        turnId: 'turn-old',
        turnSeq: 0,
        ts: 1,
        eventType: 'roomote_runtime.user_prompt',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'Older message' }],
        metadata: { visibleInTranscript: true },
        payload: {},
        source: 'web',
      },
      {
        conversationId: conversation!.id,
        eventId: 'hidden-middle',
        turnId: 'turn-hidden',
        turnSeq: 0,
        ts: 2,
        eventType: 'roomote_runtime.user_prompt',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'Hidden message' }],
        metadata: { visibleInTranscript: false },
        payload: {},
        source: 'web',
      },
      {
        conversationId: conversation!.id,
        eventId: 'visible-new',
        turnId: 'turn-new',
        turnSeq: 0,
        ts: 3,
        eventType: 'roomote_runtime.tool_result',
        role: 'tool',
        contentBlocks: [{ type: 'text', text: 'Unbounded output' }],
        metadata: { visibleInTranscript: true },
        payload: { output: 'x'.repeat(ACP_UI_TOOL_OUTPUT_MAX_CHARS + 100) },
        source: 'web',
      },
    ]);

    const response = await createApp(owner.id).request(
      `/sessions/${session.id}/messages`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      returned: number;
      messages: Array<{
        text: string;
        metadata: Record<string, unknown> | null;
      }>;
    };
    expect(body.returned).toBe(2);
    expect(body.messages[0]?.text).not.toBe('Unbounded output');
    expect(body.messages[0]?.metadata).toHaveProperty('truncation');
    expect(body.messages[1]?.text).toBe('Older message');

    const sendResponse = await createApp(owner.id).request(
      `/sessions/${session.id}/send_message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Continue this Session' }),
      },
    );
    expect(sendResponse.status).toBe(200);
    expect(mocks.queueFastAgentSurfaceReply).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: conversation!.id,
        question: 'Continue this Session',
      }),
    );

    const legacyIdResponse = await createApp(owner.id).request(
      `/sessions/${conversation!.id}/send_message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Continue from legacy link' }),
      },
    );
    expect(legacyIdResponse.status).toBe(200);
    expect(mocks.queueFastAgentSurfaceReply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: conversation!.id,
        question: 'Continue from legacy link',
      }),
    );
  });

  it('resolves a Fast conversation URL and repairs its missing Session row', async () => {
    const owner = await userFactory.create();
    createdUserIds.push(owner.id);
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: owner.id,
        surface: 'web',
        workspaceId: owner.id,
        conversationId: crypto.randomUUID(),
        title: 'Legacy Session link',
      })
      .returning();
    createdConversationIds.push(conversation!.id);
    await db.insert(fastAgentMessages).values({
      conversationId: conversation!.id,
      eventId: 'legacy-message',
      turnId: 'legacy-turn',
      turnSeq: 0,
      ts: 1,
      eventType: 'roomote_runtime.user_prompt',
      role: 'user',
      contentBlocks: [{ type: 'text', text: 'Inspect this Session' }],
      metadata: { visibleInTranscript: true },
      payload: {},
      source: 'web',
    });

    const summaryResponse = await createApp(owner.id).request(
      `/sessions/${conversation!.id}/summary`,
    );
    expect(summaryResponse.status).toBe(200);
    const summary = (await summaryResponse.json()) as { id: string };
    createdSessionIds.push(summary.id);
    expect(summary.id).not.toBe(conversation!.id);

    const messagesResponse = await createApp(owner.id).request(
      `/sessions/${conversation!.id}/messages`,
    );
    expect(messagesResponse.status).toBe(200);
    await expect(messagesResponse.json()).resolves.toMatchObject({
      sessionId: summary.id,
      messages: [{ text: 'Inspect this Session' }],
    });
  });
});
