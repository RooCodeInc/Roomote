const {
  mockLinkedTasks,
  mockLockTaskResolution,
  mockReturning,
  mockResolveTaskResolutionFromLinkedPullRequests,
  mockSyncTaskStateFromRuns,
  mockTransaction,
} = vi.hoisted(() => {
  const mockLinkedTasks = vi.fn();
  const mockLockTaskResolution = vi.fn();
  const mockReturning = vi.fn();
  const mockResolveTaskResolutionFromLinkedPullRequests = vi.fn();
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
    mockLockTaskResolution,
    mockReturning,
    mockResolveTaskResolutionFromLinkedPullRequests,
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
    lockTaskResolution: (...args: unknown[]) => mockLockTaskResolution(...args),
    resolveTaskResolutionFromLinkedPullRequests: (...args: unknown[]) =>
      mockResolveTaskResolutionFromLinkedPullRequests(...args),
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
    mockLockTaskResolution.mockResolvedValue(undefined);
    mockReturning.mockResolvedValue([]);
    mockResolveTaskResolutionFromLinkedPullRequests.mockResolvedValue(false);
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
    expect(mockLockTaskResolution).toHaveBeenNthCalledWith(1, 'task-1', {
      executor: tx,
    });
    expect(mockLockTaskResolution).toHaveBeenNthCalledWith(2, 'task-2', {
      executor: tx,
    });
    expect(mockSyncTaskStateFromRuns).toHaveBeenNthCalledWith(1, tx, 'task-1');
    expect(mockSyncTaskStateFromRuns).toHaveBeenNthCalledWith(2, tx, 'task-2');
    expect(
      mockResolveTaskResolutionFromLinkedPullRequests,
    ).toHaveBeenNthCalledWith(1, 'task-1', { executor: tx });
    expect(
      mockResolveTaskResolutionFromLinkedPullRequests,
    ).toHaveBeenNthCalledWith(2, 'task-2', { executor: tx });
  });

  it('reconciles on a repeated merge event after the PR status was already updated', async () => {
    mockLinkedTasks.mockResolvedValue([{ taskId: 'task-1' }]);
    mockReturning.mockResolvedValue([]);

    await updateTaskPrStatus('github', 'owner/repo', 42, 'merged');

    expect(mockSyncTaskStateFromRuns).toHaveBeenCalledWith(
      expect.any(Object),
      'task-1',
    );
    expect(
      mockResolveTaskResolutionFromLinkedPullRequests,
    ).toHaveBeenCalledWith('task-1', { executor: expect.any(Object) });
  });

  it.each(['open', 'closed'] as const)(
    're-evaluates linked PR resolution when a pull request becomes %s',
    async (status) => {
      mockLinkedTasks.mockResolvedValue([{ taskId: 'task-1' }]);
      mockReturning.mockResolvedValue([
        { taskId: 'task-1', createdByRoomote: false },
      ]);

      await updateTaskPrStatus('github', 'owner/repo', 42, status);

      expect(mockSyncTaskStateFromRuns).not.toHaveBeenCalled();
      expect(
        mockResolveTaskResolutionFromLinkedPullRequests,
      ).toHaveBeenCalledWith('task-1', {
        executor: expect.any(Object),
      });
      expect(mockReturning.mock.invocationCallOrder[0]!).toBeLessThan(
        mockResolveTaskResolutionFromLinkedPullRequests.mock
          .invocationCallOrder[0]!,
      );
    },
  );

  it('does not evaluate resolution for an unlinked pull request', async () => {
    mockReturning.mockResolvedValue([
      { taskId: 'task-1', createdByRoomote: false },
    ]);

    await updateTaskPrStatus('github', 'owner/repo', 42, 'closed');

    expect(mockSyncTaskStateFromRuns).not.toHaveBeenCalled();
    expect(
      mockResolveTaskResolutionFromLinkedPullRequests,
    ).not.toHaveBeenCalled();
  });
});
