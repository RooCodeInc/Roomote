import { beforeEach, describe, expect, it, vi } from 'vitest';

const { limitMock, whereMock } = vi.hoisted(() => ({
  limitMock: vi.fn(async () => []),
  whereMock: vi.fn(),
}));

const { findTaskBackedAutomationReportRunMock } = vi.hoisted(() => ({
  findTaskBackedAutomationReportRunMock: vi.fn(),
}));

vi.mock('@roomote/sdk/server/communication', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@roomote/sdk/server/communication')
  >()),
  findTaskBackedAutomationReportRun: findTaskBackedAutomationReportRunMock,
}));

vi.mock('@roomote/db/server', () => {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: whereMock,
    orderBy: vi.fn(),
    limit: limitMock,
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
    inArray: vi.fn((left: unknown, right: unknown) => ({ left, right })),
    isNull: vi.fn((value: unknown) => ({ isNull: value })),
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: Array.from(strings),
      values,
    })),
    taskRuns: {
      actingUserId: 'taskRuns.actingUserId',
      canceledAt: 'taskRuns.canceledAt',
      createdAt: 'taskRuns.createdAt',
      id: 'taskRuns.id',
      machineId: 'taskRuns.machineId',
      payload: 'taskRuns.payload',
      payloadKind: 'taskRuns.payloadKind',
      port: 'taskRuns.port',
      snapshotCreatedAt: 'taskRuns.snapshotCreatedAt',
      snapshotId: 'taskRuns.snapshotId',
      status: 'taskRuns.status',
      taskId: 'taskRuns.taskId',
    },
    trackedMessages: {
      automationKey: 'trackedMessages.automationKey',
      channelId: 'trackedMessages.channelId',
      kind: 'trackedMessages.kind',
      metadata: 'trackedMessages.metadata',
      surface: 'trackedMessages.surface',
      threadTs: 'trackedMessages.threadTs',
    },
    tasks: {
      id: 'tasks.id',
      initiatorUserId: 'tasks.initiatorUserId',
    },
  };
});

import {
  findActiveTelegramTaskRun,
  findTelegramAutomationReportRun,
} from '../task-run-lookup';

describe('Telegram task run topic lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitMock.mockReset();
    limitMock.mockResolvedValue([]);
  });

  it('requires an absent task topic for a root-chat lookup', async () => {
    await findActiveTelegramTaskRun({ chatId: '111000111' });

    const where = whereMock.mock.calls[0]?.[0] as {
      conditions: Array<{ strings?: string[] }>;
    };
    const threadCondition = where.conditions.find((condition) =>
      condition.strings?.join('').includes('communicationThreadId'),
    );

    expect(threadCondition?.strings?.join('')).toContain('IS NULL');
  });

  it('requires an exact topic for a topic lookup', async () => {
    await findActiveTelegramTaskRun({ chatId: '111000111', threadId: '77' });

    const where = whereMock.mock.calls[0]?.[0] as {
      conditions: Array<{ strings?: string[]; values?: unknown[] }>;
    };
    const threadCondition = where.conditions.find((condition) =>
      condition.strings?.join('').includes('communicationThreadId'),
    );

    expect(threadCondition?.strings?.join('')).not.toContain('IS NULL');
    expect(threadCondition?.values).toContain('77');
  });

  it('looks up an announcer report by the replied-to root message id', async () => {
    await findTelegramAutomationReportRun({
      chatId: '111000111',
      messageId: 'report-root-77',
    });

    expect(findTaskBackedAutomationReportRunMock).toHaveBeenCalledWith({
      provider: 'telegram',
      channelId: '111000111',
      messageId: 'report-root-77',
    });
  });
});
