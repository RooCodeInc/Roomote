import {
  db,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  getSessionForFastConversation,
  getSessionForTask,
  inArray,
  sessions,
  sessionTasks,
  taskRuns,
  tasks,
  userFactory,
  users,
} from '@roomote/db/server';
import { getFastAgentParentFromPayload, TaskPayloadKind } from '@roomote/types';

vi.mock('@roomote/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/redis')>()),
  acquireRedisLock: vi.fn(async () => async () => {}),
}));

// Keep task and Session persistence real without publishing runnable work.
vi.mock('../../task-run-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../task-run-queue')>();
  return {
    ...actual,
    enqueueTask: (async (input, options) => {
      const run = await actual.enqueueTask(input, {
        ...options,
        enqueue: false,
        skipEarlyTitleGeneration: true,
      });
      // enqueue:false skips this hook along with queue publication.
      await options?.beforeEnqueue?.(run);
      return run;
    }) as typeof actual.enqueueTask,
  };
});

import { fastAgentConversationRepository } from '../fast-agent-conversation-repository';
import { launchPinnedFastSessionTask } from '../fast-agent-pinned-launch';
import { enqueueTask } from '../../task-run-queue';

it('launches distinct suggested work items in the existing automation Session and Slack report thread without an origin Session id', async () => {
  const user = await userFactory.create();
  const conversation = {
    surface: 'slack' as const,
    workspaceId: `team-${crypto.randomUUID()}`,
    conversationId: `${crypto.randomUUID()}:2026-09-05T06:32:07.044Z`,
    replyTarget: { channelId: 'channel-test', threadId: '100.001' },
  };
  const taskIds: string[] = [];
  try {
    const original = await fastAgentConversationRepository.getOrCreate({
      owner: { kind: 'automation', automationKey: 'custom_automation' },
      conversation,
    });
    const session = await getSessionForFastConversation(db, original.id);
    expect(session).toMatchObject({ ownerKind: 'automation' });
    expect(original.conversation.conversationId).not.toBe(
      conversation.replyTarget.threadId,
    );

    const launchIds = [
      `work-item:${crypto.randomUUID()}`,
      `work-item:${crypto.randomUUID()}`,
    ];
    for (const launchId of launchIds) {
      const result = await launchPinnedFastSessionTask({
        userId: user.id,
        conversation: {
          ...conversation,
          conversationId: conversation.replyTarget.threadId,
        },
        launchId,
        prompt: 'Investigate the suggested issue',
        task: {
          type: TaskPayloadKind.StandardTask,
          harness: 'opencode-server',
          requestedWorkKindDecision: {
            kind: 'implement',
            source: 'explicit_bootstrap',
            confidence: null,
          },
          payload: {
            repo: 'acme/widgets',
            description: 'Investigate the suggested issue',
          },
        },
        surface: 'slack',
        kickoffMessage: 'Started a task for the suggested issue.',
      });
      taskIds.push(result.taskId);
      expect(result).toMatchObject({
        sessionId: session!.id,
        fastConversationId: original.id,
      });
      const run = await db.query.taskRuns.findFirst({
        where: eq(taskRuns.id, result.runId),
      });
      expect(run).toMatchObject({
        taskId: result.taskId,
        fastAgentSessionId: original.id,
        payload: { launchIdempotencyKey: `pinned-launch:${launchId}` },
      });
      expect(getFastAgentParentFromPayload(run!.payload)).toEqual({
        sessionId: original.id,
        conversation,
      });
    }

    expect(new Set(taskIds).size).toBe(2);
    expect(
      await db.select().from(tasks).where(inArray(tasks.id, taskIds)),
    ).toHaveLength(2);
    expect(
      await db
        .select({ taskId: sessionTasks.taskId, origin: sessionTasks.origin })
        .from(sessionTasks)
        .where(eq(sessionTasks.sessionId, session!.id)),
    ).toEqual(
      expect.arrayContaining(
        taskIds.map((taskId) => ({ taskId, origin: 'fast_delegation' })),
      ),
    );
    const messages = await db
      .select()
      .from(fastAgentMessages)
      .where(eq(fastAgentMessages.conversationId, original.id));
    expect(messages).toHaveLength(6);
    for (const launchId of launchIds) {
      expect(messages.map((message) => message.eventId)).toEqual(
        expect.arrayContaining(
          ['user', 'kickoff', 'launch'].map(
            (suffix) => `pinned-launch:${launchId}:${suffix}`,
          ),
        ),
      );
    }
    expect(
      await db
        .select()
        .from(fastAgentConversations)
        .where(
          eq(fastAgentConversations.workspaceId, conversation.workspaceId),
        ),
    ).toMatchObject([
      {
        id: original.id,
        conversationId: conversation.conversationId,
        currentReplyChannelId: conversation.replyTarget.channelId,
        currentReplyThreadId: conversation.replyTarget.threadId,
        ownerAutomation: 'custom_automation',
      },
    ]);
  } finally {
    if (taskIds.length > 0) {
      await db.delete(taskRuns).where(inArray(taskRuns.taskId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
    const conversations = await db
      .select({ id: fastAgentConversations.id })
      .from(fastAgentConversations)
      .where(eq(fastAgentConversations.workspaceId, conversation.workspaceId));
    for (const { id } of conversations) {
      await db.delete(sessions).where(eq(sessions.fastConversationId, id));
      await db
        .delete(fastAgentConversations)
        .where(eq(fastAgentConversations.id, id));
    }
    await db.delete(users).where(eq(users.id, user.id));
  }
});

it('creates a hidden scan Session immediately and keeps subsequent suggested tasks in that Session and report thread', async () => {
  const user = await userFactory.create();
  const conversation = {
    surface: 'slack' as const,
    workspaceId: `team-${crypto.randomUUID()}`,
    conversationId: '200.001',
    replyTarget: { channelId: 'channel-test', threadId: '200.001' },
  };
  const task = {
    type: TaskPayloadKind.StandardTask,
    harness: 'opencode-server',
    requestedWorkKindDecision: {
      kind: 'implement',
      source: 'explicit_bootstrap',
      confidence: null,
    },
    payload: {
      repo: 'acme/widgets',
      description: 'Investigate the suggested issue',
    },
  } as const;
  const taskIds: string[] = [];
  let scanSessionId: string | undefined;
  try {
    const scan = await enqueueTask(
      {
        task,
        initiator: { kind: 'automation', key: 'suggester' },
        workflow: 'scan',
        surface: 'system',
        trigger: 'schedule',
        visibility: 'hidden',
      },
      { enqueue: false, skipEarlyTitleGeneration: true },
    );
    taskIds.push(scan.taskId);
    // No Session-creation helper may repair the scan after enqueue returns.
    const scanSession = await getSessionForTask(db, scan.taskId);
    scanSessionId = scanSession?.id;
    expect(scanSession).toMatchObject({
      visibility: 'hidden',
      ownerKind: 'automation',
      ownerAutomation: 'suggester',
      fastConversationId: null,
    });

    let fastConversationId: string | undefined;
    for (const launchId of [
      `work-item:${crypto.randomUUID()}`,
      `work-item:${crypto.randomUUID()}`,
    ]) {
      const result = await launchPinnedFastSessionTask({
        userId: user.id,
        originSessionId: scanSession!.id,
        conversation,
        launchId,
        prompt: task.payload.description,
        task,
        surface: 'slack',
        kickoffMessage: 'Started a task for the suggested issue.',
      });
      taskIds.push(result.taskId);
      fastConversationId ??= result.fastConversationId;
      expect(result).toMatchObject({
        sessionId: scanSession!.id,
        fastConversationId,
      });
      expect(await getSessionForTask(db, result.taskId)).toMatchObject({
        id: scanSession!.id,
        visibility: 'visible',
        fastConversationId,
      });
      const run = await db.query.taskRuns.findFirst({
        where: eq(taskRuns.id, result.runId),
      });
      expect(run).toMatchObject({
        taskId: result.taskId,
        payload: { launchIdempotencyKey: `pinned-launch:${launchId}` },
      });
      expect(getFastAgentParentFromPayload(run!.payload)).toEqual({
        sessionId: fastConversationId,
        conversation,
      });
    }

    expect(new Set(taskIds).size).toBe(3);
    const links = await db
      .select()
      .from(sessionTasks)
      .where(inArray(sessionTasks.taskId, taskIds));
    expect(links).toHaveLength(3);
    expect(links.every((link) => link.sessionId === scanSession!.id)).toBe(
      true,
    );
    expect(await getSessionForTask(db, scan.taskId)).toMatchObject({
      id: scanSession!.id,
      visibility: 'visible',
      fastConversationId,
    });
    expect(
      await db.query.tasks.findFirst({ where: eq(tasks.id, scan.taskId) }),
    ).toMatchObject({ visibility: 'hidden' });
    expect(
      await fastAgentConversationRepository.findById({
        id: fastConversationId!,
      }),
    ).toMatchObject({ conversation });
  } finally {
    if (taskIds.length > 0) {
      await db.delete(taskRuns).where(inArray(taskRuns.taskId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
    if (scanSessionId) {
      await db.delete(sessions).where(eq(sessions.id, scanSessionId));
    }
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.workspaceId, conversation.workspaceId));
    await db.delete(users).where(eq(users.id, user.id));
  }
});
