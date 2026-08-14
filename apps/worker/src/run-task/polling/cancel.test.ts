import { createCancelInterval } from './cancel';

import type { HarnessLogger } from '../../logging';
import type { ListenerOptions } from '../types';

const { mockFindRuntimeStateById, mockCaptureWorkerException } = vi.hoisted(
  () => ({
    mockFindRuntimeStateById: vi.fn(),
    mockCaptureWorkerException: vi.fn(),
  }),
);

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      findRuntimeStateById: mockFindRuntimeStateById,
    },
  },
}));

vi.mock('../../monitoring/sentry', () => ({
  captureWorkerException: mockCaptureWorkerException,
}));

function createLogger(): HarnessLogger {
  return {
    runId: 42,
    filePath: '/tmp/harness.log',
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createListenerOptions(overrides?: {
  sessionId?: string | undefined;
}): { logger: HarnessLogger; options: ListenerOptions } {
  const logger = createLogger();

  return {
    logger,
    options: {
      taskRun: {
        id: 42,
      } as ListenerOptions['taskRun'],
      state: {
        sessionId: overrides?.sessionId ?? 'task-1',
        lastMessageAt: undefined,
        lastActivityAt: undefined,
        taskFinishedAt: undefined,
        taskAbortedAt: undefined,
        clientDisconnectedAt: undefined,
        cancelTriggeredAt: undefined,
        lastErrorMessage: undefined,
        cancelInterval: undefined,
        slackMessageInterval: undefined,
        linearMessageInterval: undefined,
        githubTokenRefreshInterval: undefined,
      } as ListenerOptions['state'],
      logger,
      workingDirectory: '/tmp/workspace',
      cancelTask: vi.fn(),
      sendPrompt: vi.fn<ListenerOptions['sendPrompt']>(async () => true),
      answerUserInputRequest: vi.fn<ListenerOptions['answerUserInputRequest']>(
        () => true,
      ),
      prepareActorScopedTurn: vi.fn(
        async (targetUserId?: string) =>
          ({ effectiveUserId: targetUserId ?? null }) as const,
      ),
    },
  };
}

describe('createCancelInterval', () => {
  const originalTrpcUrl = process.env.TRPC_URL;
  const originalAuthToken = process.env.AUTH_TOKEN;
  const originalBypassValue = process.env.ROOMOTE_AUTH_BYPASS_VALUE;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    process.env.TRPC_URL = 'http://127.0.0.1:3001';
    process.env.AUTH_TOKEN = 'worker-auth-token';
    process.env.ROOMOTE_AUTH_BYPASS_VALUE = 'bypass-token';
  });

  afterEach(() => {
    vi.useRealTimers();

    if (originalTrpcUrl === undefined) {
      delete process.env.TRPC_URL;
    } else {
      process.env.TRPC_URL = originalTrpcUrl;
    }

    if (originalAuthToken === undefined) {
      delete process.env.AUTH_TOKEN;
    } else {
      process.env.AUTH_TOKEN = originalAuthToken;
    }

    if (originalBypassValue === undefined) {
      delete process.env.ROOMOTE_AUTH_BYPASS_VALUE;
    } else {
      process.env.ROOMOTE_AUTH_BYPASS_VALUE = originalBypassValue;
    }
  });

  it('captures the exception with structured transport context when cancel polling fails', async () => {
    const fetchError = new Error('fetch failed');
    mockFindRuntimeStateById.mockRejectedValueOnce(fetchError);

    const { logger, options } = createListenerOptions();
    const interval = createCancelInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(10_000);

      expect(mockCaptureWorkerException).toHaveBeenCalledWith(fetchError, {
        stage: 'listenForCancel',
        runId: 42,
        harnessSessionId: 'task-1',
        sdkMethod: 'taskRuns.findRuntimeStateById',
        trpcUrlOrigin: 'http://127.0.0.1:3001',
        trpcHostname: '127.0.0.1',
        isLoopbackTrpcUrl: true,
        hasAuthToken: true,
        hasBypassHeader: true,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        '[listenForCancel] unable to check cancellation status for job 42',
        fetchError,
        {
          stage: 'listenForCancel',
          runId: 42,
          harnessSessionId: 'task-1',
          sdkMethod: 'taskRuns.findRuntimeStateById',
          trpcUrlOrigin: 'http://127.0.0.1:3001',
          trpcHostname: '127.0.0.1',
          isLoopbackTrpcUrl: true,
          hasAuthToken: true,
          hasBypassHeader: true,
        },
      );
    } finally {
      clearInterval(interval);
    }
  });
});
