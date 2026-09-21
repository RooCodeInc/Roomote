const mocks = vi.hoisted(() => ({
  queueReply: vi.fn(),
  sendMessageToTask: vi.fn(),
  steerMessageToTask: vi.fn(),
}));

vi.mock('@roomote/sdk/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/sdk/server')>();
  return { ...original, queueFastAgentSurfaceReply: mocks.queueReply };
});

vi.mock('../sendMessageToTask', () => ({
  sendMessageToTask: mocks.sendMessageToTask,
  steerMessageToTask: mocks.steerMessageToTask,
}));

import { Hono } from 'hono';
import type { AuthTokenContext, RunTokenContext } from '@roomote/types';
import {
  db,
  fastAgentConversations,
  fastAgentMessages,
  ensureSessionForFastConversation,
  runFactory,
  taskFactory,
  taskMessages,
  userFactory,
} from '@roomote/db/server';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { getTaskMessages } from '../getTaskMessages';
import { sendMessage } from '../sendMessage';
import { steerMessage } from '../steerMessage';

function createApp(authContext: AuthTokenContext | RunTokenContext) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('authContext', authContext);
    await next();
  });
  app.use('*', mcpAuthMiddleware);
  app.get('/tasks/:taskId/messages', getTaskMessages);
  app.post('/tasks/:taskId/send_message', sendMessage);
  app.post('/tasks/:taskId/steer_message', steerMessage);
  return app;
}

async function createSession(userId: string) {
  const [session] = await db
    .insert(fastAgentConversations)
    .values({
      userId,
      surface: 'web',
      workspaceId: userId,
      conversationId: crypto.randomUUID(),
    })
    .returning();
  return session!;
}

async function addMessage(input: {
  sessionId: string;
  eventId: string;
  userId?: string;
  visible?: boolean;
  text?: string;
  ts?: number;
}) {
  await db.insert(fastAgentMessages).values({
    conversationId: input.sessionId,
    eventId: input.eventId,
    turnId: input.eventId,
    turnSeq: 0,
    ts: input.ts ?? Date.now(),
    eventType: 'roomote_runtime.user_prompt',
    role: 'user',
    contentBlocks: [{ type: 'text', text: input.text ?? input.eventId }],
    metadata: {
      visibleInTranscript: input.visible ?? true,
      ...(input.userId ? { userId: input.userId } : {}),
    },
    payload: {},
    source: 'web',
  });
}

function userAuth(userId: string): AuthTokenContext {
  return { userId, tokenType: 'auth', version: 1 };
}

