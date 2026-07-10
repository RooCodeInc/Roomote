import type { Mock } from 'vitest';

const {
  queueAddMock,
  queueGetJobMock,
  queueConstructorMock,
  mockRecordCloudJobEvent,
  mockGetRedis,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyMock = Mock<(...args: any[]) => any>;

  const queueAddMock = vi.fn() as AnyMock;
  const queueGetJobMock = vi.fn() as AnyMock;

  const queueConstructorMock = vi.fn(function Queue() {
    return {
      add: queueAddMock,
      getJob: queueGetJobMock,
    };
  }) as AnyMock;

  return {
    queueAddMock,
    queueGetJobMock,
    queueConstructorMock,
    mockRecordCloudJobEvent: vi.fn() as AnyMock,
    mockGetRedis: vi.fn(() => ({ status: 'ready' })) as AnyMock,
  };
});

vi.mock('bullmq', () => ({
  Queue: queueConstructorMock,
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  recordCloudJobEvent: mockRecordCloudJobEvent,
}));

vi.mock('@roomote/redis', () => ({
  getRedis: mockGetRedis,
}));

async function loadCreateSnapshot() {
  return import('../enqueue-snapshot');
}

describe('createSnapshot', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    queueAddMock.mockResolvedValue({ id: 'snapshot-job' });
    queueGetJobMock.mockResolvedValue(null);
    mockRecordCloudJobEvent.mockResolvedValue(undefined);
  });

  it('uses snapshotIntentId as the BullMQ job id', async () => {
    const { createSnapshot } = await loadCreateSnapshot();

    await expect(
      createSnapshot({
        cloudJobId: 123,
        sandboxId: 'sbx_123',
        snapshotIntentId: 'due_sleep-123-1710000000000',
        triggerPath: 'due_sleep',
      }),
    ).resolves.toBe(true);

    expect(queueAddMock).toHaveBeenCalledWith(
      'create-snapshot',
      expect.objectContaining({
        cloudJobId: 123,
        sandboxId: 'sbx_123',
        snapshotIntentId: 'due_sleep-123-1710000000000',
        triggerPath: 'due_sleep',
      }),
      {
        jobId: 'due_sleep-123-1710000000000',
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      },
    );
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 123,
        source: 'snapshot_request',
        eventType: 'enqueued',
        details: expect.objectContaining({
          queueJobId: 'due_sleep-123-1710000000000',
          snapshotIntentId: 'due_sleep-123-1710000000000',
        }),
      }),
    );
  });

  it('configures exponential BullMQ retries for snapshot jobs', async () => {
    const { createSnapshot } = await loadCreateSnapshot();

    await expect(
      createSnapshot({
        cloudJobId: 456,
        sandboxId: 'sbx_retry',
        snapshotIntentId: 'snapshot-456',
      }),
    ).resolves.toBe(true);

    expect(queueConstructorMock).toHaveBeenCalledWith(
      'snapshot-jobs',
      expect.objectContaining({
        defaultJobOptions: expect.objectContaining({
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
        }),
      }),
    );
  });

  it('ignores a duplicate request when the same intent is still pending', async () => {
    const getState = vi.fn().mockResolvedValue('waiting');
    const remove = vi.fn().mockResolvedValue(undefined);

    queueGetJobMock.mockResolvedValue({ getState, remove });

    const { createSnapshot } = await loadCreateSnapshot();

    await expect(
      createSnapshot({
        cloudJobId: 123,
        sandboxId: 'sbx_123',
        snapshotIntentId: 'due_sleep-123-1710000000000',
        triggerPath: 'due_sleep',
      }),
    ).resolves.toBe(false);

    expect(queueAddMock).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'decision',
        details: expect.objectContaining({
          decision: 'duplicate_ignored',
          existingState: 'waiting',
          queueJobId: 'due_sleep-123-1710000000000',
        }),
      }),
    );
  });

  it('removes a retained terminal job before reusing the same intent id', async () => {
    const getState = vi.fn().mockResolvedValue('failed');
    const remove = vi.fn().mockResolvedValue(undefined);

    queueGetJobMock.mockResolvedValue({ getState, remove });

    const { createSnapshot } = await loadCreateSnapshot();

    await expect(
      createSnapshot({
        cloudJobId: 123,
        sandboxId: 'sbx_123',
        snapshotIntentId: 'snapshot-123',
      }),
    ).resolves.toBe(true);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(queueAddMock).toHaveBeenCalledWith(
      'create-snapshot',
      expect.objectContaining({
        cloudJobId: 123,
        sandboxId: 'sbx_123',
        snapshotIntentId: 'snapshot-123',
      }),
      {
        jobId: 'snapshot-123',
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      },
    );
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'decision',
        details: expect.objectContaining({
          decision: 'previous_job_removed',
          existingState: 'failed',
          queueJobId: 'snapshot-123',
        }),
      }),
    );
  });
});
