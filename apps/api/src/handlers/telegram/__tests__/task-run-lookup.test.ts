import { beforeEach, describe, expect, it, vi } from 'vitest';

const { whereMock } = vi.hoisted(() => ({
  whereMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: whereMock,
    orderBy: vi.fn(),
    limit: vi.fn(async () => []),
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
    tasks: {
      id: 'tasks.id',
      initiatorUserId: 'tasks.initiatorUserId',
    },
  };
});

import { findActiveTelegramTaskRun } from '../task-run-lookup';

describe('Telegram task run topic lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
