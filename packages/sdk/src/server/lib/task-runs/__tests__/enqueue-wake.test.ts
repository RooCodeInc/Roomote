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

describe('enqueueTaskWake', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('replaces a completed wake job during recovery', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    queueGetJobMock.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('completed'),
      remove,
    });
    const { enqueueTaskWake } = await import('../enqueue-wake');
    const request = {
      runId: 42,
      waitUntil: '2026-08-13T16:00:00.000Z',
    };

    await enqueueTaskWake(request);

    expect(remove).toHaveBeenCalledOnce();
    expect(queueAddMock).toHaveBeenCalledWith('wake-task', request, {
      jobId: 'task-wake-42',
      delay: 0,
    });
  });
});
