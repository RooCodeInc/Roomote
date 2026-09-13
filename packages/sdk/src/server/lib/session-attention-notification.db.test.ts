import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  db,
  fastAgentConversations,
  runFactory,
  sessionFactory,
  sessionTasks,
  taskFactory,
  userFactory,
} from '@roomote/db/server';

const mocks = vi.hoisted(() => ({
  isPresent: vi.fn(),
  send: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  isSessionUserPresent: mocks.isPresent,
}));
vi.mock('./user-direct-message', () => ({
  sendUserDirectMessageBestEffortWithReceipts: mocks.send,
}));

import {
  findSessionAttentionNotificationReply,
  notifyDirectWebTaskAttention,
  notifyFastWebSessionAttention,
} from './session-attention-notification';

async function createDirectWebRun(payload: Record<string, unknown> = {}) {
  const user = await userFactory.create();
  const task = await taskFactory.create({
    initiatorUserId: user.id,
    surface: 'web',
    title: 'Review the result',
  });
  const run = await runFactory.create({ taskId: task.id, payload });
  const session = await sessionFactory.create({
    ownerKind: 'user',
    ownerUserId: user.id,
    sourceSurface: 'web',
    sourceTrigger: 'message',
  });
  await db.insert(sessionTasks).values({
    sessionId: session.id,
    taskId: task.id,
    origin: 'direct_launch',
  });
  return { user, task, run, session };
}

describe('session attention notifications', () => {
  let messageId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isPresent.mockResolvedValue(false);
    messageId = crypto.randomUUID();
    mocks.send.mockResolvedValue([
      {
        provider: 'slack',
        workspaceId: 'T1',
        channelId: 'D1',
        messageId,
      },
    ]);
  });

  it('notifies nonterminal direct-task completions once per completion id', async () => {
    const { run } = await createDirectWebRun();

    await expect(
      notifyDirectWebTaskAttention({
        runId: run.id,
        kind: 'result_ready',
        eventId: 'completion-1',
      }),
    ).resolves.toBe('delivered');
    await expect(
      notifyDirectWebTaskAttention({
        runId: run.id,
        kind: 'result_ready',
        eventId: 'completion-1',
      }),
    ).resolves.toBe('already_claimed');
    await expect(
      notifyDirectWebTaskAttention({
        runId: run.id,
        kind: 'result_ready',
        eventId: 'completion-2',
      }),
    ).resolves.toBe('delivered');

    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it('durably suppresses input-needed delivery while the user is present', async () => {
    const { run } = await createDirectWebRun();
    mocks.isPresent.mockResolvedValueOnce(true);

    await expect(
      notifyDirectWebTaskAttention({
        runId: run.id,
        kind: 'input_needed',
        eventId: 'request-1',
      }),
    ).resolves.toBe('skipped');
    await expect(
      notifyDirectWebTaskAttention({
        runId: run.id,
        kind: 'input_needed',
        eventId: 'request-1',
      }),
    ).resolves.toBe('already_claimed');

    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('leaves Fast-delegated child attention to the parent Session', async () => {
    const { run } = await createDirectWebRun({
      fastAgentParent: {
        sessionId: crypto.randomUUID(),
        conversation: {
          surface: 'web',
          workspaceId: 'web',
          conversationId: crypto.randomUUID(),
        },
      },
    });

    await expect(
      notifyDirectWebTaskAttention({
        runId: run.id,
        kind: 'result_ready',
        eventId: 'completion-child',
      }),
    ).resolves.toBe('not_applicable');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('deduplicates Fast web attention by durable turn id', async () => {
    const user = await userFactory.create();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'web',
        workspaceId: 'web',
        conversationId: crypto.randomUUID(),
      })
      .returning();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: user.id,
      sourceSurface: 'web',
      sourceTrigger: 'message',
      fastConversationId: conversation!.id,
    });

    await expect(
      notifyFastWebSessionAttention({
        fastConversationId: conversation!.id,
        kind: 'result_ready',
        eventId: 'turn-1',
      }),
    ).resolves.toBe('delivered');
    await expect(
      notifyFastWebSessionAttention({
        fastConversationId: conversation!.id,
        kind: 'result_ready',
        eventId: 'turn-1',
      }),
    ).resolves.toBe('already_claimed');

    await expect(
      findSessionAttentionNotificationReply({
        provider: 'slack',
        workspaceId: 'T1',
        channelId: 'D1',
        userId: user.id,
        replyToMessageId: messageId,
      }),
    ).resolves.toEqual({ sessionId: session.id, kind: 'result_ready' });
    await expect(
      findSessionAttentionNotificationReply({
        provider: 'slack',
        workspaceId: 'T1',
        channelId: 'D1',
        userId: 'someone-else',
        replyToMessageId: messageId,
      }),
    ).resolves.toBeNull();
  });

  it('records reply anchors for every supported personal provider', async () => {
    const { run, user, session } = await createDirectWebRun();
    const providers = [
      ['slack', 'team', 'slack-dm', 'slack-message'],
      ['teams', 'tenant', 'teams-dm', 'teams-message'],
      ['telegram', 'telegram-chat', 'telegram-chat', 'telegram-message'],
      ['discord', 'dm', 'discord-dm', 'discord-message'],
      ['agentmail', 'inbox@example.com', 'email-conversation', 'email-message'],
    ] as const;
    mocks.send.mockResolvedValue(
      providers.map(
        ([provider, workspaceId, channelId, providerMessageId]) => ({
          provider,
          workspaceId,
          channelId,
          messageId: `${providerMessageId}:${messageId}`,
          ...(provider === 'agentmail'
            ? { threadId: `email-thread:${messageId}` }
            : {}),
        }),
      ),
    );

    await notifyDirectWebTaskAttention({
      runId: run.id,
      kind: 'result_ready',
      eventId: 'completion-providers',
    });

    for (const [
      provider,
      workspaceId,
      channelId,
      providerMessageId,
    ] of providers) {
      await expect(
        findSessionAttentionNotificationReply({
          provider,
          workspaceId,
          channelId,
          userId: user.id,
          replyToMessageId: `${providerMessageId}:${messageId}`,
        }),
      ).resolves.toEqual({ sessionId: session.id, kind: 'result_ready' });
    }
  });
});
