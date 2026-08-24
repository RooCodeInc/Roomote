const mocks = vi.hoisted(() => ({
  clearLatestUserMessage: vi.fn(),
  dbSelectLimit: vi.fn(),
  enqueueTask: vi.fn(),
  findActiveCommunicationTaskRun: vi.fn(),
  findActiveSlackTaskRun: vi.fn(),
  findCompletedCommunicationTaskRunWithSnapshot: vi.fn(),
  findCompletedSlackTaskRunWithSnapshot: vi.fn(),
  getSlackTaskRunWorkspacePredicate: vi.fn((teamId: string) => ({
    legacyWorkspacePredicate: teamId,
  })),
  queueCommunicationMessage: vi.fn(),
  queueSlackMessage: vi.fn(),
  resumeCommunicationTaskFromSnapshot: vi.fn(),
  setTrustedRunActingUser: vi.fn(),
  withContention: vi.fn(),
  where: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mocks.enqueueTask,
}));

vi.mock('@roomote/communication', () => ({
  queueCommunicationMessage: mocks.queueCommunicationMessage,
}));

vi.mock('@roomote/db/server', () => {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: mocks.where,
    orderBy: vi.fn(),
    limit: mocks.dbSelectLimit,
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return {
    and: vi.fn((...conditions: unknown[]) => ({ conditions })),
    db: { select: vi.fn(() => chain) },
    desc: vi.fn((value: unknown) => value),
    eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
    gt: vi.fn((left: unknown, right: unknown) => ({ left, right })),
    setTrustedRunActingUser: mocks.setTrustedRunActingUser,
    taskRuns: {
      canceledAt: 'taskRuns.canceledAt',
      createdAt: 'taskRuns.createdAt',
      id: 'taskRuns.id',
      kind: 'taskRuns.kind',
      payload: 'taskRuns.payload',
      port: 'taskRuns.port',
      snapshotCreatedAt: 'taskRuns.snapshotCreatedAt',
      snapshotFailedAt: 'taskRuns.snapshotFailedAt',
      snapshotId: 'taskRuns.snapshotId',
      status: 'taskRuns.status',
      taskId: 'taskRuns.taskId',
    },
    tasks: {
      deletedAt: 'tasks.deletedAt',
      id: 'tasks.id',
      slackThreadTs: 'tasks.slackThreadTs',
    },
    inArray: vi.fn((left: unknown, right: unknown) => ({ left, right })),
    isNotNull: vi.fn((value: unknown) => ({ isNotNull: value })),
    isNull: vi.fn((value: unknown) => ({ isNull: value })),
  };
});

vi.mock('@roomote/redis', () => ({ withContention: mocks.withContention }));

vi.mock('@roomote/slack', () => ({
  clearLatestUserMessage: mocks.clearLatestUserMessage,
  findActiveSlackTaskRun: mocks.findActiveSlackTaskRun,
  findCompletedSlackTaskRunWithSnapshot:
    mocks.findCompletedSlackTaskRunWithSnapshot,
  getSlackResumeLockKey: (threadTs: string, taskId: string) =>
    `slack:resume-lock:${threadTs}:${taskId}`,
  getSlackTaskRunWorkspacePredicate: mocks.getSlackTaskRunWorkspacePredicate,
  queueSlackMessage: mocks.queueSlackMessage,
  resolveSlackReactionNames: vi.fn(async () => ({
    ackEmoji: 'eyes',
    completionEmoji: 'white_check_mark',
  })),
}));

vi.mock('../../communication/communication-snapshot-resume', () => ({
  resumeCommunicationTaskFromSnapshot:
    mocks.resumeCommunicationTaskFromSnapshot,
}));

vi.mock('../../communication/communication-task-run-lookup', () => ({
  findActiveCommunicationTaskRun: mocks.findActiveCommunicationTaskRun,
  findCompletedCommunicationTaskRunWithSnapshot:
    mocks.findCompletedCommunicationTaskRunWithSnapshot,
}));

