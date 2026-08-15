const { limitMock, whereMock } = vi.hoisted(() => ({
  limitMock: vi.fn(),
  whereMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => {
  const queryChain: Record<string, unknown> = {};

  Object.assign(queryChain, {
    from: vi.fn(() => queryChain),
    innerJoin: vi.fn(() => queryChain),
    where: whereMock.mockImplementation(() => queryChain),
    orderBy: vi.fn(() => queryChain),
    limit: limitMock,
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
      canceledAt: 'taskRuns.canceledAt',
      createdAt: 'taskRuns.createdAt',
      machineId: 'taskRuns.machineId',
      payload: 'taskRuns.payload',
      status: 'taskRuns.status',
    },
    slackInstallations: {
      isActive: 'slackInstallations.isActive',
      teamId: 'slackInstallations.teamId',
    },
    db: {
      select: vi.fn(() => queryChain),
    },
    getTableColumns: vi.fn((table: Record<string, unknown>) => table),
    desc: vi.fn((value: unknown) => ({ desc: value })),
    eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
    inArray: vi.fn((left: unknown, right: unknown[]) => ({
      inArray: [left, right],
    })),
    isNull: vi.fn((value: unknown) => ({ isNull: value })),
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      sql: [strings.raw.join('?'), ...values],
    })),
  };
});

import { activeRunStatuses } from '@roomote/types';

import { findActiveSlackTaskRun } from '../find-active-slack-task-run';

describe('findActiveSlackTaskRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitMock.mockResolvedValue([]);
  });

  it('looks up the latest non-canceled run for the thread via the tasks channel binding', async () => {
    const result = await findActiveSlackTaskRun('111.000', {
      slackTeamId: 'T-first',
    });

    expect(result).toBeNull();
    expect(whereMock).toHaveBeenNthCalledWith(1, {
      and: [
        { eq: ['tasks.slackThreadTs', '111.000'] },
        expect.objectContaining({
          sql: expect.arrayContaining(['T-first']),
        }),
        { inArray: ['taskRuns.status', [...activeRunStatuses]] },
        { isNull: 'taskRuns.canceledAt' },
        { isNull: 'tasks.deletedAt' },
      ],
    });
  });

  it('returns the most recent active run when one exists', async () => {
    limitMock.mockResolvedValueOnce([
      {
        id: 42,
        taskId: 'task-42',
        status: 'running',
        machineId: 'machine-1',
        payload: {},
      },
    ]);

    const result = await findActiveSlackTaskRun('111.000', {
      slackTeamId: 'T-first',
    });

    expect(result).toMatchObject({ id: 42, taskId: 'task-42' });
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it('enforces task and workspace identity when both are supplied', async () => {
    await findActiveSlackTaskRun('111.000', {
      taskId: 'task-1',
      slackTeamId: 'T-second',
    });

    expect(whereMock).toHaveBeenNthCalledWith(1, {
      and: [
        { eq: ['tasks.slackThreadTs', '111.000'] },
        { eq: ['taskRuns.taskId', 'task-1'] },
        expect.objectContaining({
          sql: expect.arrayContaining([
            expect.stringContaining('SELECT count(*)'),
            'T-second',
          ]),
        }),
        { inArray: ['taskRuns.status', [...activeRunStatuses]] },
        { isNull: 'taskRuns.canceledAt' },
        { isNull: 'tasks.deletedAt' },
      ],
    });
  });
});
