const mocks = vi.hoisted(() => ({
  upsertJobScheduler: vi.fn(),
  queueEventsOn: vi.fn(),
  workerOn: vi.fn(),
  processor: undefined as ((job: unknown) => Promise<void>) | undefined,
  recover: vi.fn(),
  drain: vi.fn(),
  BusyError: class FastAgentParentBusyError extends Error {},
  DelayedError: class DelayedError extends Error {},
}));

vi.mock('bullmq', () => ({
  DelayedError: mocks.DelayedError,
  Queue: class Queue {
    upsertJobScheduler = mocks.upsertJobScheduler;
  },
  Worker: class Worker {
    on = mocks.workerOn;
    constructor(_name: string, processor: (job: unknown) => Promise<void>) {
      mocks.processor = processor;
    }
  },
  QueueEvents: class QueueEvents {
    on = mocks.queueEventsOn;
  },
}));

vi.mock('@roomote/sdk/server', () => ({
  FAST_AGENT_PARENT_EVENT_QUEUE_NAME: 'fast-agent-parent-events',
  recoverPendingFastAgentParentEvents: mocks.recover,
  drainFastAgentParentEvents: mocks.drain,
  FastAgentParentBusyError: mocks.BusyError,
}));

vi.mock('./redis', () => ({ getRedis: vi.fn(() => ({})) }));

import { startFastAgentParentEventQueue } from './fast-agent-parent-event-queue';

describe('startFastAgentParentEventQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processor = undefined;
    mocks.upsertJobScheduler.mockResolvedValue(undefined);
    mocks.recover.mockResolvedValue(0);
    mocks.drain.mockResolvedValue(undefined);
  });

  it('recovers persisted rows and drains ordinary wakeups', async () => {
    await startFastAgentParentEventQueue();

    expect(mocks.upsertJobScheduler).toHaveBeenCalledWith(
      'fast-agent-parent-event-recovery',
      { every: 60_000 },
      { name: 'recover-pending', data: { recovery: true } },
    );
    expect(mocks.recover).toHaveBeenCalledOnce();

    const request = { conversationId: 'conversation-1', eventKey: 'event-1' };
    await mocks.processor?.({ name: 'deliver', data: request });
    expect(mocks.drain).toHaveBeenCalledWith(request);
  });

  it('runs the periodic recovery sweep without invoking a parent drain', async () => {
    await startFastAgentParentEventQueue();
    mocks.recover.mockClear();

    await mocks.processor?.({
      name: 'recover-pending',
      data: { recovery: true },
    });
    expect(mocks.recover).toHaveBeenCalledOnce();
    expect(mocks.drain).not.toHaveBeenCalled();
  });

  it('delays a busy parent without consuming a worker attempt', async () => {
    await startFastAgentParentEventQueue();
    mocks.drain.mockRejectedValueOnce(new mocks.BusyError());
    const moveToDelayed = vi.fn().mockResolvedValue(undefined);

    await expect(
      mocks.processor?.({
        name: 'deliver',
        data: { conversationId: 'conversation-1', eventKey: 'event-1' },
        token: 'worker-token',
        moveToDelayed,
      }),
    ).rejects.toBeInstanceOf(mocks.DelayedError);
    expect(moveToDelayed).toHaveBeenCalledWith(
      expect.any(Number),
      'worker-token',
    );
  });
});
