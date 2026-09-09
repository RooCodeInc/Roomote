const {
  mockLinkedTasks,
  mockDbSelect,
  mockEnqueueTaskSleep,
  mockReturning,
  mockRequeueBrainMemoryEventsForTasks,
  mockSyncTaskStateFromRuns,
  mockTransaction,
} = vi.hoisted(() => {
  const mockLinkedTasks = vi.fn();
  const mockDbSelect = vi.fn();
  const mockEnqueueTaskSleep = vi.fn();
  const mockReturning = vi.fn();
  const mockRequeueBrainMemoryEventsForTasks = vi.fn();
  const mockSyncTaskStateFromRuns = vi.fn();
  const mockTransaction = vi.fn(async (callback: (tx: unknown) => unknown) =>
    callback({
      query: {
        taskPullRequests: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              { id: 'association', host: 'github.com', repositoryId: null },
            ]),
        },
      },
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
    mockDbSelect,
    mockEnqueueTaskSleep,
    mockReturning,
    mockRequeueBrainMemoryEventsForTasks,
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
    db: { transaction: mockTransaction, select: mockDbSelect },
    requeueBrainMemoryEventsForTasks: (...args: unknown[]) =>
      mockRequeueBrainMemoryEventsForTasks(...args),
    syncTaskStateFromRuns: (...args: unknown[]) =>
      mockSyncTaskStateFromRuns(...args),
  };
});

vi.mock('../../task-runs/enqueue-sleep', () => ({
  enqueueTaskSleep: (...args: unknown[]) => mockEnqueueTaskSleep(...args),
}));

vi.mock('@roomote/telemetry/server', () => ({
  captureActivationPrMerged: vi.fn(),
}));

import { RunStatus } from '@roomote/types';

import {
  selectMergedPrTaskRunToSleep,
  updateTaskPrStatus,
} from '../update-task-pr-status';

