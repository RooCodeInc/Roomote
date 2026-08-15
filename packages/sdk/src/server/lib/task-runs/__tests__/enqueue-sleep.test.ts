import type { Mock } from 'vitest';

const {
  queueAddMock,
  queueGetJobMock,
  queueConstructorMock,
  queueEventsConstructorMock,
  waitUntilFinishedMock,
  mockGetRedis,
  mockGetBullMqRedis,
} = vi.hoisted(() => {
  type AnyMock = Mock<(...args: any[]) => any>;
  const queueAddMock = vi.fn() as AnyMock;
  const queueGetJobMock = vi.fn() as AnyMock;
  const waitUntilFinishedMock = vi.fn() as AnyMock;
  const queueConstructorMock = vi.fn(function Queue() {
    return { add: queueAddMock, getJob: queueGetJobMock };
  }) as AnyMock;

  return {
    queueAddMock,
    queueGetJobMock,
    queueConstructorMock,
    queueEventsConstructorMock: vi.fn(function QueueEvents() {
      return { kind: 'queue-events' };
    }) as AnyMock,
    waitUntilFinishedMock,
    mockGetRedis: vi.fn(() => ({ status: 'ready' })) as AnyMock,
    mockGetBullMqRedis: vi.fn(() => ({ status: 'blocking-ready' })) as AnyMock,
  };
});

vi.mock('bullmq', () => ({
  Queue: queueConstructorMock,
  QueueEvents: queueEventsConstructorMock,
}));
vi.mock('@roomote/redis', () => ({
  getRedis: mockGetRedis,
  getBullMqRedis: mockGetBullMqRedis,
}));

describe('enqueueTaskSleep', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    queueAddMock.mockResolvedValue({
      id: 'task-sleep-123',
      waitUntilFinished: waitUntilFinishedMock,
    });
    queueGetJobMock.mockResolvedValue(null);
    waitUntilFinishedMock.mockResolvedValue(undefined);
  });

  it('enqueues one immediate sleep action per task run', async () => {
    const { enqueueTaskSleep } = await import('../enqueue-sleep');

    await expect(enqueueTaskSleep({ runId: 123 })).resolves.toBe(true);

    expect(queueAddMock).toHaveBeenCalledWith(
      'sleep-task',
      { runId: 123 },
      { jobId: 'task-sleep-123' },
    );
    expect(waitUntilFinishedMock).toHaveBeenCalledWith(
      { kind: 'queue-events' },
      60_000,
    );
    expect(queueConstructorMock).toHaveBeenCalledWith(
      'task-sleep-jobs',
      expect.objectContaining({ connection: { status: 'ready' } }),
    );
    expect(queueEventsConstructorMock).toHaveBeenCalledWith('task-sleep-jobs', {
      connection: { status: 'blocking-ready' },
    });
  });

  it('deduplicates a sleep action that is still waiting', async () => {
    queueGetJobMock.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('waiting'),
      remove: vi.fn(),
      waitUntilFinished: waitUntilFinishedMock,
    });
    const { enqueueTaskSleep } = await import('../enqueue-sleep');

    await expect(enqueueTaskSleep({ runId: 123 })).resolves.toBe(false);
    expect(queueAddMock).not.toHaveBeenCalled();
    expect(waitUntilFinishedMock).toHaveBeenCalledOnce();
  });

  it('propagates an asynchronous sleep worker failure', async () => {
    waitUntilFinishedMock.mockRejectedValue(
      new Error('Docker instance is stopped'),
    );
    const { enqueueTaskSleep } = await import('../enqueue-sleep');

    await expect(enqueueTaskSleep({ runId: 123 })).rejects.toThrow(
      'Docker instance is stopped',
    );
  });
});
