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
      id: 'tasks.id',
      slackThreadTs: 'tasks.slackThreadTs',
    },
    taskRuns: {
      id: 'taskRuns.id',
      taskId: 'taskRuns.taskId',
      canceledAt: 'taskRuns.canceledAt',
      createdAt: 'taskRuns.createdAt',
      machineId: 'taskRuns.machineId',
      status: 'taskRuns.status',
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
  };
});

import { activeRunStatuses } from '@roomote/types';

import { findActiveSlackJob } from '../find-active-slack-job';

describe('findActiveSlackJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitMock.mockResolvedValue([]);
  });

  it('looks up the latest non-canceled run for the thread via the tasks channel binding', async () => {
    const result = await findActiveSlackJob('111.000');

    expect(result).toBeNull();
    expect(whereMock).toHaveBeenNthCalledWith(1, {
      and: [
        { eq: ['tasks.slackThreadTs', '111.000'] },
        { inArray: ['taskRuns.status', [...activeRunStatuses]] },
        { isNull: 'taskRuns.canceledAt' },
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

    const result = await findActiveSlackJob('111.000');

    expect(result).toMatchObject({ id: 42, taskId: 'task-42' });
    expect(whereMock).toHaveBeenCalledTimes(1);
  });
});
