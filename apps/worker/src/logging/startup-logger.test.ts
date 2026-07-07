const { appendFileMock, captureWorkerExceptionMock } = vi.hoisted(() => ({
  appendFileMock: vi.fn(),
  captureWorkerExceptionMock: vi.fn(),
}));

vi.mock('node:fs', () => ({
  promises: {
    appendFile: appendFileMock,
  },
}));

vi.mock('../monitoring/sentry', () => ({
  captureWorkerException: captureWorkerExceptionMock,
}));

import {
  clearWorkerRuntimeContext,
  setWorkerRuntimeContext,
} from '../monitoring/runtime-context';

import { createStartupLogger } from './startup-logger';

function createDeferredPromise() {
  let reject: ((error: unknown) => void) | undefined;

  const promise = new Promise<void>((_resolve, deferredReject) => {
    reject = deferredReject;
  });

  return {
    promise,
    reject: (error: unknown) => reject?.(error),
  };
}

describe('createStartupLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearWorkerRuntimeContext();
    appendFileMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    clearWorkerRuntimeContext();
  });

  it('preserves runtime ids for append failures after the global runtime context is cleared', async () => {
    const deferred = createDeferredPromise();
    appendFileMock.mockReturnValueOnce(deferred.promise);

    const logger = createStartupLogger();

    setWorkerRuntimeContext({
      environmentId: 'env_123',
      taskId: 'task-7',
    });

    logger.setFilePath('/tmp/startup.log');
    logger.debug.log('hello from startup');

    clearWorkerRuntimeContext();
    deferred.reject(new Error('append failed'));

    await vi.waitFor(() => {
      expect(captureWorkerExceptionMock).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          environmentId: 'env_123',
          filePath: '/tmp/startup.log',
          stage: 'startupLogger.appendToFile',
          taskId: 'task-7',
        }),
      );
    });
  });

  it('preserves runtime ids for buffered flush failures after the global runtime context is cleared', async () => {
    const logger = createStartupLogger();

    setWorkerRuntimeContext({
      environmentId: 'env_456',
      taskId: 'task-9',
    });

    logger.userLog.log('buffered startup line');

    const deferred = createDeferredPromise();
    appendFileMock.mockReturnValueOnce(deferred.promise);

    logger.setFilePath('/tmp/startup.log');

    clearWorkerRuntimeContext();
    deferred.reject(new Error('flush failed'));

    await vi.waitFor(() => {
      expect(captureWorkerExceptionMock).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          environmentId: 'env_456',
          filePath: '/tmp/startup.log',
          stage: 'startupLogger.flushBuffer',
          taskId: 'task-9',
        }),
      );
    });
  });
});
