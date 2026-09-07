const mockQueueAdd = vi.fn();

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({}),
}));

vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    add = (...args: unknown[]) => mockQueueAdd(...args);
  },
}));

import {
  requestBrainBackfill,
  requestInstancePing,
  resetInstancePingQueueForTests,
} from '../request-instance-ping';

describe('requestInstancePing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T21:30:30.000Z'));
    resetInstancePingQueueForTests();
    mockQueueAdd.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enqueues an InstancePing job with a per-minute debounce id', async () => {
    await requestInstancePing('setup-completed');

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'InstancePing',
      { reason: 'setup-completed' },
      { jobId: `instance-ping-request-${Math.floor(Date.now() / 60_000)}` },
    );
  });

  it('collapses bursts within the same minute onto one job id', async () => {
    await requestInstancePing('user-admitted');
    vi.advanceTimersByTime(10_000);
    await requestInstancePing('user-removed');

    const [first, second] = mockQueueAdd.mock.calls;
    expect(first?.[2]).toEqual(second?.[2]);

    vi.advanceTimersByTime(60_000);
    await requestInstancePing('user-admitted');
    expect(mockQueueAdd.mock.calls[2]?.[2]).not.toEqual(first?.[2]);
  });

  it('swallows enqueue failures so telemetry never breaks the caller', async () => {
    mockQueueAdd.mockRejectedValueOnce(new Error('redis down'));

    await expect(requestInstancePing('user-admitted')).resolves.toBeUndefined();
  });
});

describe('requestBrainBackfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T21:30:30.000Z'));
    resetInstancePingQueueForTests();
    mockQueueAdd.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('kicks every ingestion job with per-minute debounce ids', async () => {
    await requestBrainBackfill('memory-enabled');

    const minuteBucket = Math.floor(Date.now() / 60_000);
    const jobs = mockQueueAdd.mock.calls.map((call) => call[0]);
    expect(jobs.sort()).toEqual([
      'BrainCollectors',
      'BrainOutboxDrain',
      'PullRequestAnalyticsSync',
    ]);
    for (const [jobName, data, opts] of mockQueueAdd.mock.calls) {
      expect(data).toEqual(
        jobName === 'PullRequestAnalyticsSync'
          ? { reason: 'memory-enabled', chainBrainCollectors: true }
          : { reason: 'memory-enabled' },
      );
      expect(opts).toEqual({
        jobId: `brain-backfill-request-${jobName}-${minuteBucket}`,
      });
    }
  });

  it('swallows enqueue failures so the Settings mutation never breaks', async () => {
    mockQueueAdd.mockRejectedValue(new Error('redis down'));

    await expect(
      requestBrainBackfill('memory-enabled'),
    ).resolves.toBeUndefined();
  });
});
