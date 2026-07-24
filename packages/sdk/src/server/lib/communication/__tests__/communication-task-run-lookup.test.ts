import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryResults, whereMock } = vi.hoisted(() => ({
  queryResults: [] as unknown[][],
  whereMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: whereMock,
    orderBy: vi.fn(),
    limit: vi.fn(async () => queryResults.shift() ?? []),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);

  return {
    and: vi.fn((...conditions: unknown[]) => ({ conditions })),
    asc: vi.fn((value: unknown) => value),
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
    trackedMessages: {
      automationKey: 'trackedMessages.automationKey',
      channelId: 'trackedMessages.channelId',
      kind: 'trackedMessages.kind',
      metadata: 'trackedMessages.metadata',
      surface: 'trackedMessages.surface',
      threadTs: 'trackedMessages.threadTs',
    },
  };
});

import { findTaskBackedAutomationReportRun } from '../communication-task-run-lookup';

function automationRun(id: number, taskId: string) {
  return {
    id,
    taskId,
    initiatorUserId: null,
    actingUserId: null,
    payload: { backgroundAutomationKey: 'announcer' },
  };
}

describe('findTaskBackedAutomationReportRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.length = 0;
  });

  it('keeps two announcer roots in the same channel bound to their own runs', async () => {
    queryResults.push(
      [automationRun(11, 'announcer-task-one')],
      [automationRun(22, 'announcer-task-two')],
    );

    await expect(
      findTaskBackedAutomationReportRun({
        provider: 'discord',
        channelId: 'channel-1',
        messageId: 'announcer-root-one',
      }),
    ).resolves.toMatchObject({ id: 11, taskId: 'announcer-task-one' });
    await expect(
      findTaskBackedAutomationReportRun({
        provider: 'discord',
        channelId: 'channel-1',
        messageId: 'announcer-root-two',
      }),
    ).resolves.toMatchObject({ id: 22, taskId: 'announcer-task-two' });

    const messageIds = whereMock.mock.calls
      .flatMap(([condition]) => condition.conditions ?? [])
      .flatMap((condition: { values?: unknown[] }) => condition.values ?? [])
      .filter((value) => typeof value === 'string');
    expect(messageIds).toEqual(
      expect.arrayContaining(['announcer-root-one', 'announcer-root-two']),
    );
  });

  it('falls back from a missing payload binding to the tracked automation thread source task', async () => {
    queryResults.push(
      [],
      [{ sourceTaskId: 'announcer-task-one' }],
      [automationRun(11, 'announcer-task-one')],
    );

    await expect(
      findTaskBackedAutomationReportRun({
        provider: 'telegram',
        channelId: 'chat-1',
        messageId: 'announcer-root-one',
      }),
    ).resolves.toMatchObject({ id: 11, taskId: 'announcer-task-one' });
  });
});
