import type { UserAuthSuccess } from '@/types';

const {
  mockDeleteArtifactsBatch,
  mockMarkParallelCounts,
  mockGetSessionForTask,
  mockTouchSessionActivity,
  tasksTable,
  taskArtifactsTable,
  sessionsTable,
  sessionTasksTable,
  deleteCalls,
  updateCalls,
  transactionSpy,
} = vi.hoisted(() => ({
  mockDeleteArtifactsBatch: vi.fn(),
  mockMarkParallelCounts: vi.fn(),
  mockGetSessionForTask: vi.fn(),
  mockTouchSessionActivity: vi.fn(),
  tasksTable: { id: 'tasks.id', deletedAt: 'tasks.deletedAt' },
  taskArtifactsTable: {
    id: 'taskArtifacts.id',
    taskId: 'taskArtifacts.taskId',
    path: 'taskArtifacts.path',
    version: 'taskArtifacts.version',
  },
  sessionsTable: { id: 'sessions.id', archivedAt: 'sessions.archivedAt' },
  sessionTasksTable: {
    sessionId: 'sessionTasks.sessionId',
    taskId: 'sessionTasks.taskId',
  },
  deleteCalls: [] as unknown[],
  updateCalls: [] as unknown[],
  transactionSpy: vi.fn(),
}));

// Rows the fake transaction returns for each table's SELECT.
const taskRows = [{ id: 'task-1' }];
const artifactRows = [
  {
    id: 'artifact-1',
    taskId: 'task-1',
    path: 'diff.patch',
    version: 0,
  },
];

// Rows the fake sessionTasks SELECT returns; tests override to simulate a
// session left with no remaining live tasks.
const remainingSessionTaskRows: Array<{ taskId: string }> = [];

const fakeTx = {
  select: () => ({
    from: (table: unknown) => {
      const rowsFor = () =>
        table === taskArtifactsTable
          ? artifactRows
          : table === sessionTasksTable
            ? remainingSessionTaskRows
            : taskRows;
      return {
        where: () =>
          Object.assign(Promise.resolve(rowsFor()), {
            limit: async () => rowsFor(),
          }),
        innerJoin: () => ({
          where: () => ({ limit: async () => rowsFor() }),
        }),
      };
    },
  }),
  delete: (table: unknown) => ({
    where: (condition: unknown) => {
      deleteCalls.push({ table, condition });
      return Promise.resolve();
    },
  }),
  update: (table: unknown) => ({
    set: (values: unknown) => ({
      where: (condition: unknown) => {
        updateCalls.push({ table, values, condition });
        return Object.assign(Promise.resolve(), {
          returning: async () => taskRows,
        });
      },
    }),
  }),
};

vi.mock('@roomote/db/server', () => ({
  db: {
    transaction: (callback: (tx: typeof fakeTx) => unknown) => {
      transactionSpy();
      return callback(fakeTx);
    },
  },
  tasks: tasksTable,
  taskArtifacts: taskArtifactsTable,
  sessions: sessionsTable,
  sessionTasks: sessionTasksTable,
  markTaskStartParallelCountsEndedAtForTaskIds: mockMarkParallelCounts,
  getSessionForTask: mockGetSessionForTask,
  touchSessionActivity: mockTouchSessionActivity,
  and: (...conditions: unknown[]) => ({ and: conditions }),
  eq: (left: unknown, right: unknown) => ({ eq: [left, right] }),
  inArray: (column: unknown, values: unknown) => ({
    inArray: [column, values],
  }),
  isNull: (column: unknown) => ({ isNull: column }),
}));

vi.mock('@/lib/server', () => ({
  deleteArtifactsBatch: mockDeleteArtifactsBatch,
}));

import { deleteTasksCommand } from '../delete';

describe('deleteTasksCommand', () => {
  const auth = {
    success: true,
    userType: 'user',
    userId: 'user-delete-test',
    isAdmin: false,
  } as UserAuthSuccess;

  beforeEach(() => {
    vi.clearAllMocks();
    deleteCalls.length = 0;
    updateCalls.length = 0;
    remainingSessionTaskRows.length = 0;
    mockDeleteArtifactsBatch.mockResolvedValue({ deleted: 1, errors: 0 });
    mockGetSessionForTask.mockResolvedValue({
      id: 'session-1',
      activityAt: 100,
      fastConversationId: null,
      archivedAt: null,
    });
  });

  it('deletes taskArtifacts rows inside the soft-delete transaction', async () => {
    const result = await deleteTasksCommand(auth, { taskIds: ['task-1'] });

    expect(result).toEqual({ success: true, deletedCount: 1 });

    // S3 objects removed for the queried artifacts.
    expect(mockDeleteArtifactsBatch).toHaveBeenCalledWith([
      {
        taskId: 'task-1',
        artifactId: 'artifact-1',
        path: 'diff.patch',
        version: 0,
      },
    ]);

    // taskArtifacts rows deleted from the database in the same transaction.
    const artifactDelete = deleteCalls.find(
      (call): call is { table: unknown; condition: unknown } =>
        typeof call === 'object' &&
        call !== null &&
        (call as { table: unknown }).table === taskArtifactsTable,
    );
    expect(artifactDelete).toBeDefined();
    expect(mockGetSessionForTask).toHaveBeenCalledWith(fakeTx, 'task-1');
    expect(mockTouchSessionActivity).toHaveBeenCalledWith(
      fakeTx,
      'session-1',
      100,
    );
  });

  it('archives a session left with no live tasks', async () => {
    await deleteTasksCommand(auth, { taskIds: ['task-1'] });

    const archiveUpdate = updateCalls.find(
      (call) => (call as { table: unknown }).table === sessionsTable,
    ) as { values: { archivedAt: unknown } } | undefined;
    expect(archiveUpdate).toBeDefined();
    expect(archiveUpdate!.values.archivedAt).toBeInstanceOf(Date);
  });

  it('keeps a session visible when live tasks remain', async () => {
    remainingSessionTaskRows.push({ taskId: 'task-2' });

    await deleteTasksCommand(auth, { taskIds: ['task-1'] });

    expect(
      updateCalls.some(
        (call) => (call as { table: unknown }).table === sessionsTable,
      ),
    ).toBe(false);
  });

  it('never archives a session that has a fast conversation', async () => {
    mockGetSessionForTask.mockResolvedValue({
      id: 'session-1',
      activityAt: 100,
      fastConversationId: 'fast-1',
      archivedAt: null,
    });

    await deleteTasksCommand(auth, { taskIds: ['task-1'] });

    expect(
      updateCalls.some(
        (call) => (call as { table: unknown }).table === sessionsTable,
      ),
    ).toBe(false);
  });
});
