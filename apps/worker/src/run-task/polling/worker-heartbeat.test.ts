import { WORKER_HEARTBEAT_INTERVAL_MS } from '@roomote/types';

const { mockTouchWorkerHeartbeat } = vi.hoisted(() => ({
  mockTouchWorkerHeartbeat: vi.fn(),
}));

const { captureWorkerMessageMock } = vi.hoisted(() => ({
  captureWorkerMessageMock: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    cloudJobs: {
      touchCloudJobHeartbeat: mockTouchWorkerHeartbeat,
    },
  },
}));

vi.mock('../../monitoring/sentry', () => ({
  captureWorkerMessage: captureWorkerMessageMock,
}));

import {
  createWorkerHeartbeatInterval,
  WORKER_HEARTBEAT_RPC_TIMEOUT_MS,
} from './worker-heartbeat';

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void;
  let reject: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    reject: reject!,
    resolve: resolve!,
  };
}

describe('createWorkerHeartbeatInterval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockTouchWorkerHeartbeat.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('touches worker heartbeat immediately and on each interval', async () => {
    const interval = createWorkerHeartbeatInterval({
      cloudJobId: 42,
      logger: {
        warn: vi.fn(),
      } as never,
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mockTouchWorkerHeartbeat).toHaveBeenCalledTimes(1);
      expect(mockTouchWorkerHeartbeat).toHaveBeenCalledWith(
        { id: 42 },
        {
          signal: expect.any(AbortSignal),
        },
      );

      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
      expect(mockTouchWorkerHeartbeat).toHaveBeenCalledTimes(2);
    } finally {
      clearInterval(interval);
    }
  });

  it('logs and keeps running when a heartbeat update fails', async () => {
    const warn = vi.fn();
    mockTouchWorkerHeartbeat.mockRejectedValueOnce(new Error('network blip'));
    mockTouchWorkerHeartbeat.mockResolvedValue(undefined);

    const interval = createWorkerHeartbeatInterval({
      cloudJobId: 84,
      logger: { warn } as never,
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(warn).toHaveBeenCalledWith(
        '[workerHeartbeat] Failed to update heartbeat for cloud job 84: network blip',
      );

      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
      expect(mockTouchWorkerHeartbeat).toHaveBeenLastCalledWith(
        { id: 84 },
        {
          signal: expect.any(AbortSignal),
        },
      );
    } finally {
      clearInterval(interval);
    }
  });

  it('reports a failing heartbeat streak to Sentry once after the threshold', async () => {
    const warn = vi.fn();
    mockTouchWorkerHeartbeat.mockRejectedValue(new Error('db timeout'));

    const interval = createWorkerHeartbeatInterval({
      cloudJobId: 108,
      taskId: 'task-108',
      logger: { warn } as never,
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);

      expect(captureWorkerMessageMock).toHaveBeenCalledWith(
        'Worker heartbeat updates are repeatedly failing',
        expect.objectContaining({
          cloudJobId: 108,
          taskId: 'task-108',
          consecutiveFailureCount: 3,
        }),
        expect.objectContaining({
          component: 'worker-heartbeat',
          signal: 'worker-heartbeat-failures',
        }),
      );
      expect(captureWorkerMessageMock).toHaveBeenCalledTimes(1);
    } finally {
      clearInterval(interval);
    }
  });

  it('reports a new heartbeat failure streak after a successful heartbeat reset', async () => {
    const warn = vi.fn();
    mockTouchWorkerHeartbeat
      .mockRejectedValueOnce(new Error('db timeout'))
      .mockRejectedValueOnce(new Error('db timeout'))
      .mockRejectedValueOnce(new Error('db timeout'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('db timeout'))
      .mockRejectedValueOnce(new Error('db timeout'))
      .mockRejectedValueOnce(new Error('db timeout'));

    const interval = createWorkerHeartbeatInterval({
      cloudJobId: 109,
      taskId: 'task-109',
      logger: { warn } as never,
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      for (let index = 0; index < 6; index += 1) {
        await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
      }

      expect(captureWorkerMessageMock).toHaveBeenCalledTimes(2);
      expect(captureWorkerMessageMock).toHaveBeenNthCalledWith(
        1,
        'Worker heartbeat updates are repeatedly failing',
        expect.objectContaining({
          cloudJobId: 109,
          taskId: 'task-109',
          consecutiveFailureCount: 3,
        }),
        expect.objectContaining({
          component: 'worker-heartbeat',
          signal: 'worker-heartbeat-failures',
        }),
      );
      expect(captureWorkerMessageMock).toHaveBeenNthCalledWith(
        2,
        'Worker heartbeat updates are repeatedly failing',
        expect.objectContaining({
          cloudJobId: 109,
          taskId: 'task-109',
          consecutiveFailureCount: 3,
        }),
        expect.objectContaining({
          component: 'worker-heartbeat',
          signal: 'worker-heartbeat-failures',
        }),
      );
    } finally {
      clearInterval(interval);
    }
  });

  it('does not start a new heartbeat while the previous request is still pending', async () => {
    const deferred = createDeferred<void>();
    mockTouchWorkerHeartbeat
      .mockReturnValueOnce(deferred.promise)
      .mockResolvedValue(undefined);

    const interval = createWorkerHeartbeatInterval({
      cloudJobId: 144,
      taskId: 'task-144',
      logger: { warn: vi.fn() } as never,
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mockTouchWorkerHeartbeat).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_RPC_TIMEOUT_MS - 1);
      expect(mockTouchWorkerHeartbeat).toHaveBeenCalledTimes(1);

      deferred.resolve();
      await deferred.promise;
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
      expect(mockTouchWorkerHeartbeat).toHaveBeenCalledTimes(2);
    } finally {
      clearInterval(interval);
    }
  });

  it('releases the in-flight gate after a heartbeat RPC times out', async () => {
    const warn = vi.fn();
    mockTouchWorkerHeartbeat
      .mockImplementationOnce(
        (
          _input: { id: number },
          options?: {
            signal?: AbortSignal;
          },
        ) =>
          new Promise<void>((_, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => {
                reject(options.signal?.reason ?? new Error('aborted'));
              },
              { once: true },
            );
          }),
      )
      .mockResolvedValue(undefined);

    const interval = createWorkerHeartbeatInterval({
      cloudJobId: 145,
      taskId: 'task-145',
      logger: { warn } as never,
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mockTouchWorkerHeartbeat).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_RPC_TIMEOUT_MS);

      expect(warn).toHaveBeenCalledWith(
        `[workerHeartbeat] Failed to update heartbeat for cloud job 145: Heartbeat RPC timed out after ${WORKER_HEARTBEAT_RPC_TIMEOUT_MS}ms for cloud job 145`,
      );
      expect(mockTouchWorkerHeartbeat).toHaveBeenNthCalledWith(
        1,
        { id: 145 },
        {
          signal: expect.any(AbortSignal),
        },
      );

      await vi.advanceTimersByTimeAsync(
        WORKER_HEARTBEAT_INTERVAL_MS - WORKER_HEARTBEAT_RPC_TIMEOUT_MS,
      );

      expect(mockTouchWorkerHeartbeat).toHaveBeenCalledTimes(2);
    } finally {
      clearInterval(interval);
    }
  });
});
