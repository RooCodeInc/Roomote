import type { Mock } from 'vitest';

const { queueAddMock, queueGetJobMock, queueConstructorMock, mockGetRedis } =
  vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type AnyMock = Mock<(...args: any[]) => any>;
    const queueAddMock = vi.fn() as AnyMock;
    const queueGetJobMock = vi.fn() as AnyMock;
    const queueConstructorMock = vi.fn(function Queue() {
      return { add: queueAddMock, getJob: queueGetJobMock };
    }) as AnyMock;

    return {
      queueAddMock,
      queueGetJobMock,
      queueConstructorMock,
      mockGetRedis: vi.fn(() => ({ status: 'ready' })) as AnyMock,
    };
  });

vi.mock('bullmq', () => ({ Queue: queueConstructorMock }));
vi.mock('@roomote/redis', () => ({ getRedis: mockGetRedis }));

describe('enqueueTaskSleep', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    queueAddMock.mockResolvedValue({ id: 'task-sleep-123' });
    queueGetJobMock.mockResolvedValue(null);
  });

  it('enqueues one immediate sleep action per task run', async () => {
    const { enqueueTaskSleep } = await import('../enqueue-sleep');

    await expect(enqueueTaskSleep({ runId: 123 })).resolves.toBe(true);

    expect(queueAddMock).toHaveBeenCalledWith(
      'sleep-task',
      { runId: 123 },
      { jobId: 'task-sleep-123' },
    );
  });

  it('deduplicates a sleep action that is still waiting', async () => {
    queueGetJobMock.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('waiting'),
      remove: vi.fn(),
    });
    const { enqueueTaskSleep } = await import('../enqueue-sleep');

    await expect(enqueueTaskSleep({ runId: 123 })).resolves.toBe(false);
    expect(queueAddMock).not.toHaveBeenCalled();
  });
});