describe('updateTaskPrStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLinkedTasks.mockResolvedValue([]);
    mockReturning.mockResolvedValue([]);
    mockSyncTaskStateFromRuns.mockResolvedValue(undefined);
    mockEnqueueTaskSleep.mockResolvedValue(true);
    mockRequeueBrainMemoryEventsForTasks.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sleeps the originating idle task when it has been inactive for five minutes', async () => {
    const activityAt = 0;
    mockLinkedTasks.mockResolvedValue([
      { taskId: 'task-1', createdByRoomote: true },
    ]);
    mockDbSelect
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ state: 'active', activityAt }]),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => Promise.resolve([{ id: 123, status: RunStatus.Idle }]),
        }),
      });

    await updateTaskPrStatus('github', 'owner/repo', 42, 'merged', {
      host: 'github.com',
    });

    await vi.waitFor(() => {
      expect(mockEnqueueTaskSleep).toHaveBeenCalledWith({
        runId: 123,
        triggerPath: 'merged_pr',
        expectedTaskActivityAt: activityAt,
      });
    });
  });

  it('does not wait for merged-PR sleep completion before returning', async () => {
    mockLinkedTasks.mockResolvedValue([
      { taskId: 'task-1', createdByRoomote: true },
    ]);
    mockDbSelect
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ state: 'active', activityAt: 0 }]),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => Promise.resolve([{ id: 123, status: RunStatus.Idle }]),
        }),
      });
    mockEnqueueTaskSleep.mockReturnValue(new Promise(() => {}));

    await expect(
      updateTaskPrStatus('github', 'owner/repo', 42, 'merged', {
        host: 'github.com',
      }),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(mockEnqueueTaskSleep).toHaveBeenCalled();
    });
  });

  it('handles a background sleep enqueue failure without failing the webhook', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockLinkedTasks.mockResolvedValue([
      { taskId: 'task-1', createdByRoomote: true },
    ]);
    mockDbSelect
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ state: 'active', activityAt: 0 }]),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => Promise.resolve([{ id: 123, status: RunStatus.Idle }]),
        }),
      });
    mockEnqueueTaskSleep.mockRejectedValue(new Error('queue unavailable'));

    await expect(
      updateTaskPrStatus('gitlab', 'owner/repo', 42, 'merged', {
        host: 'github.com',
      }),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to enqueue merged-PR sleep'),
        expect.any(Error),
      );
    });
    errorSpy.mockRestore();
  });

  it('reconciles each linked task state once when a pull request is merged', async () => {
    mockLinkedTasks.mockResolvedValue([
      { taskId: 'task-2' },
      { taskId: 'task-1' },
      { taskId: 'task-1' },
    ]);

    await updateTaskPrStatus('github', 'owner/repo', 42, 'merged', {
      host: 'github.com',
    });

    const tx = expect.any(Object);
    expect(mockSyncTaskStateFromRuns).toHaveBeenCalledTimes(2);
    expect(mockSyncTaskStateFromRuns).toHaveBeenNthCalledWith(1, tx, 'task-1');
    expect(mockSyncTaskStateFromRuns).toHaveBeenNthCalledWith(2, tx, 'task-2');
  });

  it('reconciles on a repeated merge event after the PR status was already updated', async () => {
    mockLinkedTasks.mockResolvedValue([{ taskId: 'task-1' }]);
    mockReturning.mockResolvedValue([]);

    await updateTaskPrStatus('github', 'owner/repo', 42, 'merged', {
      host: 'github.com',
    });

    expect(mockSyncTaskStateFromRuns).toHaveBeenCalledWith(
      expect.any(Object),
      'task-1',
    );
  });

  it('does not reconcile task state when a pull request is closed unmerged', async () => {
    mockReturning.mockResolvedValue([
      { taskId: 'task-1', createdByRoomote: false },
    ]);

    await updateTaskPrStatus('github', 'owner/repo', 42, 'closed', {
      host: 'github.com',
    });

    expect(mockSyncTaskStateFromRuns).not.toHaveBeenCalled();
    expect(mockLinkedTasks).not.toHaveBeenCalled();
  });
  it('re-ingests the memories of every task whose PR just merged', async () => {
    mockReturning.mockResolvedValue([
      { taskId: 'task-2', createdByRoomote: false },
      { taskId: 'task-1', createdByRoomote: true },
      { taskId: 'task-1', createdByRoomote: false },
    ]);
    // The originating-task workflow lookup that follows a merge.
    mockDbSelect.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([]) }),
    });

    await updateTaskPrStatus('github', 'owner/repo', 42, 'merged', {
      host: 'github.com',
    });

    expect(mockRequeueBrainMemoryEventsForTasks).toHaveBeenCalledTimes(1);
    expect(mockRequeueBrainMemoryEventsForTasks).toHaveBeenCalledWith(
      expect.any(Object),
      ['task-1', 'task-2'],
    );
  });

  it('re-ingests memories when a PR closes unmerged', async () => {
    mockReturning.mockResolvedValue([
      { taskId: 'task-1', createdByRoomote: false },
    ]);

    await updateTaskPrStatus('github', 'owner/repo', 42, 'closed', {
      host: 'github.com',
    });

    expect(mockRequeueBrainMemoryEventsForTasks).toHaveBeenCalledWith(
      expect.any(Object),
      ['task-1'],
    );
  });

  it('does not re-ingest when nothing transitioned or the PR is still open', async () => {
    mockReturning.mockResolvedValue([]);
    await updateTaskPrStatus('github', 'owner/repo', 42, 'closed', {
      host: 'github.com',
    });

    mockReturning.mockResolvedValue([
      { taskId: 'task-1', createdByRoomote: false },
    ]);
    await updateTaskPrStatus('github', 'owner/repo', 42, 'open', {
      host: 'github.com',
    });

    expect(mockRequeueBrainMemoryEventsForTasks).not.toHaveBeenCalled();
  });

  it('keeps the webhook healthy when the memory requeue fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockReturning.mockResolvedValue([
      { taskId: 'task-1', createdByRoomote: false },
    ]);
    mockRequeueBrainMemoryEventsForTasks.mockRejectedValue(
      new Error('brain db down'),
    );

    await expect(
      updateTaskPrStatus('github', 'owner/repo', 42, 'closed', {
        host: 'github.com',
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to requeue memories'),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});

describe('selectMergedPrTaskRunToSleep', () => {
  const nowSeconds = 1_000;

  it('includes the exact five-minute inactivity threshold', () => {
    expect(
      selectMergedPrTaskRunToSleep(
        {
          state: 'active',
          activityAt: 700,
          activeRuns: [{ id: 1, status: RunStatus.Idle }],
        },
        nowSeconds,
      ),
    ).toBe(1);
  });

  it('preserves recently active tasks', () => {
    expect(
      selectMergedPrTaskRunToSleep(
        {
          state: 'active',
          activityAt: 701,
          activeRuns: [{ id: 1, status: RunStatus.Idle }],
        },
        nowSeconds,
      ),
    ).toBeNull();
  });

  it('preserves tasks that are no longer active', () => {
    expect(
      selectMergedPrTaskRunToSleep(
        {
          state: 'completed',
          activityAt: 700,
          activeRuns: [{ id: 1, status: RunStatus.Idle }],
        },
        nowSeconds,
      ),
    ).toBeNull();
  });

  it('preserves a task with running work', () => {
    expect(
      selectMergedPrTaskRunToSleep(
        {
          state: 'active',
          activityAt: 700,
          activeRuns: [{ id: 1, status: RunStatus.Running }],
        },
        nowSeconds,
      ),
    ).toBeNull();
  });

  it('preserves an idle task with another active sibling run', () => {
    expect(
      selectMergedPrTaskRunToSleep(
        {
          state: 'active',
          activityAt: 700,
          activeRuns: [
            { id: 1, status: RunStatus.Idle },
            { id: 2, status: RunStatus.Running },
          ],
        },
        nowSeconds,
      ),
    ).toBeNull();
  });
});
