import { CloudTaskStatus } from '@roomote/types';

const mockFindFirstCloudJob = vi.fn();
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
          findFirst: (...args: unknown[]) => mockFindFirstCloudJob(...args),
        },
      },
      update: (...args: unknown[]) => mockDbUpdate(...args),
    },
  };
});

import { updateCloudJobRuntimeState } from '../update-runtime-state';

describe('updateCloudJobRuntimeState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies newer runtime-state deadlines', async () => {
    mockFindFirstCloudJob.mockResolvedValue({
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      sleepAt: new Date('2026-03-20T06:14:38.766Z'),
    });

    const nextSleepAt = new Date('2026-03-20T06:18:08.000Z');

    await expect(
      updateCloudJobRuntimeState(85, {
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
    mockFindFirstCloudJob.mockResolvedValue({
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      sleepAt: new Date('2026-03-20T06:18:08.000Z'),
    });

    await expect(
      updateCloudJobRuntimeState(85, {
        taskPhase: 'running',
        sleepAt: new Date('2026-03-20T06:14:38.766Z'),
      }),
    ).resolves.toEqual({ updated: false });
  });

  it('applies phase transitions even when the next deadline is shorter', async () => {
    mockFindFirstCloudJob.mockResolvedValue({
      status: CloudTaskStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      sleepAt: new Date('2026-03-20T06:18:08.000Z'),
    });

    const nextSleepAt = new Date('2026-03-20T06:14:38.766Z');

    await expect(
      updateCloudJobRuntimeState(85, {
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
    mockFindFirstCloudJob.mockResolvedValue({
      status: CloudTaskStatus.Running,
      taskPhase: 'waiting_for_prompt',
      sleepAt: new Date('2026-03-20T06:18:08.000Z'),
    });

    const shutdownAt = new Date('2026-03-20T06:14:41.000Z');

    await expect(
      updateCloudJobRuntimeState(85, {
        taskPhase: 'shutting_down',
        sleepAt: shutdownAt,
      }),
    ).resolves.toEqual({ updated: true });
  });
});
