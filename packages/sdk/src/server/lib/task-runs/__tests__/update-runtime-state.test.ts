import { RunStatus } from '@roomote/types';

const {
  mockFindFirstTaskRun,
  mockClearTaskResolution,
  mockOpenTaskResolutionOnCloseout,
  mockDbUpdateSet,
  mockTransaction,
} = vi.hoisted(() => {
  const mockFindFirstTaskRun = vi.fn();
  const mockClearTaskResolution = vi.fn().mockResolvedValue(false);
  const mockOpenTaskResolutionOnCloseout = vi.fn().mockResolvedValue(false);
  const mockDbUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockDbUpdateSet = vi.fn().mockReturnValue({
    where: (...args: unknown[]) => mockDbUpdateWhere(...args),
  });
  const mockDbUpdate = vi.fn().mockReturnValue({
    set: (...args: unknown[]) => mockDbUpdateSet(...args),
  });
  const mockTransaction = vi.fn(
    async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        query: {
          taskRuns: {
            findFirst: (...args: unknown[]) => mockFindFirstTaskRun(...args),
          },
        },
        update: (...args: unknown[]) => mockDbUpdate(...args),
      }),
  );

  return {
    mockFindFirstTaskRun,
    mockClearTaskResolution,
    mockOpenTaskResolutionOnCloseout,
    mockDbUpdateSet,
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
    clearTaskResolution: (...args: unknown[]) =>
      mockClearTaskResolution(...args),
    openTaskResolutionOnCloseout: (...args: unknown[]) =>
      mockOpenTaskResolutionOnCloseout(...args),
    db: {
      transaction: mockTransaction,
    },
  };
});

import { updateTaskRunRuntimeState } from '../update-runtime-state';

describe('updateTaskRunRuntimeState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies newer runtime-state deadlines', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      taskId: 'task-85',
      status: RunStatus.Running,
      taskPhase: 'running',
      sleepAt: new Date('2026-03-20T06:14:38.766Z'),
    });

    const nextSleepAt = new Date('2026-03-20T06:18:08.000Z');

    await expect(
      updateTaskRunRuntimeState(85, {
        taskPhase: 'waiting_for_prompt',
        sleepAt: nextSleepAt,
      }),
    ).resolves.toEqual({ updated: true });

    expect(mockDbUpdateSet).toHaveBeenCalledWith({
      taskPhase: 'waiting_for_prompt',
      sleepAt: nextSleepAt,
    });
    expect(mockOpenTaskResolutionOnCloseout).toHaveBeenCalledWith('task-85', {
      executor: expect.any(Object),
    });
    expect(mockClearTaskResolution).not.toHaveBeenCalled();
  });

  it('returns updated false when an older runtime-state write is ignored', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      taskId: 'task-85',
      status: RunStatus.Running,
      taskPhase: 'running',
      sleepAt: new Date('2026-03-20T06:18:08.000Z'),
    });

    await expect(
      updateTaskRunRuntimeState(85, {
        taskPhase: 'running',
        sleepAt: new Date('2026-03-20T06:14:38.766Z'),
      }),
    ).resolves.toEqual({ updated: false });
  });

  it('applies phase transitions even when the next deadline is shorter', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      taskId: 'task-85',
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      sleepAt: new Date('2026-03-20T06:18:08.000Z'),
    });

    const nextSleepAt = new Date('2026-03-20T06:14:38.766Z');

    await expect(
      updateTaskRunRuntimeState(85, {
        taskPhase: 'running',
        sleepAt: nextSleepAt,
      }),
    ).resolves.toEqual({ updated: true });

    expect(mockDbUpdateSet).toHaveBeenCalledWith({
      taskPhase: 'running',
      sleepAt: nextSleepAt,
    });
    expect(mockClearTaskResolution).toHaveBeenCalledWith('task-85', {
      executor: expect.any(Object),
    });
    expect(mockOpenTaskResolutionOnCloseout).not.toHaveBeenCalled();
  });

  it('still applies immediate shutdown transitions even though they shorten the deadline', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      taskId: 'task-85',
      status: RunStatus.Running,
      taskPhase: 'waiting_for_prompt',
      sleepAt: new Date('2026-03-20T06:18:08.000Z'),
    });

    const shutdownAt = new Date('2026-03-20T06:14:41.000Z');

    await expect(
      updateTaskRunRuntimeState(85, {
        taskPhase: 'shutting_down',
        sleepAt: shutdownAt,
      }),
    ).resolves.toEqual({ updated: true });
  });

  it('does not reopen resolution for a waiting-for-prompt keepalive', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      taskId: 'task-85',
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      sleepAt: new Date('2026-03-20T06:14:38.766Z'),
    });

    await expect(
      updateTaskRunRuntimeState(85, {
        taskPhase: 'waiting_for_prompt',
        sleepAt: new Date('2026-03-20T06:18:08.000Z'),
      }),
    ).resolves.toEqual({ updated: true });

    expect(mockOpenTaskResolutionOnCloseout).not.toHaveBeenCalled();
    expect(mockClearTaskResolution).not.toHaveBeenCalled();
  });

  it.each([RunStatus.Failed, RunStatus.Canceled])(
    'does not open resolution for a %s run outcome',
    async (status) => {
      mockFindFirstTaskRun.mockResolvedValue({
        taskId: 'task-85',
        status,
        taskPhase: 'running',
        sleepAt: null,
      });

      await expect(
        updateTaskRunRuntimeState(85, {
          taskPhase: 'waiting_for_prompt',
          sleepAt: new Date('2026-03-20T06:18:08.000Z'),
        }),
      ).resolves.toEqual({ updated: true });

      expect(mockOpenTaskResolutionOnCloseout).not.toHaveBeenCalled();
    },
  );
});
