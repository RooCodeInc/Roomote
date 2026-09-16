import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  db,
  createChatInitiationOrder,
  fastAgentConversations,
  fastAgentMessages,
  recordUserChatInitiationProvider,
  runFactory,
  sessionFactory,
  sessionTasks,
  taskFactory,
  taskMessages,
  userFactory,
} from '@roomote/db/server';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  enqueueIosPush: vi.fn(),
  hasAny: vi.fn(),
  isPresent: vi.fn(),
  send: vi.fn(),
  voiceActive: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  isSessionUserPresent: mocks.isPresent,
  isSessionVoiceCallActive: mocks.voiceActive,
}));
vi.mock('./user-direct-message', () => ({
  hasAnyUserDirectMessageIdentity: mocks.hasAny,
  sendUserDirectMessageBestEffortWithReceipts: mocks.send,
}));
vi.mock('./enqueue-session-attention-notification', () => ({
  enqueueSessionAttentionNotification: mocks.enqueue,
}));
vi.mock('./ios-push/enqueue', () => ({
  enqueueIosPush: mocks.enqueueIosPush,
}));

import {
  findSessionAttentionNotificationReply,
  hasTaskRunAttentionNotification,
  notifyDirectWebTaskAttention,
  notifyFastWebSessionAttention,
} from './session-attention-notification';

