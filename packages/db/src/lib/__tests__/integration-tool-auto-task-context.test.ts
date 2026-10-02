import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import {
  db,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  isSessionDelegatedTask,
  resolveTaskIntegrationToolAutoContext,
  runFactory,
  sessionFactory,
  sessions,
  sessionTasks,
  taskFactory,
  taskMessages,
  tasks,
  userFactory,
  type SessionTaskOrigin,
} from '../../server';

const sessionIds: string[] = [];
const taskIds: string[] = [];
const conversationIds: string[] = [];

afterEach(async () => {
  for (const id of sessionIds.splice(0)) {
    await db.delete(sessions).where(eq(sessions.id, id));
  }
  for (const id of taskIds.splice(0)) {
    await db.delete(tasks).where(eq(tasks.id, id));
  }
  for (const id of conversationIds.splice(0)) {
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, id));
  }
});

async function seed(input: {
  origin: SessionTaskOrigin;
  prompt: string;
  withConversation: boolean;
}) {
  const owner = await userFactory.create();
  let conversationId: string | undefined;
  if (input.withConversation) {
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: owner.id,
        surface: 'web',
        workspaceId: `W-${owner.id}`,
        conversationId: `C-${owner.id}`,
      })
      .returning({ id: fastAgentConversations.id });
    conversationId = conversation!.id;
    conversationIds.push(conversationId);
  }
  const session = await sessionFactory.create({
    ownerKind: 'user',
    ownerUserId: owner.id,
    ...(conversationId ? { fastConversationId: conversationId } : {}),
  });
  sessionIds.push(session.id);
  const task = await taskFactory.create({
    initiatorUserId: owner.id,
    prompt: input.prompt,
    createdAt: new Date(500),
  });
  taskIds.push(task.id);
  const run = await runFactory.create({
    actingUserId: owner.id,
    taskId: task.id,
  });
  await db
    .insert(sessionTasks)
    .values({ sessionId: session.id, taskId: task.id, origin: input.origin });

  let turnSeq = 0;
  const sessionMessage = (message: {
    ts: number;
    text: string;
    role?: 'assistant';
    metadata?: Record<string, unknown>;
  }) => {
    turnSeq += 1;
    return db.insert(fastAgentMessages).values({
      conversationId: conversationId!,
      eventId: `event-${turnSeq}`,
      turnId: `turn-${turnSeq}`,
      turnSeq,
      ts: message.ts,
      eventType:
        message.role === 'assistant'
          ? ACP_ENVELOPE_EVENT_TYPES.AssistantMessage
          : ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      role: message.role ?? 'user',
      contentBlocks: [{ type: 'text', text: message.text }],
      metadata:
        message.metadata ??
        (message.role === 'assistant' ? {} : { turnSource: 'human' }),
      payload: {},
    });
  };
  const taskMessage = (message: {
    ts: number;
    text?: string;
    eventType?: (typeof ACP_ENVELOPE_EVENT_TYPES)[keyof typeof ACP_ENVELOPE_EVENT_TYPES];
    metadata?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  }) =>
    db.insert(taskMessages).values({
      runId: run.id,
      taskId: task.id,
      ts: message.ts,
      eventType: message.eventType ?? ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      role:
        message.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage
          ? 'assistant'
          : 'user',
      protocol: 'roomote_runtime',
      contentBlocks: message.text ? [{ type: 'text', text: message.text }] : [],
      metadata: message.metadata ?? null,
      payload: message.payload ?? { text: message.text ?? '' },
    });
  const toolResult = (
    ts: number,
    payload: Record<string, unknown>,
  ): ReturnType<typeof taskMessage> =>
    taskMessage({
      ts,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      payload: { status: 'completed', ...payload },
    });
  return {
    context: { sessionId: session.id, taskId: task.id },
    owner: owner.id,
    sessionMessage,
    taskMessage,
    toolResult,
  };
}

