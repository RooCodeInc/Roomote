const mocks = vi.hoisted(() => ({
  clearLatestUserMessage: vi.fn(),
  enqueueTask: vi.fn(),
  findActiveCommunicationTaskRun: vi.fn(),
  findActiveSlackTaskRun: vi.fn(),
  findCompletedCommunicationTaskRunWithSnapshot: vi.fn(),
  findCompletedSlackTaskRunWithSnapshot: vi.fn(),
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
    limit: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockResolvedValue([{ id: 103 }]);

  return {
    and: vi.fn((...conditions: unknown[]) => ({ conditions })),
    db: { select: vi.fn(() => chain) },
    desc: vi.fn((value: unknown) => value),
    eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
    gt: vi.fn((left: unknown, right: unknown) => ({ left, right })),
    setTrustedRunActingUser: mocks.setTrustedRunActingUser,
    taskRuns: {
      createdAt: 'taskRuns.createdAt',
      id: 'taskRuns.id',
      kind: 'taskRuns.kind',
      taskId: 'taskRuns.taskId',
    },
    tasks: { id: 'tasks.id', slackThreadTs: 'tasks.slackThreadTs' },
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

function communicationRun(id: number, taskId: string) {
  return {
    ...slackRun(id, taskId),
    userId: 'owner-user',
  };
}

describe('dispatchPrReviewFollowUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findActiveSlackTaskRun.mockImplementation(
      async (_threadId: string, taskId?: string) =>
        taskId === taskA ? slackRun(101, taskA) : slackRun(202, taskB),
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
    mocks.resumeCommunicationTaskFromSnapshot.mockResolvedValue({ id: 302 });
  });

  it('queues an active Slack review action on its owning task when a newer task shares the thread', async () => {
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
    expect(mocks.findActiveSlackTaskRun).toHaveBeenCalledWith(
      sharedThread,
      taskA,
    );
    expect(mocks.queueSlackMessage).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ text: prompt, userId: 'user-1', user: 'U123' }),
    );
  });

  it('resumes the owning Slack task snapshot instead of a newer task in the thread', async () => {
    mocks.findActiveSlackTaskRun.mockResolvedValue(null);
    mocks.findCompletedSlackTaskRunWithSnapshot.mockImplementation(
      async (_threadId: string, taskId?: string) =>
        taskId === taskA ? slackRun(101, taskA) : slackRun(202, taskB),
    );

    const result = await dispatchPrReviewFollowUp({
      provider: 'slack',
      taskId: taskA,
      channelId: 'C123',
      threadId: sharedThread,
      followUpPrompt: prompt,
      actingUserId: 'user-1',
    });

    expect(result).toEqual({ outcome: 'resumed', runId: 102 });
    expect(mocks.findCompletedSlackTaskRunWithSnapshot).toHaveBeenCalledWith(
      sharedThread,
      taskA,
    );
    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({ sourceRunId: 101 }),
        actingUserId: 'user-1',
      }),
      {},
    );
  });

  it('shares Slack resume contention with typed and drain follow-ups', async () => {
    mocks.findActiveSlackTaskRun.mockResolvedValue(null);
    mocks.findCompletedSlackTaskRunWithSnapshot.mockResolvedValue(
      slackRun(101, taskA),
    );
    mocks.withContention.mockImplementation(
      async (key: string, options: { onContended: () => Promise<number> }) => ({
        key,
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

    expect(mocks.withContention).toHaveBeenCalledWith(
      `slack:resume-lock:${sharedThread}:${taskA}`,
      expect.any(Object),
    );
    expect(mocks.where).toHaveBeenCalledWith({
      conditions: expect.arrayContaining([
        { left: 'taskRuns.taskId', right: taskA },
      ]),
    });
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
