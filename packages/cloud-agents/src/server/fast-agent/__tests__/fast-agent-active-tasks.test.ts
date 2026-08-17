const mocks = vi.hoisted(() => ({
  activeRuns: [] as Array<{
    taskId: string;
    title: string;
    status: string;
    canceledAt: Date | null;
  }>,
}));

vi.mock('@roomote/db/server', () => {
  const orderBy = vi.fn(async () => mocks.activeRuns);
  const where = vi.fn(() => ({ orderBy }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));

  return {
    and: vi.fn((...values: unknown[]) => values),
    desc: vi.fn((value: unknown) => value),
    db: {
      select: vi.fn(() => ({ from })),
    },
    eq: vi.fn((...values: unknown[]) => values),
    inArray: vi.fn((...values: unknown[]) => values),
    isNull: vi.fn((value: unknown) => value),
    slackQuickAnswers: {},
    sql: vi.fn(),
    taskRuns: {
      createdAt: 'task_runs.created_at',
      payload: 'task_runs.payload',
      status: 'task_runs.status',
      taskId: 'task_runs.task_id',
      canceledAt: 'task_runs.canceled_at',
    },
    tasks: {
      id: 'tasks.id',
      title: 'tasks.title',
      deletedAt: 'tasks.deleted_at',
    },
  };
});

import { RunStatus } from '@roomote/types';
import { getActiveFastAgentTasks } from '../fast-agent-session';

describe('getActiveFastAgentTasks', () => {
  it('returns every distinct active task and keeps the newest run per task', async () => {
    mocks.activeRuns = [
      {
        taskId: 'task-2',
        title: 'Update docs',
        status: RunStatus.Running,
        canceledAt: null,
      },
      {
        taskId: 'task-1',
        title: 'Fix API',
        status: RunStatus.Processing,
        canceledAt: null,
      },
      {
        taskId: 'task-1',
        title: 'Fix API',
        status: RunStatus.Pending,
        canceledAt: null,
      },
      {
        taskId: 'task-3',
        title: 'Settled restart',
        status: RunStatus.Completed,
        canceledAt: null,
      },
      {
        taskId: 'task-3',
        title: 'Settled restart',
        status: RunStatus.Idle,
        canceledAt: null,
      },
      {
        taskId: 'task-4',
        title: 'Canceled task',
        status: RunStatus.Running,
        canceledAt: new Date('2026-08-17T00:00:00Z'),
      },
    ];

    await expect(getActiveFastAgentTasks('session-1')).resolves.toEqual([
      {
        taskId: 'task-2',
        title: 'Update docs',
        status: RunStatus.Running,
      },
      {
        taskId: 'task-1',
        title: 'Fix API',
        status: RunStatus.Processing,
      },
    ]);
  });
});
