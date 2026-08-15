const { whereMock } = vi.hoisted(() => ({
  whereMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => {
  const queryChain: Record<string, unknown> = {};

  Object.assign(queryChain, {
    from: vi.fn(() => queryChain),
    innerJoin: vi.fn(() => queryChain),
    where: whereMock.mockImplementation(() => queryChain),
    orderBy: vi.fn(() => queryChain),
    limit: vi.fn(async () => []),
  });

  return {
    and: vi.fn((...args: unknown[]) => ({ and: args })),
    tasks: {
      deletedAt: 'tasks.deletedAt',
      id: 'tasks.id',
      slackThreadTs: 'tasks.slackThreadTs',
    },
    taskRuns: {
      id: 'taskRuns.id',
      taskId: 'taskRuns.taskId',
      actingUserId: 'taskRuns.actingUserId',
      snapshotId: 'taskRuns.snapshotId',
      snapshotFailedAt: 'taskRuns.snapshotFailedAt',
      snapshotCreatedAt: 'taskRuns.snapshotCreatedAt',
      canceledAt: 'taskRuns.canceledAt',
      createdAt: 'taskRuns.createdAt',
      payload: 'taskRuns.payload',
      port: 'taskRuns.port',
      result: 'taskRuns.result',
      status: 'taskRuns.status',
    },
    slackInstallations: {
      isActive: 'slackInstallations.isActive',
      teamId: 'slackInstallations.teamId',
    },
    db: { select: vi.fn(() => queryChain) },
    desc: vi.fn((value: unknown) => ({ desc: value })),
    eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
    gt: vi.fn((left: unknown, right: unknown) => ({ gt: [left, right] })),
    inArray: vi.fn((left: unknown, right: unknown[]) => ({
      inArray: [left, right],
    })),
    isNotNull: vi.fn((value: unknown) => ({ isNotNull: value })),
    isNull: vi.fn((value: unknown) => ({ isNull: value })),
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      sql: [strings.raw.join('?'), ...values],
    })),
  };
});

import { findCompletedSlackTaskRunWithSnapshot } from '../find-completed-slack-task-run-with-snapshot';

describe('findCompletedSlackTaskRunWithSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('isolates reused thread timestamps by Slack workspace', async () => {
    await findCompletedSlackTaskRunWithSnapshot('111.000', {
      slackTeamId: 'T-second',
    });

    expect(whereMock).toHaveBeenCalledWith({
      and: expect.arrayContaining([
        { eq: ['tasks.slackThreadTs', '111.000'] },
        expect.objectContaining({
          sql: expect.arrayContaining([
            expect.stringContaining('SELECT count(*)'),
            'T-second',
          ]),
        }),
        { isNull: 'tasks.deletedAt' },
      ]),
    });
  });

  it('can resolve a trusted tracked-thread alias by task id alone', async () => {
    await findCompletedSlackTaskRunWithSnapshot('111.000', {
      taskId: 'task-1',
      matchTaskIdWithoutThread: true,
    });

    expect(whereMock).toHaveBeenCalledWith({
      and: expect.arrayContaining([
        { eq: ['taskRuns.taskId', 'task-1'] },
        { isNull: 'tasks.deletedAt' },
      ]),
    });
    expect(whereMock.mock.calls[0]?.[0].and).not.toContainEqual({
      eq: ['tasks.slackThreadTs', '111.000'],
    });
  });
});
