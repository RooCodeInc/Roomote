import type { Queue } from 'bullmq';

import { removeSchedulersWithStaleOffsets } from './job-scheduler-repair';

type SchedulerQueue = Pick<Queue, 'getJobSchedulers' | 'removeJobScheduler'>;

function fakeQueue(
  schedulers: Array<{ key: string; every?: number; offset?: number }>,
) {
  // Mirrors bullmq: schedulers are read by rank and removal shifts later ones.
  const backing = [...schedulers];
  const removeJobScheduler = vi.fn(async (key: string) => {
    const index = backing.findIndex((s) => s.key === key);
    if (index >= 0) backing.splice(index, 1);
    return index >= 0;
  });
  const getJobSchedulers = vi.fn(async (start = 0, end = -1) =>
    backing.slice(start, end + 1).map((s) => ({ name: s.key, ...s })),
  );

  return {
    queue: {
      getJobSchedulers,
      removeJobScheduler,
    } as unknown as SchedulerQueue,
    removeJobScheduler,
    backing,
  };
}

describe('removeSchedulersWithStaleOffsets', () => {
  it('removes every scheduler whose offset reaches its interval', async () => {
    const { queue, removeJobScheduler } = fakeQueue([
      { key: 'Heartbeat', every: 60_000, offset: 3_432_642 },
      { key: 'custom_automations', every: 60_000, offset: 60_000 },
      { key: 'SleepCheck', every: 60_000, offset: 12_643 },
      { key: 'RefreshSnapshots', every: 86_400_000, offset: 3_432_642 },
      { key: 'cron-job' },
    ]);

    await expect(removeSchedulersWithStaleOffsets(queue)).resolves.toEqual([
      'Heartbeat',
      'custom_automations',
    ]);
    expect(removeJobScheduler).toHaveBeenCalledTimes(2);
  });

  it('removes stale schedulers on every page even as removals shift ranks', async () => {
    const schedulers = Array.from({ length: 150 }, (_, index) => ({
      key: `job-${index}`,
      every: 60_000,
      offset: 120_000,
    }));
    const { queue, backing } = fakeQueue(schedulers);

    await expect(removeSchedulersWithStaleOffsets(queue)).resolves.toHaveLength(
      150,
    );
    expect(backing).toHaveLength(0);
  });

  it('pages through every scheduler', async () => {
    const schedulers = Array.from({ length: 150 }, (_, index) => ({
      key: `job-${index}`,
      every: 60_000,
      offset: index === 120 ? 120_000 : 10,
    }));
    const { queue } = fakeQueue(schedulers);

    await expect(removeSchedulersWithStaleOffsets(queue)).resolves.toEqual([
      'job-120',
    ]);
  });
});
