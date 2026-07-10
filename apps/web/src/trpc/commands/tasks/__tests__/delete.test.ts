import type { UserAuthSuccess } from '@/types';

const {
  mockDeleteArtifactsBatch,
  mockMarkParallelCounts,
  tasksTable,
  taskArtifactsTable,
  deleteCalls,
  transactionSpy,
} = vi.hoisted(() => ({
  mockDeleteArtifactsBatch: vi.fn(),
  mockMarkParallelCounts: vi.fn(),
  tasksTable: { id: 'tasks.id', deletedAt: 'tasks.deletedAt' },
  taskArtifactsTable: {
    id: 'taskArtifacts.id',
    taskId: 'taskArtifacts.taskId',
    path: 'taskArtifacts.path',
    version: 'taskArtifacts.version',
  },
  deleteCalls: [] as unknown[],
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

const fakeTx = {
  select: () => ({
    from: (table: unknown) => ({
      where: async () =>
        table === taskArtifactsTable ? artifactRows : taskRows,
    }),
  }),
  delete: (table: unknown) => ({
    where: (condition: unknown) => {
      deleteCalls.push({ table, condition });
      return Promise.resolve();
    },
  }),
  update: () => ({
    set: () => ({
      where: () => ({
        returning: async () => taskRows,
      }),
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
  markTaskStartParallelCountsEndedAtForTaskIds: mockMarkParallelCounts,
  and: (...conditions: unknown[]) => ({ and: conditions }),
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
    mockDeleteArtifactsBatch.mockResolvedValue({ deleted: 1, errors: 0 });
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
  });
});