describe('resolveTaskIntegrationToolAutoContext', () => {
  it('judges a task the session launched against what people asked the session for', async () => {
    const { context, owner, sessionMessage, taskMessage, toolResult } =
      await seed({
        origin: 'fast_delegation',
        prompt: 'Close the stale tickets ENG-1 and ENG-2.',
        withConversation: true,
      });
    await sessionMessage({ ts: 1_000, text: 'Which tickets are stale?' });
    await sessionMessage({
      ts: 1_500,
      text: 'ENG-1 and ENG-2. I can close both.',
      role: 'assistant',
    });
    // Not requests: a platform event, a reaction, and a hidden prompt.
    await sessionMessage({
      ts: 1_600,
      text: 'A task finished.',
      metadata: { turnSource: 'platform_event' },
    });
    await sessionMessage({
      ts: 1_700,
      text: ':+1:',
      metadata: { turnSource: 'human', inputKind: 'reaction' },
    });
    await sessionMessage({ ts: 2_000, text: 'yes, go ahead' });
    await sessionMessage({
      ts: 2_500,
      text: 'Launching a task for that.',
      role: 'assistant',
    });

    // The task's wrapped first prompt and a harness reminder are hidden or
    // have no sender, so neither is a request.
    await taskMessage({
      ts: 3_000,
      text: 'Close the stale tickets ENG-1 and ENG-2.',
      metadata: { visibleInTranscript: false },
    });
    await taskMessage({
      ts: 3_900,
      text: 'Continue where you left off.',
      metadata: { source: 'opencode-stop-hook' },
    });
    await toolResult(3_100, {
      isMcp: true,
      mcpServerName: 'linear',
      mcpToolName: 'list_issues',
      rawInput: { team: 'ENG' },
      output: '[{"id":"ENG-1"},{"id":"ENG-2"}]',
    });
    // Skipped as integration results: Roomote's own tool, a failed call.
    await toolResult(3_200, {
      isMcp: true,
      mcpServerName: 'roomote',
      mcpToolName: 'send_chat_reply',
      rawInput: { message: 'Working on it.' },
      output: '{"success":true}',
    });
    await toolResult(3_300, {
      isMcp: true,
      mcpServerName: 'linear',
      mcpToolName: 'get_issue',
      rawInput: { id: 'ENG-3' },
      status: 'failed',
      output: 'not found',
    });
    // Read by any kind of tool. A harness reminder does not start a new
    // window, so what was read before it is kept.
    await toolResult(3_400, { toolName: 'bash', output: 'README: hello' });
    await toolResult(4_000, { toolName: 'read', output: 'notes.txt: later' });

    await expect(
      resolveTaskIntegrationToolAutoContext(context),
    ).resolves.toEqual({
      userRequest: 'yes, go ahead',
      recentUserMessages: ['Which tickets are stale?', 'yes, go ahead'],
      agentMessageRepliedTo: 'ENG-1 and ENG-2. I can close both.',
      recentToolResults: [
        {
          tool: 'roomote.launch_task',
          output:
            "The session's agent launched this task with these instructions:\nClose the stale tickets ENG-1 and ENG-2.",
        },
        {
          tool: 'linear.list_issues',
          arguments: { team: 'ENG' },
          output: '[{"id":"ENG-1"},{"id":"ENG-2"}]',
        },
      ],
      readContent:
        '[{"id":"ENG-1"},{"id":"ENG-2"}]\n\n{"success":true}\n\nREADME: hello\n\nnotes.txt: later',
    });

    // A message a person then sends to the task itself is the latest request,
    // answering what the task's agent said before it.
    await taskMessage({
      ts: 5_000,
      text: 'I can also close ENG-4.',
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
    });
    await taskMessage({
      ts: 5_100,
      text: 'Retrying the model request.',
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
      payload: { providerRetryNotice: { attempt: 1 } },
    });
    await taskMessage({
      ts: 6_000,
      text: 'yes, that one too',
      metadata: { userId: owner, source: 'web' },
    });
    const later = await resolveTaskIntegrationToolAutoContext(context);
    expect(later.userRequest).toBe('yes, that one too');
    expect(later.recentUserMessages).toEqual([
      'Which tickets are stale?',
      'yes, go ahead',
      'yes, that one too',
    ]);
    expect(later.agentMessageRepliedTo).toBe('I can also close ENG-4.');
    // A prompt from a person does start a new window: nothing was read
    // since it.
    expect(later.readContent).toBeUndefined();
  });

  it('takes the launch prompt as the request for a task a person launched', async () => {
    const { context, owner, taskMessage } = await seed({
      origin: 'direct_launch',
      prompt:
        '<environment-instructions>Use pnpm.</environment-instructions>\n<request>File the bug.</request>',
      withConversation: false,
    });
    await expect(
      resolveTaskIntegrationToolAutoContext(context),
    ).resolves.toEqual({
      userRequest: 'File the bug.',
      recentUserMessages: ['File the bug.'],
      // The person who launched it wrote the only request.
      requestsWrittenBy: owner,
      recentToolResults: [],
    });

    await taskMessage({
      ts: 9_000,
      text: 'Also assign it to me.',
      metadata: { userId: owner, source: 'slack' },
    });
    const later = await resolveTaskIntegrationToolAutoContext(context);
    expect(later.userRequest).toBe('Also assign it to me.');
    expect(later.recentUserMessages).toEqual([
      'File the bug.',
      'Also assign it to me.',
    ]);
    expect(later.requestsWrittenBy).toBe(owner);

    // Somebody else then writes to the task: "me" is no longer one person.
    await taskMessage({
      ts: 9_500,
      text: 'And cc me on it.',
      metadata: { userId: 'a-teammate', source: 'slack' },
    });
    await expect(
      resolveTaskIntegrationToolAutoContext(context),
    ).resolves.not.toHaveProperty('requestsWrittenBy');
  });

  it('names the one person who wrote every request to the session and the task', async () => {
    const { context, owner, sessionMessage, taskMessage } = await seed({
      origin: 'fast_delegation',
      prompt: 'Assign ENG-1 to the requester.',
      withConversation: true,
    });
    const fromOwner = { turnSource: 'human', userId: owner };
    await sessionMessage({
      ts: 1_000,
      text: 'Assign ENG-1 to me.',
      metadata: fromOwner,
    });
    // The agent wrote the launch prompt, so it has no author to count.
    await expect(
      resolveTaskIntegrationToolAutoContext(context),
    ).resolves.toMatchObject({
      userRequest: 'Assign ENG-1 to me.',
      requestsWrittenBy: owner,
    });

    await taskMessage({
      ts: 4_000,
      text: 'ENG-2 as well.',
      metadata: { userId: owner, source: 'web' },
    });
    await expect(
      resolveTaskIntegrationToolAutoContext(context),
    ).resolves.toMatchObject({ requestsWrittenBy: owner });

    // A session prompt whose sender is not recorded could be anybody's.
    await sessionMessage({ ts: 5_000, text: 'And ENG-3 to me.' });
    await expect(
      resolveTaskIntegrationToolAutoContext(context),
    ).resolves.not.toHaveProperty('requestsWrittenBy');
  });

  it('has nothing to judge against for a task outside the session', async () => {
    const { context } = await seed({
      origin: 'direct_launch',
      prompt: 'File the bug.',
      withConversation: false,
    });
    const other = await sessionFactory.create();
    sessionIds.push(other.id);
    await expect(
      resolveTaskIntegrationToolAutoContext({
        taskId: context.taskId,
        sessionId: other.id,
      }),
    ).resolves.toEqual({ recentUserMessages: [], recentToolResults: [] });
  });
});

describe('isSessionDelegatedTask', () => {
  it("is true only for a task the session's own agent launched", async () => {
    const delegated = await seed({
      origin: 'fast_delegation',
      prompt: 'Do it.',
      withConversation: true,
    });
    const direct = await seed({
      origin: 'direct_launch',
      prompt: 'Do it.',
      withConversation: false,
    });
    await expect(
      isSessionDelegatedTask(
        delegated.context.sessionId,
        delegated.context.taskId,
      ),
    ).resolves.toBe(true);
    await expect(
      isSessionDelegatedTask(direct.context.sessionId, direct.context.taskId),
    ).resolves.toBe(false);
    // Another session's task.
    await expect(
      isSessionDelegatedTask(
        direct.context.sessionId,
        delegated.context.taskId,
      ),
    ).resolves.toBe(false);
  });
});
