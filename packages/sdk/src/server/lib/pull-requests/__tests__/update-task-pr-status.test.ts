const {
  mockLinkedTasks,
  mockDbSelect,
  mockEnqueueTaskSleep,
  mockReturning,
  mockSyncTaskStateFromRuns,
  mockTransaction,
} = vi.hoisted(() => {
  const mockLinkedTasks = vi.fn();
  const mockDbSelect = vi.fn();
  const mockEnqueueTaskSleep = vi.fn();
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
    mockDbSelect,
    mockEnqueueTaskSleep,
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
    db: { transaction: mockTransaction, select: mockDbSelect },
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sleeps the originating idle task when it has been inactive for five minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
    const activityAt = Math.floor(Date.now() / 1_000) - 5 * 60;
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

    await updateTaskPrStatus('github', 'owner/repo', 42, 'merged');

    expect(mockEnqueueTaskSleep).toHaveBeenCalledWith({
      runId: 123,
      triggerPath: 'merged_pr',
    });
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
