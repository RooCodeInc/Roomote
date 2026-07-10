import { RunStatus } from '@roomote/types';

const mockFindFirstTaskRun = vi.fn();
const mockDbUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockDbUpdateSet = vi.fn().mockReturnValue({
  where: (...args: unknown[]) => mockDbUpdateWhere(...args),
});
const mockDbUpdate = vi.fn().mockReturnValue({
  set: (...args: unknown[]) => mockDbUpdateSet(...args),
});

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );

  return {
    ...actual,
    db: {
      query: {
        taskRuns: {
          findFirst: (...args: unknown[]) => mockFindFirstTaskRun(...args),
        },
      },
      update: (...args: unknown[]) => mockDbUpdate(...args),
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
  });

  it('returns updated false when an older runtime-state write is ignored', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
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
  });

  it('still applies immediate shutdown transitions even though they shorten the deadline', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
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
});
