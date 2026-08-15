const mocks = vi.hoisted(() => ({
  queue: {
    add: vi.fn(),
    close: vi.fn(),
    getJobSchedulers: vi.fn(),
    removeJobScheduler: vi.fn(),
    upsertJobScheduler: vi.fn(),
  },
  workerConstructor: vi.fn(),
  queueEventsConstructor: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Job: class {},
  Queue: class {
    constructor() {
      return mocks.queue;
    }
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();

    constructor(...args: unknown[]) {
      mocks.workerConstructor(...args);
    }
  },
  QueueEvents: class {
    on = vi.fn();
    close = vi.fn();

    constructor(...args: unknown[]) {
      mocks.queueEventsConstructor(...args);
    }
  },
}));

vi.mock('@roomote/sdk/server', () => ({
  announcerJob: vi.fn(),
  codeQualityAuditorJob: vi.fn(),
  codeqlTriageJob: vi.fn(),
  conflictScanJob: vi.fn(),
  customAutomationsJob: vi.fn(),
  dependabotTriageJob: vi.fn(),
  managerStatsJob: vi.fn(),
  securityAuditorJob: vi.fn(),
  sentryTriageJob: vi.fn(),
  suggesterJob: vi.fn(),
}));

vi.mock('./redis', () => ({ getRedis: () => ({}) }));

vi.mock('./scheduled-jobs', () => ({
  heartbeatJob: vi.fn(),
  sleepCheckJob: vi.fn(),
  refreshSnapshotsJob: vi.fn(),
  pullRequestAnalyticsSyncJob: vi.fn(),
  instancePingJob: vi.fn(),
  licenseUsageSyncJob: vi.fn(),
  webhookCleanupJob: vi.fn(),
  standbyRetentionJob: vi.fn(),
  prReviewNotificationDispatchJob: vi.fn(),
  brainOutboxDrainJob: vi.fn(),
  brainCollectorsJob: vi.fn(),
  brainMaintenanceJob: vi.fn(),
}));

import { ScheduledJobName } from './types';
import { startScheduler } from './scheduler';

describe('startScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queue.removeJobScheduler.mockResolvedValue(undefined);
    mocks.queue.upsertJobScheduler.mockResolvedValue(undefined);
    mocks.queue.add.mockResolvedValue(undefined);
    mocks.queue.getJobSchedulers.mockResolvedValue([]);
    mocks.queue.close.mockResolvedValue(undefined);
  });

  it('rejects startup instead of running without durable schedules', async () => {
    mocks.queue.upsertJobScheduler.mockRejectedValueOnce(
      new Error('redis unavailable'),
    );

    await expect(startScheduler()).rejects.toThrow('redis unavailable');

    expect(mocks.queue.close).toHaveBeenCalledTimes(1);
    expect(mocks.workerConstructor).not.toHaveBeenCalled();
    expect(mocks.queueEventsConstructor).not.toHaveBeenCalled();
  });

  it('installs the PR review dispatcher before starting the worker', async () => {
    await startScheduler();

    expect(mocks.queue.upsertJobScheduler).toHaveBeenCalledWith(
      ScheduledJobName.PrReviewNotificationDispatch,
      { every: 10 * 1000 },
    );
    expect(mocks.workerConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.queueEventsConstructor).toHaveBeenCalledTimes(1);
    expect(
      mocks.queue.upsertJobScheduler.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(mocks.workerConstructor.mock.invocationCallOrder[0]!);
  });

  it('schedules Brain maintenance nightly', async () => {
    await startScheduler();

    expect(mocks.queue.upsertJobScheduler).toHaveBeenCalledWith(
      ScheduledJobName.BrainMaintenance,
      { pattern: '0 7 * * *' },
    );
  });
});
