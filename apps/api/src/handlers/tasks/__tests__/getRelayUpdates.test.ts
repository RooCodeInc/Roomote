import { Hono } from 'hono';
import {
  db,
  eq,
  runFactory,
  taskFactory,
  taskMessages,
  taskRuns,
  tasks,
  userFactory,
  users,
} from '@roomote/db/server';
import type { AuthTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { getTaskMessages } from '../getTaskMessages';
import { getTaskRelayUpdates } from '../getRelayUpdates';

function createApp(authContext: AuthTokenContext) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('authContext', authContext);
    await next();
  });
  app.use('*', mcpAuthMiddleware);
  app.get('/tasks/:taskId/messages', getTaskMessages);
  app.get('/tasks/:taskId/updates', getTaskRelayUpdates);
  return app;
}

describe('getTaskRelayUpdates', () => {
  const createdTaskIds: string[] = [];
  const createdUserIds: string[] = [];

  afterEach(async () => {
    while (createdTaskIds.length > 0) {
      await db.delete(tasks).where(eq(tasks.id, createdTaskIds.pop()!));
    }
    while (createdUserIds.length > 0) {
      await db.delete(users).where(eq(users.id, createdUserIds.pop()!));
    }
  });

  it('returns bounded narrative deltas, explicit state changes, and stable unchanged polls', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);
    const task = await taskFactory.create({ initiatorUserId: user.id });
    createdTaskIds.push(task.id);
    const run = await runFactory.create({
      taskId: task.id,
      actingUserId: user.id,
      taskPhase: 'waiting_for_user_input',
    });
    await db.insert(taskMessages).values([
      {
        runId: run.id,
        taskId: task.id,
        ts: 1,
        eventType: 'roomote_runtime.user_prompt',
        protocol: 'roomote_runtime',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'Please inspect the failure.' }],
        metadata: { visibleInTranscript: true, credential: 'not-returned' },
        payload: {},
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        runId: run.id,
        taskId: task.id,
        ts: 2,
        eventType: 'roomote_runtime.tool_result',
        protocol: 'roomote_runtime',
        role: 'tool',
        contentBlocks: [{ type: 'text', text: 'x'.repeat(100_000) }],
        metadata: { visibleInTranscript: true },
        payload: { rawTrace: 'not-returned' },
      },
      {
        runId: run.id,
        taskId: task.id,
        ts: 3,
        eventType: 'roomote_runtime.assistant_thought',
        protocol: 'roomote_runtime',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'hidden chain of thought' }],
        metadata: { visibleInTranscript: true },
        payload: {},
      },
      {
        runId: run.id,
        taskId: task.id,
        ts: 4,
        eventType: 'roomote_runtime.assistant_message',
        protocol: 'roomote_runtime',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'Which rollout should I use?' }],
        metadata: { visibleInTranscript: true },
        payload: {},
        createdAt: new Date('2026-01-01T00:00:01.000Z'),
      },
      {
        runId: run.id,
        taskId: task.id,
        ts: 5,
        eventType: 'roomote_runtime.assistant_message',
        protocol: 'roomote_runtime',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'private narrative' }],
        metadata: { visibleInTranscript: false },
        payload: {},
        createdAt: new Date('2026-01-01T00:00:02.000Z'),
      },
    ]);

    const app = createApp({
      userId: user.id,
      tokenType: 'auth',
      version: 1,
    });
    const legacyResponse = await app.request(`/tasks/${task.id}/messages`);
    const legacyPayload = await legacyResponse.text();
    const firstResponse = await app.request(`/tasks/${task.id}/updates`);
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as {
      narrative: Array<{ direction: string; text: string }>;
      responseNeeded: boolean;
      state: { changed: boolean };
      nextCursor: string;
    };
    expect(first.narrative).toEqual([
      {
        id: expect.any(String),
        ts: 1,
        direction: 'Codex → Roomote',
        text: 'Please inspect the failure.',
        truncated: false,
      },
      {
        id: expect.any(String),
        ts: 4,
        direction: 'Roomote → Codex',
        text: 'Which rollout should I use?',
        truncated: false,
      },
    ]);
    expect(first.responseNeeded).toBe(true);
    expect(first.state.changed).toBe(true);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain('hidden chain of thought');
    expect(serialized).not.toContain('private narrative');
    expect(serialized).not.toContain('not-returned');
    expect(Buffer.byteLength(legacyPayload)).toBe(101_046);
    expect(Buffer.byteLength(serialized)).toBe(858);

    const unchangedResponse = await app.request(
      `/tasks/${task.id}/updates?cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    const unchanged = (await unchangedResponse.json()) as {
      narrative: unknown[];
      state: { changed: boolean };
      nextCursor: string;
    };
    expect(unchanged.narrative).toEqual([]);
    expect(unchanged.state.changed).toBe(false);
    expect(unchanged.nextCursor).toBe(first.nextCursor);

    await db
      .update(taskRuns)
      .set({ taskPhase: 'waiting_for_prompt' })
      .where(eq(taskRuns.id, run.id));
    const stateResponse = await app.request(
      `/tasks/${task.id}/updates?cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    await expect(stateResponse.json()).resolves.toMatchObject({
      narrative: [],
      responseNeeded: false,
      state: {
        changed: true,
        current: { taskPhase: 'waiting_for_prompt' },
      },
    });
  });

  it('paginates deterministically without duplicates and rejects a cursor for another target', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);
    const task = await taskFactory.create({ initiatorUserId: user.id });
    createdTaskIds.push(task.id);
    const otherTask = await taskFactory.create({ initiatorUserId: user.id });
    createdTaskIds.push(otherTask.id);
    const run = await runFactory.create({
      taskId: task.id,
      actingUserId: user.id,
    });
    await db.insert(taskMessages).values([
      {
        runId: run.id,
        taskId: task.id,
        ts: 10,
        eventType: 'roomote_runtime.user_prompt',
        protocol: 'roomote_runtime',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'First' }],
        metadata: {},
        payload: {},
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        runId: run.id,
        taskId: task.id,
        ts: 11,
        eventType: 'roomote_runtime.assistant_message',
        protocol: 'roomote_runtime',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'Second' }],
        metadata: {},
        payload: {},
        createdAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    ]);
    const app = createApp({ userId: user.id, tokenType: 'auth', version: 1 });
    const firstResponse = await app.request(
      `/tasks/${task.id}/updates?limit=1`,
    );
    const first = (await firstResponse.json()) as {
      narrative: Array<{ text: string }>;
      hasMore: boolean;
      nextCursor: string;
    };
    expect(first.narrative.map((message) => message.text)).toEqual(['First']);
    expect(first.hasMore).toBe(true);

    const retry = await app.request(`/tasks/${task.id}/updates?limit=1`);
    await expect(retry.json()).resolves.toMatchObject({
      narrative: first.narrative,
    });
    const secondResponse = await app.request(
      `/tasks/${task.id}/updates?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    const second = (await secondResponse.json()) as {
      narrative: Array<{ text: string }>;
      hasMore: boolean;
      nextCursor: string;
    };
    expect(second).toMatchObject({
      narrative: [{ text: 'Second' }],
      hasMore: false,
    });

    await db.insert(taskMessages).values({
      runId: run.id,
      taskId: task.id,
      ts: 5,
      eventType: 'roomote_runtime.assistant_message',
      protocol: 'roomote_runtime',
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'Late lower timestamp' }],
      metadata: {},
      payload: {},
    });
    const late = await app.request(
      `/tasks/${task.id}/updates?cursor=${encodeURIComponent(second.nextCursor)}`,
    );
    await expect(late.json()).resolves.toMatchObject({
      narrative: [{ text: 'Late lower timestamp', ts: 5 }],
    });
    const wrongTarget = await app.request(
      `/tasks/${otherTask.id}/updates?cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    expect(wrongTarget.status).toBe(400);
  });

  it('relays typed structured questions and never exposes raw request or answer payload fields', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);
    const task = await taskFactory.create({ initiatorUserId: user.id });
    createdTaskIds.push(task.id);
    const run = await runFactory.create({
      taskId: task.id,
      actingUserId: user.id,
      taskPhase: 'waiting_for_prompt',
    });
    await db.insert(taskMessages).values({
      runId: run.id,
      taskId: task.id,
      ts: 20,
      eventType: 'roomote_runtime.request_user_input',
      protocol: 'roomote_runtime',
      role: 'assistant',
      contentBlocks: [],
      metadata: { visibleInTranscript: true, credential: 'metadata-secret' },
      payload: {
        requestId: 'rui:test',
        sessionId: 'session-internal',
        turnId: 'turn-internal',
        callId: 'call-internal',
        status: 'pending',
        questions: [
          {
            id: 'rollout',
            header: 'Rollout',
            question: 'Which rollout should I use?',
            isOther: false,
            isSecret: false,
            options: [
              { label: 'Canary', description: 'Start with a small cohort.' },
              { label: 'Global', description: 'Release to everyone.' },
            ],
          },
        ],
        unsafeRawPayload: 'payload-secret',
      },
    });
    const app = createApp({ userId: user.id, tokenType: 'auth', version: 1 });
    const requestResponse = await app.request(`/tasks/${task.id}/updates`);
    const requestUpdate = (await requestResponse.json()) as {
      narrative: Array<{ text: string }>;
      responseNeeded: boolean;
      nextCursor: string;
    };
    expect(requestUpdate.responseNeeded).toBe(true);
    expect(requestUpdate.narrative).toEqual([
      expect.objectContaining({
        direction: 'Roomote → Codex',
        text: [
          'Which rollout should I use?',
          '1. Canary - Start with a small cohort.',
          '2. Global - Release to everyone.',
        ].join('\n'),
      }),
    ]);
    const serializedRequest = JSON.stringify(requestUpdate);
    expect(serializedRequest).not.toContain('metadata-secret');
    expect(serializedRequest).not.toContain('payload-secret');
    expect(serializedRequest).not.toContain('session-internal');
    expect(serializedRequest).not.toContain('call-internal');

    await db.insert(taskMessages).values({
      runId: run.id,
      taskId: task.id,
      ts: 21,
      eventType: 'roomote_runtime.request_user_input_response',
      protocol: 'roomote_runtime',
      role: 'user',
      contentBlocks: [],
      metadata: { visibleInTranscript: true },
      payload: {
        requestId: 'rui:test',
        sessionId: 'session-internal',
        turnId: 'turn-internal',
        callId: 'call-internal',
        resolution: 'submitted',
        answers: { rollout: { answers: ['credential-value'] } },
      },
    });
    const responseUpdateResponse = await app.request(
      `/tasks/${task.id}/updates?cursor=${encodeURIComponent(requestUpdate.nextCursor)}`,
    );
    const responseUpdate = await responseUpdateResponse.json();
    expect(responseUpdate).toMatchObject({
      responseNeeded: false,
      narrative: [
        {
          direction: 'Codex → Roomote',
          text: 'Submitted input response',
        },
      ],
    });
    expect(JSON.stringify(responseUpdate)).not.toContain('credential-value');

    const caughtUpResponse = await app.request(`/tasks/${task.id}/updates`);
    await expect(caughtUpResponse.json()).resolves.toMatchObject({
      responseNeeded: false,
      narrative: [
        {
          text: 'Which rollout should I use?\n1. Canary - Start with a small cohort.\n2. Global - Release to everyone.',
        },
        { text: 'Submitted input response' },
      ],
    });
  });
});