async function createDirectWebRun(payload: Record<string, unknown> = {}) {
  const user = await userFactory.create();
  const task = await taskFactory.create({
    initiatorUserId: user.id,
    surface: 'web',
    title: 'Review the result',
    prompt: 'Please review the build result.',
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

async function createFastWebSession(initialPrompt = 'What time is it?') {
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
  await insertFastMessage({
    conversationId: conversation!.id,
    eventId: 'initial:user',
    turnId: 'initial',
    turnSeq: 0,
    ts: 1_000,
    role: 'user',
    text: initialPrompt,
  });
  return { conversation: conversation!, session, user };
}

async function insertFastMessage(input: {
  conversationId: string;
  eventId: string;
  turnId: string;
  turnSeq: number;
  ts: number;
  role: 'user' | 'assistant';
  text: string;
  source?: string;
  purpose?: 'closeout' | 'clarification' | 'progress';
  visibleInTranscript?: boolean;
  inferenceRetryNotice?: boolean;
  eventType?:
    | 'roomote_runtime.user_prompt'
    | 'roomote_runtime.assistant_message'
    | 'roomote_runtime.request_user_input'
    | 'roomote_runtime.capability_offer';
  payload?: Record<string, unknown>;
}) {
  const [message] = await db
    .insert(fastAgentMessages)
    .values({
      conversationId: input.conversationId,
      eventId: input.eventId,
      turnId: input.turnId,
      turnSeq: input.turnSeq,
      ts: input.ts,
      eventType:
        input.eventType ??
        (input.role === 'user'
          ? 'roomote_runtime.user_prompt'
          : 'roomote_runtime.assistant_message'),
      role: input.role,
      contentBlocks: [{ type: 'text', text: input.text }],
      metadata: {
        visibleInTranscript: input.visibleInTranscript ?? true,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(input.inferenceRetryNotice ? { inferenceRetryNotice: true } : {}),
      },
      payload:
        input.payload ?? (input.purpose ? { purpose: input.purpose } : {}),
      source: input.source ?? 'web',
    })
    .returning();
  return message!;
}

describe('session attention notifications', () => {
  let messageId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isPresent.mockResolvedValue(false);
    mocks.hasAny.mockResolvedValue(true);
    mocks.enqueue.mockResolvedValue(true);
    mocks.enqueueIosPush.mockResolvedValue(true);
    mocks.voiceActive.mockResolvedValue(false);
    messageId = crypto.randomUUID();
    mocks.send.mockResolvedValue({
      deliveredProviders: ['slack'],
      receipts: [
        {
          provider: 'slack',
          workspaceId: 'T1',
          channelId: 'D1',
          messageId,
        },
      ],
    });
  });

  it('records suppression while voice is connected and preserves later disconnected delivery', async () => {
    const { conversation, session, user } = await createFastWebSession();
    mocks.voiceActive.mockResolvedValueOnce(true);

    await expect(
      notifyFastWebSessionAttention({
        fastConversationId: conversation.id,
        kind: 'result_ready',
        eventId: 'voice-turn',
        message: 'The answer was spoken on the call.',
        manual: true,
      }),
    ).resolves.toBe('skipped');

    expect(mocks.voiceActive).toHaveBeenCalledWith({
      sessionId: session.id,
      userId: user.id,
    });
    expect(mocks.hasAny).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();

    await expect(
      notifyFastWebSessionAttention(
        {
          fastConversationId: conversation.id,
          kind: 'result_ready',
          eventId: 'voice-turn',
          message: 'The answer was spoken on the call.',
          manual: true,
        },
        false,
      ),
    ).resolves.toBe('already_claimed');

    await expect(
      notifyFastWebSessionAttention({
        fastConversationId: conversation.id,
        kind: 'result_ready',
        eventId: 'after-call',
        message: 'The answer now needs a notification.',
        manual: true,
      }),
    ).resolves.toBe('delivered');

    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it('notifies defensively when the voice-call lease cannot be read', async () => {
    const { conversation } = await createFastWebSession();
    mocks.voiceActive.mockRejectedValueOnce(new Error('redis unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      notifyFastWebSessionAttention({
        fastConversationId: conversation.id,
        kind: 'result_ready',
        eventId: 'voice-state-error',
        message: 'The answer is ready.',
        manual: true,
      }),
    ).resolves.toBe('delivered');

    expect(mocks.send).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Voice state lookup failed'),
    );
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
    expect(mocks.enqueue).toHaveBeenCalledWith(
      {
        target: 'task',
        runId: run.id,
        kind: 'result_ready',
        eventId: 'completion-1',
      },
      { delay: 125_000 },
    );
    expect(mocks.enqueue.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.send.mock.invocationCallOrder[0]!,
    );
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

  it('delivers the persisted task response instead of a title wrapper', async () => {
    const { run, task } = await createDirectWebRun();
    await db.insert(taskMessages).values({
      runId: run.id,
      taskId: task.id,
      ts: Date.now(),
      eventType: 'roomote_runtime.assistant_message',
      role: 'assistant',
      protocol: 'roomote_runtime',
      contentBlocks: [
        { type: 'text', text: 'The build completed successfully.' },
      ],
      payload: {},
    });

    await notifyDirectWebTaskAttention({
      runId: run.id,
      kind: 'result_ready',
      eventId: 'completion-with-content',
    });

    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('The build completed successfully.'),
      }),
    );
    expect(mocks.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining(task.title) }),
    );
  });

  it('uses the recipient task-starting chat preference for a new route', async () => {
    const { run, user } = await createDirectWebRun();
    await recordUserChatInitiationProvider(
      user.id,
      'discord',
      createChatInitiationOrder(),
    );

    await notifyDirectWebTaskAttention({
      runId: run.id,
      kind: 'result_ready',
      eventId: 'completion-with-preference',
    });

    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ preferredProvider: 'discord' }),
    );
  });

  it('does not claim or retry when the user has no personal destination', async () => {
    const { run } = await createDirectWebRun();
    mocks.hasAny.mockResolvedValue(false);

    await expect(
      notifyDirectWebTaskAttention({
        runId: run.id,
        kind: 'result_ready',
        eventId: 'completion-without-destination',
      }),
    ).resolves.toBe('not_applicable');

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('excludes scheduled web tasks from direct attention notifications', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: user.id,
      surface: 'web',
      trigger: 'schedule',
    });
    const run = await runFactory.create({ taskId: task.id });
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: user.id,
      sourceSurface: 'web',
      sourceTrigger: 'schedule',
    });
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'direct_launch',
    });

    await expect(
      notifyDirectWebTaskAttention({
        runId: run.id,
        kind: 'result_ready',
        eventId: 'scheduled-result',
      }),
    ).resolves.toBe('not_applicable');
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
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
    await expect(hasTaskRunAttentionNotification(run.id)).resolves.toBe(false);
  });

  it('suppresses terminal completion after a present user watched the result', async () => {
    const { run } = await createDirectWebRun();
    mocks.isPresent.mockResolvedValue(true);

    await notifyDirectWebTaskAttention({
      runId: run.id,
      kind: 'result_ready',
      eventId: 'completion-watched',
    });

    await expect(hasTaskRunAttentionNotification(run.id)).resolves.toBe(true);
  });

  it('keeps one notification owner after attention delivery fails', async () => {
    const { run } = await createDirectWebRun();
    mocks.send.mockResolvedValue({ deliveredProviders: [], receipts: [] });

    await expect(
      notifyDirectWebTaskAttention(
        {
          runId: run.id,
          kind: 'result_ready',
          eventId: 'completion-failed',
        },
        false,
      ),
    ).resolves.toBe('failed');
    await expect(hasTaskRunAttentionNotification(run.id)).resolves.toBe(true);
  });

  it('restores terminal fallback when recovery admission and delivery fail', async () => {
    const { run } = await createDirectWebRun();
    mocks.enqueue.mockResolvedValue(false);
    mocks.send.mockResolvedValue({ deliveredProviders: [], receipts: [] });

    await expect(
      notifyDirectWebTaskAttention({
        runId: run.id,
        kind: 'result_ready',
        eventId: 'completion-without-recovery',
      }),
    ).resolves.toBe('failed');

    await expect(hasTaskRunAttentionNotification(run.id)).resolves.toBe(false);
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
    await db.insert(fastAgentMessages).values({
      conversationId: conversation!.id,
      eventId: 'initial-user-message',
      turnId: 'initial-turn',
      turnSeq: 0,
      ts: Date.now() - 1,
      eventType: 'roomote_runtime.user_prompt',
      role: 'user',
      contentBlocks: [{ type: 'text', text: 'What time is it?' }],
      payload: {},
    });

    await expect(
      notifyFastWebSessionAttention({
        fastConversationId: conversation!.id,
        kind: 'result_ready',
        eventId: 'turn-1',
        message: 'The current time is 4:15 PM.',
        manual: true,
      }),
    ).resolves.toBe('delivered');
    await expect(
      notifyFastWebSessionAttention({
        fastConversationId: conversation!.id,
        kind: 'result_ready',
        eventId: 'turn-1',
        manual: true,
      }),
    ).resolves.toBe('already_claimed');

    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('The current time is 4:15 PM.'),
        presentation: expect.objectContaining({
          sessionId: session.id,
          initialUserMessage: expect.objectContaining({
            text: 'What time is it?',
          }),
        }),
      }),
    );
    expect(mocks.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining(session.title) }),
    );
    expect(mocks.send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Reply to this message to continue'),
      }),
    );

    await expect(
      notifyFastWebSessionAttention({
        fastConversationId: conversation!.id,
        kind: 'result_ready',
        eventId: 'turn-2',
        message: 'A later response.',
        manual: true,
      }),
    ).resolves.toBe('delivered');
    expect(mocks.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replyAnchor: expect.objectContaining({
          provider: 'slack',
          workspaceId: 'T1',
          channelId: 'D1',
          messageId,
        }),
        presentation: expect.objectContaining({
          sessionId: session.id,
          initialUserMessage: expect.objectContaining({
            text: 'What time is it?',
          }),
        }),
        replyPresentation: { sessionId: session.id },
      }),
    );

    await expect(
      findSessionAttentionNotificationReply({
        provider: 'slack',
        workspaceId: 'T1',
        channelId: 'D1',
        userId: user.id,
        replyToMessageId: messageId,
      }),
    ).resolves.toEqual({
      status: 'owned',
      attention: {
        sessionId: session.id,
        taskId: null,
        runId: null,
        kind: 'result_ready',
      },
    });
    await expect(
      findSessionAttentionNotificationReply({
        provider: 'slack',
        workspaceId: 'T1',
        channelId: 'D1',
        userId: 'someone-else',
        replyToMessageId: messageId,
      }),
    ).resolves.toEqual({ status: 'foreign' });
  });

  it('bridges only actual short web gaps and advances after each successful delivery', async () => {
    const { conversation, session } = await createFastWebSession();
    const firstResponse = await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-1:assistant:0',
      turnId: 'turn-1',
      turnSeq: 1,
      ts: 2_000,
      role: 'assistant',
      text: 'First response.',
      purpose: 'closeout',
    });
    let receiptIndex = 0;
    mocks.send.mockImplementation(async () => ({
      deliveredProviders: ['slack'],
      receipts: [
        {
          provider: 'slack',
          workspaceId: 'T1',
          channelId: 'D1',
          messageId: `message-${++receiptIndex}`,
          threadId: 'thread-1',
        },
      ],
    }));

    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'result_ready',
      eventId: 'turn-1',
      message: 'First response.',
      manual: true,
    });
    const firstReceipt =
      await db.query.sessionAttentionNotificationMessages.findFirst({
        where: (message, { eq }) => eq(message.messageId, 'message-1'),
        columns: { fastMessageId: true },
      });
    expect(firstReceipt?.fastMessageId).toBe(firstResponse.id);

    // Presence without any new conversation does not create a gap.
    mocks.isPresent.mockResolvedValueOnce(true);
    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'result_ready',
      eventId: 'presence-only',
      manual: true,
    });

    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-2:user',
      turnId: 'turn-2',
      turnSeq: 0,
      ts: 3_000,
      role: 'user',
      text: 'Try the first approach.',
    });
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-2:assistant:0',
      turnId: 'turn-2',
      turnSeq: 1,
      ts: 4_000,
      role: 'assistant',
      text: 'That approach is ready.',
      purpose: 'closeout',
    });
    mocks.isPresent.mockResolvedValueOnce(true);
    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'result_ready',
      eventId: 'turn-2',
      message: 'That approach is ready.',
      manual: true,
    });
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-3:user',
      turnId: 'turn-3',
      turnSeq: 0,
      ts: 5_000,
      role: 'user',
      text: 'Now verify the result.',
    });
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-3:assistant:0',
      turnId: 'turn-3',
      turnSeq: 1,
      ts: 6_000,
      role: 'assistant',
      text: 'Verification passed.',
      purpose: 'closeout',
    });

    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'result_ready',
      eventId: 'turn-3',
      message: 'Verification passed.',
      manual: true,
    });

    expect(mocks.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replyAnchor: expect.objectContaining({ threadId: 'thread-1' }),
        presentation: expect.objectContaining({
          sessionId: session.id,
          initialUserMessage: expect.objectContaining({
            text: 'What time is it?',
          }),
        }),
        replyPresentation: {
          sessionId: session.id,
          continuation: {
            omittedMessageCount: 3,
            latestUserMessage: {
              senderDisplayName: 'You',
              text: 'Now verify the result.',
            },
            linkToSession: false,
          },
        },
      }),
    );

    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-4:user',
      turnId: 'turn-4',
      turnSeq: 0,
      ts: 7_000,
      role: 'user',
      text: 'One more check.',
    });
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-4:assistant:0',
      turnId: 'turn-4',
      turnSeq: 1,
      ts: 8_000,
      role: 'assistant',
      text: 'Still good.',
      purpose: 'closeout',
    });
    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'result_ready',
      eventId: 'turn-4',
      message: 'Still good.',
      manual: true,
    });
    expect(mocks.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replyPresentation: expect.objectContaining({
          continuation: expect.objectContaining({ omittedMessageCount: 1 }),
        }),
      }),
    );
  });

  it('links long web gaps without generating a quote or summary', async () => {
    const { conversation, session } = await createFastWebSession();
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-1:assistant:0',
      turnId: 'turn-1',
      turnSeq: 1,
      ts: 2_000,
      role: 'assistant',
      text: 'First response.',
      purpose: 'closeout',
    });
    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'result_ready',
      eventId: 'turn-1',
      message: 'First response.',
      manual: true,
    });
    for (let index = 0; index < 5; index += 1) {
      await insertFastMessage({
        conversationId: conversation.id,
        eventId: `gap-${index}:user`,
        turnId: `gap-${index}`,
        turnSeq: 0,
        ts: 3_000 + index,
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `Gap message ${index}`,
        ...(index % 2 === 0 ? {} : { purpose: 'progress' as const }),
      });
    }
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-7:assistant:0',
      turnId: 'turn-7',
      turnSeq: 1,
      ts: 4_000,
      role: 'assistant',
      text: 'Current response.',
      purpose: 'closeout',
    });

    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'result_ready',
      eventId: 'turn-7',
      message: 'Current response.',
      manual: true,
    });

    expect(mocks.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replyPresentation: {
          sessionId: session.id,
          continuation: {
            omittedMessageCount: 5,
            linkToSession: true,
          },
        },
      }),
    );
  });

  it('retains Fast coverage when a direct task notification becomes the latest thread receipt', async () => {
    const { conversation, session, user } = await createFastWebSession();
    const task = await taskFactory.create({
      initiatorUserId: user.id,
      surface: 'web',
      prompt: 'Run the direct task.',
    });
    const run = await runFactory.create({ taskId: task.id });
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'direct_launch',
    });
    let receiptIndex = 0;
    mocks.send.mockImplementation(async () => ({
      deliveredProviders: ['slack'],
      receipts: [
        {
          provider: 'slack',
          workspaceId: 'T1',
          channelId: 'D1',
          messageId: `mixed-notification-${++receiptIndex}`,
          threadId: 'thread-1',
        },
      ],
    }));
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-1:assistant:0',
      turnId: 'turn-1',
      turnSeq: 1,
      ts: 2_000,
      role: 'assistant',
      text: 'First Fast response.',
      purpose: 'closeout',
    });
    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'result_ready',
      eventId: 'turn-1',
      message: 'First Fast response.',
      manual: true,
    });
    await notifyDirectWebTaskAttention({
      runId: run.id,
      kind: 'result_ready',
      eventId: 'direct-completion',
      message: 'Direct task response.',
    });
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-2:user',
      turnId: 'turn-2',
      turnSeq: 0,
      ts: 3_000,
      role: 'user',
      text: 'Continue on the web.',
    });
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-2:assistant:0',
      turnId: 'turn-2',
      turnSeq: 1,
      ts: 4_000,
      role: 'assistant',
      text: 'Second Fast response.',
      purpose: 'closeout',
    });

    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'result_ready',
      eventId: 'turn-2',
      message: 'Second Fast response.',
      manual: true,
    });

    expect(mocks.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replyAnchor: expect.objectContaining({
          messageId: 'mixed-notification-2',
          threadId: 'thread-1',
        }),
        replyPresentation: {
          sessionId: session.id,
          continuation: expect.objectContaining({
            omittedMessageCount: 1,
            latestUserMessage: expect.objectContaining({
              text: 'Continue on the web.',
            }),
          }),
        },
      }),
    );
  });

  it('queues an iOS push beside the chat DM with the pending request id', async () => {
    const { conversation, session, user } = await createFastWebSession();
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-1:assistant:0',
      turnId: 'turn-1',
      turnSeq: 1,
      ts: 2_000,
      role: 'assistant',
      text: 'First response.',
      purpose: 'closeout',
    });
    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'result_ready',
      eventId: 'turn-1',
      message: 'First response.',
      manual: true,
    });
    expect(mocks.enqueueIosPush).toHaveBeenLastCalledWith(
      expect.objectContaining({
        userId: user.id,
        kind: 'reply',
        title: session.title,
        body: 'First response.',
        sessionId: session.id,
        fastConversationId: conversation.id,
        eventKey: 'fast:result_ready:turn-1',
      }),
    );
    expect(mocks.enqueueIosPush.mock.lastCall?.[0]).not.toHaveProperty(
      'requestId',
    );

    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-2:input_request:1',
      turnId: 'turn-2',
      turnSeq: 1,
      ts: 4_000,
      role: 'assistant',
      text: 'Which environment?',
      eventType: 'roomote_runtime.request_user_input',
      payload: { requestId: 'rui:turn-2:input_request:1', questions: [] },
    });
    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'input_needed',
      eventId: 'rui:turn-2:input_request:1',
      message: 'Which environment?',
      manual: true,
    });
    expect(mocks.enqueueIosPush).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'user_input',
        requestId: 'rui:turn-2:input_request:1',
        body: 'Which environment?',
        sessionId: session.id,
      }),
    );
    // The DM still goes out; the push is additive.
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it('labels a closeout that carries an unanswered capability offer', async () => {
    const { conversation, session } = await createFastWebSession();
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-1:offer',
      turnId: 'turn-1',
      turnSeq: 1,
      ts: 2_000,
      role: 'assistant',
      text: 'Want me to connect GitHub?',
      eventType: 'roomote_runtime.capability_offer',
      payload: {
        offerId: 'offer-1',
        capability: 'source_control',
        message: 'Want me to connect GitHub?',
      },
    });
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-1:assistant:0',
      turnId: 'turn-1',
      turnSeq: 2,
      ts: 2_100,
      role: 'assistant',
      text: 'I can set that up.',
      purpose: 'closeout',
    });
    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'result_ready',
      eventId: 'turn-1',
      message: 'I can set that up.',
      manual: true,
    });
    expect(mocks.enqueueIosPush).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'capability_offer',
        offerId: 'offer-1',
        capability: 'source_control',
        sessionId: session.id,
      }),
    );
  });

  it('keeps delivering the chat DM when the push queue is unavailable', async () => {
    const { conversation } = await createFastWebSession();
    mocks.enqueueIosPush.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      notifyFastWebSessionAttention({
        fastConversationId: conversation.id,
        kind: 'result_ready',
        eventId: 'turn-1',
        message: 'Done.',
        manual: true,
      }),
    ).resolves.toBe('delivered');
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it('bridges a web request before a structured input notification', async () => {
    const { conversation, session } = await createFastWebSession();
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-1:assistant:0',
      turnId: 'turn-1',
      turnSeq: 1,
      ts: 2_000,
      role: 'assistant',
      text: 'First response.',
      purpose: 'closeout',
    });
    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'result_ready',
      eventId: 'turn-1',
      message: 'First response.',
      manual: true,
    });
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-2:user',
      turnId: 'turn-2',
      turnSeq: 0,
      ts: 3_000,
      role: 'user',
      text: 'Use the advanced option.',
    });
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-2:input_request:1',
      turnId: 'turn-2',
      turnSeq: 1,
      ts: 4_000,
      role: 'assistant',
      text: 'Which environment?',
      eventType: 'roomote_runtime.request_user_input',
      payload: { requestId: 'rui:turn-2:input_request:1' },
    });

    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'input_needed',
      eventId: 'rui:turn-2:input_request:1',
      message: 'Which environment?',
      manual: true,
    });
    expect(mocks.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replyPresentation: {
          sessionId: session.id,
          continuation: expect.objectContaining({ omittedMessageCount: 1 }),
        },
      }),
    );
  });

  it('does not regress transcript coverage when attention events deliver out of order', async () => {
    const { conversation, session } = await createFastWebSession();
    let receiptIndex = 0;
    mocks.send.mockImplementation(async () => ({
      deliveredProviders: ['slack'],
      receipts: [
        {
          provider: 'slack',
          workspaceId: 'T1',
          channelId: 'D1',
          messageId: `out-of-order-${++receiptIndex}`,
          threadId: 'thread-1',
        },
      ],
    }));
    for (const message of [
      {
        eventId: 'turn-1:assistant:0',
        turnId: 'turn-1',
        turnSeq: 1,
        ts: 2_000,
        role: 'assistant' as const,
        text: 'First response.',
        purpose: 'closeout' as const,
      },
      {
        eventId: 'turn-2:user',
        turnId: 'turn-2',
        turnSeq: 0,
        ts: 3_000,
        role: 'user' as const,
        text: 'Second request.',
      },
      {
        eventId: 'turn-2:assistant:0',
        turnId: 'turn-2',
        turnSeq: 1,
        ts: 4_000,
        role: 'assistant' as const,
        text: 'Second response.',
        purpose: 'closeout' as const,
      },
      {
        eventId: 'turn-3:user',
        turnId: 'turn-3',
        turnSeq: 0,
        ts: 5_000,
        role: 'user' as const,
        text: 'Third request.',
      },
      {
        eventId: 'turn-3:assistant:0',
        turnId: 'turn-3',
        turnSeq: 1,
        ts: 6_000,
        role: 'assistant' as const,
        text: 'Third response.',
        purpose: 'closeout' as const,
      },
    ]) {
      await insertFastMessage({ conversationId: conversation.id, ...message });
    }
    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'result_ready',
      eventId: 'turn-1',
      message: 'First response.',
      manual: true,
    });
    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'result_ready',
      eventId: 'turn-3',
      message: 'Third response.',
      manual: true,
    });
    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'result_ready',
      eventId: 'turn-2',
      message: 'Second response.',
      manual: true,
    });
    expect(mocks.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replyPresentation: { sessionId: session.id },
      }),
    );

    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-4:user',
      turnId: 'turn-4',
      turnSeq: 0,
      ts: 7_000,
      role: 'user',
      text: 'Fourth request.',
    });
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-4:assistant:0',
      turnId: 'turn-4',
      turnSeq: 1,
      ts: 8_000,
      role: 'assistant',
      text: 'Fourth response.',
      purpose: 'closeout',
    });
    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'result_ready',
      eventId: 'turn-4',
      message: 'Fourth response.',
      manual: true,
    });
    expect(mocks.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replyPresentation: {
          sessionId: session.id,
          continuation: expect.objectContaining({ omittedMessageCount: 1 }),
        },
      }),
    );
  });

  it('does not bridge provider-represented messages or advance on failure', async () => {
    const { conversation, session } = await createFastWebSession();
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-1:assistant:0',
      turnId: 'turn-1',
      turnSeq: 1,
      ts: 2_000,
      role: 'assistant',
      text: 'First response.',
      purpose: 'closeout',
    });
    await notifyFastWebSessionAttention({
      fastConversationId: conversation.id,
      kind: 'result_ready',
      eventId: 'turn-1',
      message: 'First response.',
      manual: true,
    });
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'slack-turn:user',
      turnId: 'slack-turn',
      turnSeq: 0,
      ts: 3_000,
      role: 'user',
      text: 'Continue from Slack.',
      source: 'slack',
    });
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'slack-turn:assistant:0',
      turnId: 'slack-turn',
      turnSeq: 1,
      ts: 4_000,
      role: 'assistant',
      text: 'Represented on Slack.',
      source: 'slack',
      purpose: 'closeout',
    });
    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-2:assistant:0',
      turnId: 'turn-2',
      turnSeq: 1,
      ts: 5_000,
      role: 'assistant',
      text: 'Next response.',
      purpose: 'closeout',
    });

    mocks.send.mockResolvedValueOnce({
      deliveredProviders: [],
      receipts: [],
    });
    await expect(
      notifyFastWebSessionAttention(
        {
          fastConversationId: conversation.id,
          kind: 'result_ready',
          eventId: 'turn-2',
          message: 'Next response.',
          manual: true,
        },
        false,
      ),
    ).resolves.toBe('failed');
    expect(mocks.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replyPresentation: { sessionId: session.id },
      }),
    );

    await insertFastMessage({
      conversationId: conversation.id,
      eventId: 'turn-2:web-user',
      turnId: 'turn-2',
      turnSeq: 2,
      ts: 4_500,
      role: 'user',
      text: 'Web follow-up before retry.',
    });
    await expect(
      notifyFastWebSessionAttention(
        {
          fastConversationId: conversation.id,
          kind: 'result_ready',
          eventId: 'turn-2',
          message: 'Next response.',
          manual: true,
        },
        false,
      ),
    ).resolves.toBe('delivered');
    expect(mocks.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replyPresentation: {
          sessionId: session.id,
          continuation: expect.objectContaining({ omittedMessageCount: 1 }),
        },
      }),
    );
  });

  it('excludes automation attention even when it is presented in a web Session', async () => {
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
    await sessionFactory.create({
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
        eventId: 'automation-result',
        message: 'Scheduled report',
        manual: false,
      }),
    ).resolves.toBe('not_applicable');
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
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
    const receipts = providers.map(
      ([provider, workspaceId, channelId, providerMessageId]) => ({
        provider,
        workspaceId,
        channelId,
        messageId: `${providerMessageId}:${messageId}`,
        ...(provider === 'agentmail'
          ? { threadId: `email-thread:${messageId}` }
          : {}),
      }),
    );
    mocks.send.mockResolvedValue({
      deliveredProviders: receipts.map((receipt) => receipt.provider),
      receipts,
    });

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
      ).resolves.toEqual({
        status: 'owned',
        attention: {
          sessionId: session.id,
          taskId: run.taskId,
          runId: run.id,
          kind: 'result_ready',
        },
      });
    }

    await expect(
      findSessionAttentionNotificationReply({
        provider: 'agentmail',
        workspaceId: 'inbox@example.com',
        channelId: 'conversation-created-by-inbound',
        threadId: `email-thread:${messageId}`,
        userId: user.id,
      }),
    ).resolves.toEqual({
      status: 'owned',
      attention: {
        sessionId: session.id,
        taskId: run.taskId,
        runId: run.id,
        kind: 'result_ready',
      },
    });
  });
});
