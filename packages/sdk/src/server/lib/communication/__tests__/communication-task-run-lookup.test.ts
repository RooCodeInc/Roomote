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
      initiatorKind: 'tasks.initiatorKind',
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

import {
  findActiveCommunicationTaskRun,
  findTaskBackedAutomationReportRun,
} from '../communication-task-run-lookup';

function automationRun(id: number, taskId: string) {
  return {
    id,
    taskId,
    initiatorUserId: null,
    actingUserId: null,
    payload: {},
  };
}

function whereConditions() {
  return whereMock.mock.calls.flatMap(
    ([condition]) => condition.conditions ?? [],
  );
}

describe('findTaskBackedAutomationReportRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.length = 0;
  });

  it('keeps two report roots in the same channel bound to their own runs', async () => {
    queryResults.push(
      [automationRun(11, 'report-task-one')],
      [automationRun(22, 'report-task-two')],
    );

    await expect(
      findTaskBackedAutomationReportRun({
        provider: 'discord',
        channelId: 'channel-1',
        messageId: 'report-root-one',
      }),
    ).resolves.toMatchObject({ id: 11, taskId: 'report-task-one' });
    await expect(
      findTaskBackedAutomationReportRun({
        provider: 'discord',
        channelId: 'channel-1',
        messageId: 'report-root-two',
      }),
    ).resolves.toMatchObject({ id: 22, taskId: 'report-task-two' });

    const messageIds = whereConditions()
      .flatMap((condition: { values?: unknown[] }) => condition.values ?? [])
      .filter((value) => typeof value === 'string');
    expect(messageIds).toEqual(
      expect.arrayContaining(['report-root-one', 'report-root-two']),
    );
  });

  it('matches any automation-initiated task, not one hardcoded automation key', async () => {
    queryResults.push([automationRun(11, 'ci-triage-task')]);

    await expect(
      findTaskBackedAutomationReportRun({
        provider: 'discord',
        channelId: 'channel-1',
        messageId: 'ci-triage-root',
      }),
    ).resolves.toMatchObject({ id: 11, taskId: 'ci-triage-task' });

    const conditions = whereConditions();
    expect(conditions).toContainEqual({
      left: 'tasks.initiatorKind',
      right: 'automation',
    });
    expect(
      conditions.some((condition: { strings?: string[] }) =>
        condition.strings?.some((fragment) => fragment.includes('announcer')),
      ),
    ).toBe(false);
  });

  it('falls back from a missing payload binding to the tracked automation thread source task', async () => {
    queryResults.push(
      [],
      [{ sourceTaskId: 'report-task-one' }],
      [automationRun(11, 'report-task-one')],
    );

    await expect(
      findTaskBackedAutomationReportRun({
        provider: 'telegram',
        channelId: 'chat-1',
        messageId: 'report-root-one',
      }),
    ).resolves.toMatchObject({ id: 11, taskId: 'report-task-one' });

    // The tracked-thread fallback must not filter on a specific automation
    // key either, or non-announcer reports lose their late-bound roots.
    expect(whereConditions()).not.toContainEqual({
      left: 'trackedMessages.automationKey',
      right: 'announcer',
    });
  });
});

describe('findActiveCommunicationTaskRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.length = 0;
  });

  it('preserves conversation-wide lookup unless an immutable task binding is supplied', async () => {
    queryResults.push([], []);

    await findActiveCommunicationTaskRun({
      provider: 'discord',
      channelId: 'channel-1',
      threadId: 'thread-1',
    });
    await findActiveCommunicationTaskRun({
      provider: 'discord',
      channelId: 'channel-1',
      threadId: 'thread-1',
      taskId: 'task-1',
    });

    const firstConditions = whereMock.mock.calls[0]?.[0]?.conditions ?? [];
    const secondConditions = whereMock.mock.calls[1]?.[0]?.conditions ?? [];
    expect(firstConditions).not.toContainEqual({
      left: 'taskRuns.taskId',
      right: 'task-1',
    });
    expect(secondConditions).toContainEqual({
      left: 'taskRuns.taskId',
      right: 'task-1',
    });
  });
});
