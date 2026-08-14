const { findTaskWaitsNeedingWake, enqueueTaskWake } = vi.hoisted(() => ({
  findTaskWaitsNeedingWake: vi.fn(),
  enqueueTaskWake: vi.fn(),
}));

vi.mock('@roomote/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/db/server')>();
  return {
    ...actual,
    findTaskWaitsNeedingWake,
  };
});
vi.mock('@roomote/sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/sdk/server')>()),
  enqueueTaskWake,
}));

import { taskWakeRecoveryJob } from './task-wake-recovery';

describe('task wake recovery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('re-enqueues every due recoverable wait', async () => {
    findTaskWaitsNeedingWake.mockResolvedValue([
      { id: 41, waitUntil: new Date('2026-08-13T15:30:00.000Z') },
      { id: 42, waitUntil: new Date('2026-08-13T16:00:00.000Z') },
    ]);

    await taskWakeRecoveryJob();

    expect(findTaskWaitsNeedingWake).toHaveBeenCalledWith({ limit: 500 });
    expect(enqueueTaskWake).toHaveBeenNthCalledWith(1, {
      runId: 41,
      waitUntil: '2026-08-13T15:30:00.000Z',
    });
    expect(enqueueTaskWake).toHaveBeenNthCalledWith(2, {
      runId: 42,
      waitUntil: '2026-08-13T16:00:00.000Z',
    });
  });
});