describe('Fast session communication through task routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queueReply.mockResolvedValue(true);
    mocks.sendMessageToTask.mockResolvedValue({
      success: false,
      status: 404,
      error: 'Task not found',
    });
    mocks.steerMessageToTask.mockResolvedValue({
      success: false,
      status: 404,
      error: 'Task not found',
    });
  });

  it('returns visible Fast transcript messages with the task-shaped contract', async () => {
    const owner = await userFactory.create();
    const participant = await userFactory.create();
    const session = await createSession(owner.id);
    await addMessage({
      sessionId: session.id,
      eventId: 'participant-message',
      userId: participant.id,
      text: 'Participant text',
      ts: 1,
    });
    await addMessage({
      sessionId: session.id,
      eventId: 'newest-message',
      text: 'Newest text',
      ts: 3,
    });
    await addMessage({
      sessionId: session.id,
      eventId: 'hidden-message',
      visible: false,
      ts: 2,
    });

    for (const userId of [owner.id, participant.id]) {
      const response = await createApp(userAuth(userId)).request(
        `/tasks/${session.id}/messages`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        returned: 2,
        messages: [
          {
            taskId: session.id,
            text: 'Participant text',
            visibleInTranscript: true,
          },
          {
            taskId: session.id,
            text: 'Newest text',
            visibleInTranscript: true,
          },
        ],
      });
    }
  });

  it('continues past hidden rows to satisfy a limited task transcript', async () => {
    const owner = await userFactory.create();
    const task = await taskFactory.create({ initiatorUserId: owner.id });
    const run = await runFactory.create({
      taskId: task.id,
      actingUserId: owner.id,
    });
    const messages: Array<typeof taskMessages.$inferInsert> = [
      {
        runId: run.id,
        taskId: task.id,
        ts: 1,
        eventType: 'roomote_runtime.assistant_text',
        protocol: 'roomote_runtime',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'Oldest visible' }],
        metadata: { visibleInTranscript: true },
        payload: {},
      },
      {
        runId: run.id,
        taskId: task.id,
        ts: 2,
        eventType: 'roomote_runtime.assistant_text',
        protocol: 'roomote_runtime',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'Newest visible' }],
        metadata: { visibleInTranscript: true },
        payload: {},
      },
      {
        runId: run.id,
        taskId: task.id,
        ts: 3,
        eventType: 'roomote_runtime.user_prompt',
        protocol: 'roomote_runtime',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'Hidden prompt' }],
        metadata: { visibleInTranscript: false },
        payload: {},
      },
    ];
    await db.insert(taskMessages).values(messages);

    const response = await createApp(userAuth(owner.id)).request(
      `/tasks/${task.id}/messages?limit=2&order=desc`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      returned: 2,
      messages: [{ text: 'Newest visible' }, { text: 'Oldest visible' }],
    });
  });

  it('walks stable backward pages across replayed and equal-timestamp events', async () => {
    const owner = await userFactory.create();
    const task = await taskFactory.create({ initiatorUserId: owner.id });
    const run = await runFactory.create({
      taskId: task.id,
      actingUserId: owner.id,
    });
    const createdAt = new Date('2026-04-21T12:00:00.000Z');
    await db.insert(taskMessages).values([
      {
        runId: run.id,
        taskId: task.id,
        ts: 20,
        eventType: 'roomote_runtime.assistant_text',
        protocol: 'roomote_runtime',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'latest' }],
        metadata: {},
        payload: {},
        createdAt,
      },
      {
        runId: run.id,
        taskId: task.id,
        ts: 10,
        eventType: 'roomote_runtime.user_prompt',
        protocol: 'roomote_runtime',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'replayed prompt' }],
        metadata: {},
        payload: {},
        createdAt,
      },
      {
        runId: run.id,
        taskId: task.id,
        ts: 10,
        eventType: 'roomote_runtime.plan',
        protocol: 'roomote_runtime',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'replayed plan' }],
        metadata: {},
        payload: {},
        createdAt,
      },
      {
        runId: run.id,
        taskId: task.id,
        ts: 1,
        eventType: 'roomote_runtime.system_notice',
        protocol: 'roomote_runtime',
        role: 'system',
        contentBlocks: [{ type: 'text', text: 'older resumed run' }],
        metadata: {},
        payload: {},
        createdAt,
      },
    ]);

    const firstResponse = await createApp(userAuth(owner.id)).request(
      `/tasks/${task.id}/messages?limit=2&order=desc`,
    );
    const first = (await firstResponse.json()) as {
      messages: Array<{ id: string; text: string | null }>;
      hasMore: boolean;
      nextCursor: string | null;
      coverage: { complete: boolean };
    };
    expect(firstResponse.status).toBe(200);
    expect(first.messages.map((message) => message.text)).toContain('latest');
    expect(first.messages).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.coverage.complete).toBe(false);
    expect(first.nextCursor).toEqual(expect.any(String));

    const secondResponse = await createApp(userAuth(owner.id)).request(
      `/tasks/${task.id}/messages?limit=2&order=desc&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    const second = (await secondResponse.json()) as {
      messages: Array<{ id: string; text: string | null }>;
      hasMore: boolean;
      nextCursor: string | null;
      coverage: { complete: boolean };
    };
    expect(secondResponse.status).toBe(200);
    expect(second.messages.map((message) => message.text)).toContain(
      'older resumed run',
    );
    expect(second.messages).toHaveLength(2);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(second.coverage.complete).toBe(true);
    expect(
      new Set(
        [...first.messages, ...second.messages].map((message) => message.id),
      ).size,
    ).toBe(4);
    expect(
      new Set(
        [...first.messages, ...second.messages].map((message) => message.text),
      ),
    ).toEqual(
      new Set([
        'latest',
        'replayed prompt',
        'replayed plan',
        'older resumed run',
      ]),
    );
  });

  it('freezes a paging snapshot and reports concurrent arrivals', async () => {
    const owner = await userFactory.create();
    const task = await taskFactory.create({ initiatorUserId: owner.id });
    const run = await runFactory.create({
      taskId: task.id,
      actingUserId: owner.id,
    });
    await db.insert(taskMessages).values([
      {
        runId: run.id,
        taskId: task.id,
        ts: 3,
        eventType: 'roomote_runtime.assistant_text',
        protocol: 'roomote_runtime',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'newest before page one' }],
        metadata: {},
        payload: {},
        createdAt: new Date('2026-04-21T12:00:03.000Z'),
      },
      {
        runId: run.id,
        taskId: task.id,
        ts: 2,
        eventType: 'roomote_runtime.user_prompt',
        protocol: 'roomote_runtime',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'older before page one' }],
        metadata: {},
        payload: {},
        createdAt: new Date('2026-04-21T12:00:02.000Z'),
      },
    ]);

    const first = (await (
      await createApp(userAuth(owner.id)).request(
        `/tasks/${task.id}/messages?limit=1&order=desc`,
      )
    ).json()) as { nextCursor: string };

    await db.insert(taskMessages).values({
      runId: run.id,
      taskId: task.id,
      ts: 4,
      eventType: 'roomote_runtime.tool_result',
      protocol: 'roomote_runtime',
      role: 'tool',
      contentBlocks: [{ type: 'text', text: 'arrived after page one' }],
      metadata: {},
      payload: {},
      createdAt: new Date('2026-04-21T12:00:04.000Z'),
    });

    const secondResponse = await createApp(userAuth(owner.id)).request(
      `/tasks/${task.id}/messages?limit=1&order=desc&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    await expect(secondResponse.json()).resolves.toMatchObject({
      messages: [{ text: 'older before page one' }],
      hasMore: false,
      hasNewer: true,
      coverage: { complete: true },
    });
  });

  it('caps oversized transcript pages and supplies a continuation cursor', async () => {
    const owner = await userFactory.create();
    const task = await taskFactory.create({ initiatorUserId: owner.id });
    const run = await runFactory.create({
      taskId: task.id,
      actingUserId: owner.id,
    });
    const text = 'x'.repeat(20_000);
    await db.insert(taskMessages).values(
      Array.from({ length: 30 }, (_, index) => ({
        runId: run.id,
        taskId: task.id,
        ts: index + 1,
        eventType: `roomote_runtime.replay_${index}` as const,
        protocol: 'roomote_runtime' as const,
        role: 'assistant' as const,
        contentBlocks: [{ type: 'text' as const, text }],
        metadata: {},
        payload: {},
        createdAt: new Date(
          `2026-04-21T12:00:${String(index).padStart(2, '0')}.000Z`,
        ),
      })),
    );

    const response = await createApp(userAuth(owner.id)).request(
      `/tasks/${task.id}/messages?limit=100&order=desc`,
    );
    const body = (await response.json()) as {
      messages: Array<{ text: string | null }>;
      returned: number;
      hasMore: boolean;
      truncated: boolean;
      nextCursor: string | null;
    };
    expect(response.status).toBe(200);
    expect(body.returned).toBeLessThan(30);
    expect(body.hasMore).toBe(true);
    expect(body.truncated).toBe(true);
    expect(body.nextCursor).toEqual(expect.any(String));
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThan(
      300_000,
    );
    expect(
      body.messages.every((message) => (message.text?.length ?? 0) <= 20_003),
    ).toBe(true);
  });

  it('rejects oversized or cross-task cursors after task authorization', async () => {
    const owner = await userFactory.create();
    const firstTask = await taskFactory.create({ initiatorUserId: owner.id });
    const secondTask = await taskFactory.create({ initiatorUserId: owner.id });
    const run = await runFactory.create({
      taskId: firstTask.id,
      actingUserId: owner.id,
    });
    await db.insert(taskMessages).values({
      runId: run.id,
      taskId: firstTask.id,
      ts: 1,
      eventType: 'roomote_runtime.assistant_text',
      protocol: 'roomote_runtime',
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'cursor source' }],
      metadata: {},
      payload: {},
    });
    const first = (await (
      await createApp(userAuth(owner.id)).request(
        `/tasks/${firstTask.id}/messages?limit=1&order=desc`,
      )
    ).json()) as { nextCursor: string };

    const crossTask = await createApp(userAuth(owner.id)).request(
      `/tasks/${secondTask.id}/messages?cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    expect(crossTask.status).toBe(400);

    const oversized = await createApp(userAuth(owner.id)).request(
      `/tasks/${firstTask.id}/messages?cursor=${'a'.repeat(4097)}`,
    );
    expect(oversized.status).toBe(400);
  });

  it('shares Fast sessions with bystanders but rejects absent or invalid IDs', async () => {
    const owner = await userFactory.create();
    const bystander = await userFactory.create();
    const session = await createSession(owner.id);

    const shared = await createApp(userAuth(bystander.id)).request(
      `/tasks/${session.id}/messages`,
    );
    expect(shared.status).toBe(200);

    for (const taskId of [crypto.randomUUID(), 'not-an-id']) {
      const response = await createApp(userAuth(bystander.id)).request(
        `/tasks/${taskId}/messages`,
      );
      expect(response.status).toBe(404);
    }
  });

  it('queues participant follow-ups after normal task resolution misses', async () => {
    const owner = await userFactory.create();
    const participant = await userFactory.create();
    const session = await createSession(owner.id);
    await addMessage({
      sessionId: session.id,
      eventId: 'participant-message',
      userId: participant.id,
    });

    const response = await createApp(userAuth(participant.id)).request(
      `/tasks/${session.id}/send_message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Continue this conversation',
          images: ['https://example.com/member.png'],
        }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sent: {
        direction: 'Codex → Roomote',
        target: { kind: 'task', id: session.id },
        text: 'Continue this conversation',
      },
    });
    expect(mocks.sendMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: session.id }),
    );
    expect(mocks.queueReply).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        userId: participant.id,
        question: 'Continue this conversation',
        images: ['https://example.com/member.png'],
      }),
    );
  });

  it('requires canonical unified Session IDs to use Session routes', async () => {
    const owner = await userFactory.create();
    const fastSession = await createSession(owner.id);
    const session = await ensureSessionForFastConversation(db, fastSession.id);
    await addMessage({
      sessionId: fastSession.id,
      eventId: 'unified-session-message',
      text: 'Unified session text',
    });

    const app = createApp(userAuth(owner.id));
    const messagesResponse = await app.request(`/tasks/${session.id}/messages`);
    expect(messagesResponse.status).toBe(404);

    const sendResponse = await app.request(
      `/tasks/${session.id}/send_message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Continue unified session' }),
      },
    );
    expect(sendResponse.status).toBe(404);
    expect(mocks.queueReply).not.toHaveBeenCalled();
  });

  it('uses the same Fast fallback for the worker steering route', async () => {
    const owner = await userFactory.create();
    const session = await createSession(owner.id);

    const response = await createApp(userAuth(owner.id)).request(
      `/tasks/${session.id}/steer_message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Worker follow-up',
          images: ['https://example.com/worker.png'],
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(mocks.steerMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: session.id }),
    );
    expect(mocks.queueReply).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        question: 'Worker follow-up',
        images: ['https://example.com/worker.png'],
      }),
    );
  });

  it('preserves normal task send behavior without attempting Fast delivery', async () => {
    const user = await userFactory.create();
    mocks.sendMessageToTask.mockResolvedValueOnce({
      success: true,
      result: { queued: true },
    });

    const response = await createApp(userAuth(user.id)).request(
      '/tasks/normal-task/send_message',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Normal follow-up' }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sent: {
        direction: 'Codex → Roomote',
        target: { kind: 'task', id: 'normal-task' },
        text: 'Normal follow-up',
      },
    });
    expect(mocks.queueReply).not.toHaveBeenCalled();
  });

  it('preserves actor and provider boundaries for Fast sends', async () => {
    const owner = await userFactory.create();
    const bystander = await userFactory.create();
    const session = await createSession(owner.id);

    const bystanderSend = await createApp(userAuth(bystander.id)).request(
      `/tasks/${session.id}/send_message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Deployment users can reply' }),
      },
    );
    expect(bystanderSend.status).toBe(200);

    // A run without a human driver mints a user-less token. The handler
    // resolves the actor from the run's acting user, then the task's human
    // owner; an automation task with neither still has no actor.
    const orphanTask = await taskFactory.create();
    const orphanRun = await runFactory.create({
      taskId: orphanTask.id,
      actingUserId: null,
    });
    const deploymentRun: RunTokenContext = {
      runId: orphanRun.id,
      userId: null,
      principal: 'deployment',
      tokenType: 'run',
      version: 1,
    };
    const noActor = await createApp(deploymentRun).request(
      `/tasks/${session.id}/send_message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'No actor' }),
      },
    );
    expect(noActor.status).toBe(403);

    // The same token shape resolves to the task's human owner when one exists.
    const ownedTask = await taskFactory.create({ initiatorUserId: owner.id });
    const ownedRun = await runFactory.create({
      taskId: ownedTask.id,
      actingUserId: null,
    });
    const ownerResolved = await createApp({
      ...deploymentRun,
      runId: ownedRun.id,
    }).request(`/tasks/${session.id}/send_message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Resolved through task owner' }),
    });
    expect(ownerResolved.status).toBe(200);

    mocks.queueReply.mockResolvedValueOnce(false);
    const unavailable = await createApp(userAuth(owner.id)).request(
      `/tasks/${session.id}/send_message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Try delivery' }),
      },
    );
    expect(unavailable.status).toBe(409);
  });
});
