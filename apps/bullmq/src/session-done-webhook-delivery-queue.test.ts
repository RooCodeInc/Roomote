const mocks = vi.hoisted(() => ({
  queue: {
    close: vi.fn(),
    upsertJobScheduler: vi.fn(),
  },
  queueConstructor: vi.fn(),
  workerConstructor: vi.fn(),
  queueEventsConstructor: vi.fn(),
  drainSessionDoneWebhookDeliveries: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(...args: unknown[]) {
      mocks.queueConstructor(...args);
      return mocks.queue;
    }
  },
  Worker: class {
    on = vi.fn();

    constructor(...args: unknown[]) {
      mocks.workerConstructor(...args);
    }
  },
  QueueEvents: class {
    on = vi.fn();

    constructor(...args: unknown[]) {
      mocks.queueEventsConstructor(...args);
    }
  },
}));

vi.mock('@roomote/sdk/server', () => ({
  drainSessionDoneWebhookDeliveries: mocks.drainSessionDoneWebhookDeliveries,
}));

vi.mock('./redis', () => ({ getRedis: () => ({ status: 'ready' }) }));

import {
  SESSION_DONE_WEBHOOK_DELIVERY_JOB_NAME,
  SESSION_DONE_WEBHOOK_DELIVERY_QUEUE_NAME,
  startSessionDoneWebhookDeliveryQueue,
} from './session-done-webhook-delivery-queue';

describe('startSessionDoneWebhookDeliveryQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queue.close.mockResolvedValue(undefined);
    mocks.queue.upsertJobScheduler.mockResolvedValue(undefined);
    mocks.drainSessionDoneWebhookDeliveries.mockResolvedValue({
      delivered: 0,
      failed: 0,
      skipped: 0,
    });
  });

  it('isolates completion delivery in a dedicated single-concurrency worker', async () => {
    await startSessionDoneWebhookDeliveryQueue();

    expect(mocks.queue.upsertJobScheduler).toHaveBeenCalledWith(
      SESSION_DONE_WEBHOOK_DELIVERY_JOB_NAME,
      { every: 60_000 },
    );
    expect(mocks.queueConstructor).toHaveBeenCalledWith(
      SESSION_DONE_WEBHOOK_DELIVERY_QUEUE_NAME,
      expect.any(Object),
    );
    expect(mocks.workerConstructor).toHaveBeenCalledWith(
      SESSION_DONE_WEBHOOK_DELIVERY_QUEUE_NAME,
      expect.any(Function),
      expect.objectContaining({ concurrency: 1, autorun: true }),
    );

    const processor = mocks.workerConstructor.mock
      .calls[0]![1] as () => Promise<void>;
    await processor();
    expect(mocks.drainSessionDoneWebhookDeliveries).toHaveBeenCalledTimes(1);
  });

  it('fails startup instead of running without its repair schedule', async () => {
    mocks.queue.upsertJobScheduler.mockRejectedValueOnce(
      new Error('redis unavailable'),
    );

    await expect(startSessionDoneWebhookDeliveryQueue()).rejects.toThrow(
      'redis unavailable',
    );
    expect(mocks.queue.close).toHaveBeenCalledTimes(1);
    expect(mocks.workerConstructor).not.toHaveBeenCalled();
  });
});
