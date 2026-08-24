const {
  mockLinkedTasks,
  mockReturning,
  mockSyncTaskStateFromRuns,
  mockTransaction,
} = vi.hoisted(() => {
  const mockLinkedTasks = vi.fn();
  const mockReturning = vi.fn();
  const mockSyncTaskStateFromRuns = vi.fn();
  const mockTransaction = vi.fn(async (callback: (tx: unknown) => unknown) =>
    callback({
      select: () => ({
        from: () => ({ where: mockLinkedTasks }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({ returning: mockReturning }),
        }),
      }),
    }),
  );

  return {
    mockLinkedTasks,
    mockReturning,
    mockSyncTaskStateFromRuns,
    mockTransaction,
  };
});

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );

  return {
    ...actual,
    db: { transaction: mockTransaction },
    syncTaskStateFromRuns: (...args: unknown[]) =>
      mockSyncTaskStateFromRuns(...args),
  };
});

vi.mock('@roomote/telemetry/server', () => ({
  captureActivationPrMerged: vi.fn(),
}));

import { updateTaskPrStatus } from '../update-task-pr-status';

describe('updateTaskPrStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLinkedTasks.mockResolvedValue([]);
    mockReturning.mockResolvedValue([]);
    mockSyncTaskStateFromRuns.mockResolvedValue(undefined);
  });

  it('reconciles each linked task state once when a pull request is merged', async () => {
    mockLinkedTasks.mockResolvedValue([
      { taskId: 'task-2' },
      { taskId: 'task-1' },
      { taskId: 'task-1' },
    ]);

    await updateTaskPrStatus('github', 'owner/repo', 42, 'merged');

    const tx = expect.any(Object);
    expect(mockSyncTaskStateFromRuns).toHaveBeenCalledTimes(2);
    expect(mockSyncTaskStateFromRuns).toHaveBeenNthCalledWith(1, tx, 'task-1');
    expect(mockSyncTaskStateFromRuns).toHaveBeenNthCalledWith(2, tx, 'task-2');
  });

  it('reconciles on a repeated merge event after the PR status was already updated', async () => {
    mockLinkedTasks.mockResolvedValue([{ taskId: 'task-1' }]);
    mockReturning.mockResolvedValue([]);

    await updateTaskPrStatus('github', 'owner/repo', 42, 'merged');

    expect(mockSyncTaskStateFromRuns).toHaveBeenCalledWith(
      expect.any(Object),
      'task-1',
    );
  });

  it('does not reconcile task state when a pull request is closed unmerged', async () => {
    mockReturning.mockResolvedValue([
      { taskId: 'task-1', createdByRoomote: false },
    ]);

    await updateTaskPrStatus('github', 'owner/repo', 42, 'closed');

    expect(mockSyncTaskStateFromRuns).not.toHaveBeenCalled();
    expect(mockLinkedTasks).not.toHaveBeenCalled();
  });
});