import { dispatchPrReviewFollowUp } from '../pr-review-follow-up-dispatch';

const taskA = 'task-a';
const taskB = 'task-b';
const sharedThread = '111.222';
const prompt = 'Address the pending review feedback.';

function slackRun(id: number, taskId: string) {
  return {
    id,
    taskId,
    payload: { repo: 'owner/repo' },
    port: null,
    snapshotId: `snapshot-${taskId}`,
  };
}

function fastSlackRun({
  workspaceId = 'T123',
  channelId = 'C123',
  threadId = sharedThread,
}: {
  workspaceId?: string;
  channelId?: string;
  threadId?: string;
} = {}) {
  return {
    id: 101,
    taskId: taskA,
    snapshotId: 'snapshot-task-a',
    payload: {
      repo: 'owner/repo',
      environmentId: 'environment-1',
      fastAgentParent: {
        sessionId: '11111111-1111-4111-8111-111111111111',
        conversation: {
          surface: 'slack',
          workspaceId,
          conversationId: threadId,
          replyTarget: { channelId, threadId },
        },
      },
    },
    port: null,
  };
}

function communicationRun(id: number, taskId: string) {
  return {
    ...slackRun(id, taskId),
    userId: 'owner-user',
  };
}

describe('dispatchPrReviewFollowUp', () => {
  const slackTeamId = 'T123';

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findActiveSlackTaskRun.mockImplementation(
      async (_threadId: string, scope?: { taskId?: string }) =>
        scope?.taskId === taskA ? slackRun(101, taskA) : slackRun(202, taskB),
    );
    mocks.findCompletedSlackTaskRunWithSnapshot.mockResolvedValue(null);
    mocks.findActiveCommunicationTaskRun.mockImplementation(
      async ({ taskId }: { taskId?: string }) =>
        taskId === taskA
          ? communicationRun(301, taskA)
          : communicationRun(402, taskB),
    );
    mocks.findCompletedCommunicationTaskRunWithSnapshot.mockResolvedValue(null);
    mocks.withContention.mockImplementation(
      async (_key: string, options: { onAcquired: () => Promise<number> }) => ({
        value: await options.onAcquired(),
      }),
    );
    mocks.enqueueTask.mockResolvedValue({ id: 102 });
    mocks.dbSelectLimit.mockResolvedValue([]);
    mocks.resumeCommunicationTaskFromSnapshot.mockResolvedValue({ id: 302 });
  });

  it('queues an active Slack review action on its owning task when a newer task shares the thread', async () => {
    const result = await dispatchPrReviewFollowUp({
      provider: 'slack',
      taskId: taskA,
      slackTeamId,
      channelId: 'C123',
      threadId: sharedThread,
      followUpPrompt: prompt,
      actingUserId: 'user-1',
      providerUserId: 'U123',
    });

    expect(result).toEqual({ outcome: 'queued', runId: 101 });
    expect(mocks.findActiveSlackTaskRun).toHaveBeenCalledWith(sharedThread, {
      taskId: taskA,
      slackTeamId,
    });
    expect(mocks.queueSlackMessage).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ text: prompt, userId: 'user-1', user: 'U123' }),
    );
  });

  it('queues a verified legacy Slack offer by immutable task identity', async () => {
    const result = await dispatchPrReviewFollowUp({
      provider: 'slack',
      taskId: taskA,
      channelId: 'C123',
      threadId: sharedThread,
      followUpPrompt: prompt,
      actingUserId: 'user-1',
      providerUserId: 'U123',
    });

    expect(result).toEqual({ outcome: 'queued', runId: 101 });
    expect(mocks.findActiveSlackTaskRun).toHaveBeenCalledWith(sharedThread, {
      taskId: taskA,
    });
    expect(mocks.queueSlackMessage).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ text: prompt, userId: 'user-1', user: 'U123' }),
    );
  });

  it('resumes the owning Slack task snapshot instead of a newer task in the thread', async () => {
    mocks.findActiveSlackTaskRun.mockResolvedValue(null);
    mocks.findCompletedSlackTaskRunWithSnapshot.mockImplementation(
      async (_threadId: string, scope?: { taskId?: string }) =>
        scope?.taskId === taskA ? slackRun(101, taskA) : slackRun(202, taskB),
    );

    const result = await dispatchPrReviewFollowUp({
      provider: 'slack',
      taskId: taskA,
      slackTeamId,
      channelId: 'C123',
      threadId: sharedThread,
      followUpPrompt: prompt,
      actingUserId: 'user-1',
    });

    expect(result).toEqual({ outcome: 'resumed', runId: 102 });
    expect(mocks.findCompletedSlackTaskRunWithSnapshot).toHaveBeenCalledWith(
      sharedThread,
      { taskId: taskA, slackTeamId },
    );
    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({ sourceRunId: 101 }),
        actingUserId: 'user-1',
      }),
      {},
    );
  });

  it('resumes a completed Fast child from its parent Slack review action', async () => {
    mocks.findActiveSlackTaskRun.mockResolvedValue(null);
    mocks.dbSelectLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([fastSlackRun()]);

    const result = await dispatchPrReviewFollowUp({
      provider: 'slack',
      taskId: taskA,
      slackTeamId,
      channelId: 'C123',
      threadId: sharedThread,
      followUpPrompt: prompt,
      actingUserId: 'user-1',
      providerUserId: 'U123',
    });

    expect(result).toEqual({ outcome: 'resumed', runId: 102 });
    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          sourceRunId: 101,
          payload: expect.objectContaining({
            communicationContextInherited: true,
            fastAgentSessionId: '11111111-1111-4111-8111-111111111111',
            fastAgentParent: expect.objectContaining({
              sessionId: '11111111-1111-4111-8111-111111111111',
            }),
          }),
        }),
        actingUserId: 'user-1',
      }),
      {},
    );
    expect(mocks.queueSlackMessage).toHaveBeenCalledWith(
      102,
      expect.objectContaining({ text: prompt, userId: 'user-1', user: 'U123' }),
    );
  });

  it('queues a Fast review action while the child is idle without a snapshot', async () => {
    mocks.findActiveSlackTaskRun.mockResolvedValue(null);
    mocks.dbSelectLimit.mockResolvedValueOnce([
      { ...fastSlackRun(), snapshotId: null },
    ]);

    const result = await dispatchPrReviewFollowUp({
      provider: 'slack',
      taskId: taskA,
      slackTeamId,
      channelId: 'C123',
      threadId: sharedThread,
      followUpPrompt: prompt,
      actingUserId: 'user-1',
      providerUserId: 'U123',
    });

    expect(result).toEqual({ outcome: 'queued', runId: 101 });
    expect(mocks.setTrustedRunActingUser).toHaveBeenCalledWith({
      runId: 101,
      userId: 'user-1',
    });
    expect(mocks.queueSlackMessage).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ text: prompt, userId: 'user-1', user: 'U123' }),
    );
    expect(mocks.enqueueTask).not.toHaveBeenCalled();
    expect(mocks.getSlackTaskRunWorkspacePredicate).not.toHaveBeenCalled();
  });

  it('queues onto a contended Fast child resume without requiring a task-owned thread binding', async () => {
    mocks.findActiveSlackTaskRun.mockResolvedValue(null);
    mocks.dbSelectLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([fastSlackRun()])
      .mockResolvedValueOnce([{ ...fastSlackRun(), id: 103 }]);
    mocks.withContention.mockImplementation(
      async (
        _key: string,
        options: { onContended: () => Promise<number> },
      ) => ({ value: await options.onContended() }),
    );

    const result = await dispatchPrReviewFollowUp({
      provider: 'slack',
      taskId: taskA,
      slackTeamId,
      channelId: 'C123',
      threadId: sharedThread,
      followUpPrompt: prompt,
      actingUserId: 'user-1',
    });

    expect(result).toEqual({ outcome: 'resumed', runId: 103 });
    const where = mocks.where.mock.calls.at(-1)?.[0] as {
      conditions: unknown[];
    };
    expect(where.conditions).toEqual(
      expect.arrayContaining([{ left: 'taskRuns.taskId', right: taskA }]),
    );
    expect(where.conditions).not.toContainEqual({
      left: 'tasks.slackThreadTs',
      right: sharedThread,
    });
    expect(where.conditions).not.toContainEqual({
      legacyWorkspacePredicate: slackTeamId,
    });
    expect(mocks.getSlackTaskRunWorkspacePredicate).not.toHaveBeenCalled();
    expect(mocks.enqueueTask).not.toHaveBeenCalled();
    expect(mocks.queueSlackMessage).toHaveBeenCalledWith(
      103,
      expect.anything(),
    );
  });

  it('rejects a contended Fast resume from a different parent conversation', async () => {
    mocks.findActiveSlackTaskRun.mockResolvedValue(null);
    mocks.dbSelectLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([fastSlackRun()])
      .mockResolvedValueOnce([
        {
          ...fastSlackRun({ channelId: 'C-other' }),
          id: 103,
        },
      ]);
    mocks.withContention.mockImplementation(
      async (
        _key: string,
        options: { onContended: () => Promise<number | undefined> },
      ) => ({ value: await options.onContended() }),
    );

    const result = await dispatchPrReviewFollowUp({
      provider: 'slack',
      taskId: taskA,
      slackTeamId,
      channelId: 'C123',
      threadId: sharedThread,
      followUpPrompt: prompt,
      actingUserId: 'user-1',
    });

    expect(result).toEqual({ outcome: 'unavailable' });
    expect(mocks.queueSlackMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['workspace', { workspaceId: 'T-other' }],
    ['channel', { channelId: 'C-other' }],
    ['thread', { threadId: 'different-thread' }],
  ])(
    'does not resume a Fast child through a different Slack parent %s',
    async (_field, parentOverrides) => {
      mocks.findActiveSlackTaskRun.mockResolvedValue(null);
      mocks.dbSelectLimit.mockResolvedValue([
        fastSlackRun(parentOverrides as Parameters<typeof fastSlackRun>[0]),
      ]);

      const result = await dispatchPrReviewFollowUp({
        provider: 'slack',
        taskId: taskA,
        slackTeamId,
        channelId: 'C123',
        threadId: sharedThread,
        followUpPrompt: prompt,
        actingUserId: 'user-1',
      });

      expect(result).toEqual({ outcome: 'unavailable' });
      expect(mocks.enqueueTask).not.toHaveBeenCalled();
      expect(mocks.queueSlackMessage).not.toHaveBeenCalled();
    },
  );

  it('queues a modern review action onto a drain-created legacy resume after losing contention', async () => {
    mocks.findActiveSlackTaskRun.mockResolvedValue(null);
    mocks.findCompletedSlackTaskRunWithSnapshot.mockResolvedValue(
      slackRun(101, taskA),
    );
    mocks.dbSelectLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 103 }]);
    mocks.withContention.mockImplementation(
      async (key: string, options: { onContended: () => Promise<number> }) => ({
        key,
        value: await options.onContended(),
      }),
    );

    await dispatchPrReviewFollowUp({
      provider: 'slack',
      taskId: taskA,
      slackTeamId,
      channelId: 'C123',
      threadId: sharedThread,
      followUpPrompt: prompt,
      actingUserId: 'user-1',
    });

    expect(mocks.withContention).toHaveBeenCalledWith(
      `slack:resume-lock:${sharedThread}:${taskA}`,
      expect.any(Object),
    );
    expect(mocks.getSlackTaskRunWorkspacePredicate).toHaveBeenCalledWith(
      slackTeamId,
    );
    expect(mocks.where).toHaveBeenCalledWith({
      conditions: expect.arrayContaining([
        { left: 'taskRuns.taskId', right: taskA },
        { legacyWorkspacePredicate: slackTeamId },
      ]),
    });
    expect(mocks.queueSlackMessage).toHaveBeenCalledWith(
      103,
      expect.anything(),
    );
  });

  it('follows a contended legacy resume using only immutable task identity', async () => {
    mocks.findActiveSlackTaskRun.mockResolvedValue(null);
    mocks.findCompletedSlackTaskRunWithSnapshot.mockResolvedValue(
      slackRun(101, taskA),
    );
    mocks.dbSelectLimit.mockResolvedValueOnce([{ id: 103 }]);
    mocks.withContention.mockImplementation(
      async (
        _key: string,
        options: { onContended: () => Promise<number> },
      ) => ({
        value: await options.onContended(),
      }),
    );

    await dispatchPrReviewFollowUp({
      provider: 'slack',
      taskId: taskA,
      channelId: 'C123',
      threadId: sharedThread,
      followUpPrompt: prompt,
      actingUserId: 'user-1',
    });

    const where = mocks.where.mock.calls.at(-1)?.[0] as {
      conditions: unknown[];
    };
    expect(where.conditions).toEqual(
      expect.arrayContaining([
        { left: 'tasks.slackThreadTs', right: sharedThread },
        { left: 'taskRuns.taskId', right: taskA },
      ]),
    );
    expect(where.conditions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          legacyWorkspacePredicate: expect.anything(),
        }),
      ]),
    );
    expect(mocks.getSlackTaskRunWorkspacePredicate).not.toHaveBeenCalled();
    expect(mocks.queueSlackMessage).toHaveBeenCalledWith(
      103,
      expect.anything(),
    );
  });

  it('queues a Discord review action on its owning active task', async () => {
    const result = await dispatchPrReviewFollowUp({
      provider: 'discord',
      taskId: taskA,
      channelId: 'channel-1',
      threadId: 'thread-1',
      followUpPrompt: prompt,
      actingUserId: 'user-1',
      providerUserId: 'discord-user-1',
    });

    expect(result).toEqual({ outcome: 'queued', runId: 301 });
    expect(mocks.findActiveCommunicationTaskRun).toHaveBeenCalledWith({
      provider: 'discord',
      taskId: taskA,
      channelId: 'channel-1',
      threadId: 'thread-1',
    });
    expect(mocks.queueCommunicationMessage).toHaveBeenCalledWith(
      'discord',
      301,
      expect.objectContaining({
        text: prompt,
        userId: 'user-1',
        user: 'discord-user-1',
      }),
    );
  });

  it('resumes the owning Discord task snapshot', async () => {
    mocks.findActiveCommunicationTaskRun.mockResolvedValue(null);
    mocks.findCompletedCommunicationTaskRunWithSnapshot.mockImplementation(
      async ({ taskId }: { taskId?: string }) =>
        taskId === taskA
          ? communicationRun(301, taskA)
          : communicationRun(402, taskB),
    );

    const result = await dispatchPrReviewFollowUp({
      provider: 'discord',
      taskId: taskA,
      channelId: 'channel-1',
      threadId: 'thread-1',
      followUpPrompt: prompt,
      actingUserId: 'user-1',
    });

    expect(result).toEqual({ outcome: 'resumed', runId: 302 });
    expect(
      mocks.findCompletedCommunicationTaskRunWithSnapshot,
    ).toHaveBeenCalledWith({
      provider: 'discord',
      taskId: taskA,
      channelId: 'channel-1',
      threadId: 'thread-1',
    });
    expect(mocks.resumeCommunicationTaskFromSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'discord',
        completedRun: expect.objectContaining({ taskId: taskA, id: 301 }),
        queuedMessage: expect.objectContaining({ userId: 'user-1' }),
      }),
    );
  });
});
