import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  taskRunRowsMock,
  whereMock,
  findBackgroundAutomationSlackThreadMock,
  getLatestSlackBotReplyMock,
} = vi.hoisted(() => ({
  taskRunRowsMock: vi.fn(),
  whereMock: vi.fn(),
  findBackgroundAutomationSlackThreadMock: vi.fn(),
  getLatestSlackBotReplyMock: vi.fn(),
}));

vi.mock('@roomote/cloud-agents', () => ({
  stripLeadingRawSlackMention: vi.fn((text: string) => text),
  stripLeadingSlackProductMention: vi.fn((text: string) => text),
}));

vi.mock('@roomote/sdk/server', () => ({
  recordSlackConversationMessageBestEffort: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  getLatestSlackBotReply: getLatestSlackBotReplyMock,
}));

vi.mock('@roomote/db/server', () => {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: whereMock,
    orderBy: vi.fn(),
    limit: vi.fn(async () => taskRunRowsMock()),
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
    isNull: vi.fn((value: unknown) => ({ isNull: value })),
    findBackgroundAutomationSlackThread:
      findBackgroundAutomationSlackThreadMock,
    taskRuns: {
      actingUserId: 'taskRuns.actingUserId',
      createdAt: 'taskRuns.createdAt',
      id: 'taskRuns.id',
      payload: 'taskRuns.payload',
      taskId: 'taskRuns.taskId',
    },
    tasks: {
      deletedAt: 'tasks.deletedAt',
      id: 'tasks.id',
      initiatorUserId: 'tasks.initiatorUserId',
      slackThreadTs: 'tasks.slackThreadTs',
    },
  };
});

import { findRoomoteOwnedSlackThread } from '../conversation-log';

const THREAD = { teamId: 'T1', channelId: 'C1', threadTs: '100.000' };

describe('findRoomoteOwnedSlackThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskRunRowsMock.mockResolvedValue([]);
    findBackgroundAutomationSlackThreadMock.mockResolvedValue(null);
    getLatestSlackBotReplyMock.mockResolvedValue(null);
  });

  it.each([
    ['ci_failure_triage'],
    ['sentry_triage'],
    ['announcer'],
    ['platform_issue_alerts'],
  ])(
    'treats a task-bound %s report thread as an automation report thread',
    async (automationKey) => {
      taskRunRowsMock.mockResolvedValue([
        {
          id: 7,
          taskId: 'task-1',
          payload: { channel: 'C1' },
          initiatorUserId: null,
          actingUserId: null,
        },
      ]);
      findBackgroundAutomationSlackThreadMock.mockResolvedValue({
        automationKey,
        metadata: { sourceTaskId: 'task-1' },
      });

      await expect(findRoomoteOwnedSlackThread(THREAD)).resolves.toMatchObject({
        isAutomationReportThread: true,
      });
    },
  );

  it('ignores a tracked automation thread with no bound task', async () => {
    findBackgroundAutomationSlackThreadMock.mockResolvedValue({
      automationKey: 'ci_failure_triage',
      metadata: {},
    });

    await expect(findRoomoteOwnedSlackThread(THREAD)).resolves.toBeNull();
  });

  it('resolves a tracked report alias without replacing the task source thread', async () => {
    taskRunRowsMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { initiatorUserId: 'user-1', actingUserId: null },
      ]);
    findBackgroundAutomationSlackThreadMock.mockResolvedValue({
      automationKey: 'platform_issue_alerts',
      metadata: { sourceTaskId: 'task-source' },
    });

    await expect(findRoomoteOwnedSlackThread(THREAD)).resolves.toMatchObject({
      taskId: 'task-source',
      userId: 'user-1',
      isAutomationReportThread: true,
    });
  });

  it('does not treat soft-deleted task bindings as thread ownership', async () => {
    await findRoomoteOwnedSlackThread(THREAD);

    expect(whereMock).toHaveBeenNthCalledWith(1, {
      conditions: [
        { left: 'tasks.slackThreadTs', right: THREAD.threadTs },
        { isNull: 'tasks.deletedAt' },
      ],
    });
  });
});
