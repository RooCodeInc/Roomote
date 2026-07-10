import { createLinearMessageInterval } from './linear';

import type { HarnessLogger } from '../../logging';
import type { ListenerOptions } from '../types';

const {
  mockGetLinearMessages,
  mockGetLinearRequestUserInputAnswers,
  mockQueueLinearMessage,
  mockQueueLinearRequestUserInputAnswer,
  mockPrepareActorScopedTurn,
  mockPrependLinearMessages,
  mockPrependLinearRequestUserInputAnswers,
  mockCaptureWorkerException,
} = vi.hoisted(() => ({
  mockGetLinearMessages: vi.fn(),
  mockGetLinearRequestUserInputAnswers: vi.fn(),
  mockQueueLinearMessage: vi.fn(),
  mockQueueLinearRequestUserInputAnswer: vi.fn(),
  mockPrepareActorScopedTurn: vi.fn(),
  mockPrependLinearMessages: vi.fn(),
  mockPrependLinearRequestUserInputAnswers: vi.fn(),
  mockCaptureWorkerException: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    cloudJobs: {
      getLinearMessages: mockGetLinearMessages,
      getLinearRequestUserInputAnswers: mockGetLinearRequestUserInputAnswers,
      queueLinearMessage: mockQueueLinearMessage,
      queueLinearRequestUserInputAnswer: mockQueueLinearRequestUserInputAnswer,
    },
  },
}));

vi.mock('@roomote/linear/client', () => ({
  prependLinearMessages: mockPrependLinearMessages,
  prependLinearRequestUserInputAnswers:
    mockPrependLinearRequestUserInputAnswers,
}));

vi.mock('../../monitoring/sentry', () => ({
  captureWorkerException: mockCaptureWorkerException,
}));

function createLogger(): HarnessLogger {
  return {
    cloudJobId: 42,
    filePath: '/tmp/harness.log',
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createListenerOptions(overrides?: {
  sessionId?: string | undefined;
  phase?: ListenerOptions['state']['phase'];
  isConnected?: boolean;
  sendPrompt?: ListenerOptions['sendPrompt'];
  answerUserInputRequest?: ListenerOptions['answerUserInputRequest'];
}): {
  sendPrompt: ReturnType<typeof vi.fn>;
  answerUserInputRequest: ReturnType<typeof vi.fn>;
  prepareActorScopedTurn: ReturnType<typeof vi.fn>;
  options: ListenerOptions;
} {
  const hasPhaseOverride = Object.prototype.hasOwnProperty.call(
    overrides ?? {},
    'phase',
  );
  const state = {
    phase: hasPhaseOverride ? overrides?.phase : 'running',
    isConnected: overrides?.isConnected ?? true,
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
  } as ListenerOptions['state'];

  const sendPrompt = overrides?.sendPrompt
    ? vi.fn(overrides.sendPrompt)
    : vi.fn<ListenerOptions['sendPrompt']>(() => true);
  const answerUserInputRequest = overrides?.answerUserInputRequest
    ? vi.fn(overrides.answerUserInputRequest)
    : vi.fn<ListenerOptions['answerUserInputRequest']>(() => true);
  const prepareActorScopedTurn = vi.fn(
    async (
      targetUserId?: string,
      options?: {
        allowMcpReconnect?: boolean;
        deferReconnectUntilTurnBoundary?: boolean;
      },
    ) => await mockPrepareActorScopedTurn(targetUserId, options),
  );

  return {
    sendPrompt,
    answerUserInputRequest,
    prepareActorScopedTurn,
    options: {
      cloudJob: {
        id: 42,
      } as ListenerOptions['cloudJob'],
      state,
      logger: createLogger(),
      workingDirectory: '/tmp/workspace',
      cancelTask: vi.fn(),
      sendPrompt,
      answerUserInputRequest,
      prepareActorScopedTurn,
    },
  };
}

describe('createLinearMessageInterval', () => {
  const originalTrpcUrl = process.env.TRPC_URL;
  const originalAuthToken = process.env.AUTH_TOKEN;
  const originalBypassValue = process.env.ROOMOTE_AUTH_BYPASS_VALUE;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetLinearMessages.mockResolvedValue([]);
    mockGetLinearRequestUserInputAnswers.mockResolvedValue([]);
    mockQueueLinearRequestUserInputAnswer.mockResolvedValue(undefined);
    mockQueueLinearMessage.mockResolvedValue(undefined);
    mockPrepareActorScopedTurn.mockImplementation(
      async (targetUserId?: string) => ({
        effectiveUserId: targetUserId ?? null,
      }),
    );
    mockPrependLinearMessages.mockResolvedValue(undefined);
    mockPrependLinearRequestUserInputAnswers.mockResolvedValue(undefined);
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

  it('routes queued request_user_input answers to the harness before plain prompts', async () => {
    mockGetLinearRequestUserInputAnswers.mockResolvedValueOnce([
      {
        requestId: 'rui:session:turn:call',
        answers: {
          language: {
            answers: ['Rust'],
          },
        },
        userId: 'user-2',
        timestamp: 1710000000900,
      },
    ]);
    mockGetLinearMessages.mockResolvedValueOnce([
      {
        sessionId: 'session-1',
        organizationId: 'linear-org-1',
        action: 'prompted',
        timestamp: 1710000000901,
        payload: {
          type: 'AgentSessionEvent',
          action: 'prompted',
          organizationId: 'linear-org-1',
          webhookTimestamp: 1710000000901,
          webhookId: 'webhook-1',
          appUserId: 'app-user-1',
          agentSession: {
            id: 'session-1',
            issue: {
              id: 'issue-1',
              identifier: 'ENG-1',
              title: 'Test issue',
              url: 'https://linear.app/issue/ENG-1',
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          agentActivity: {
            id: 'activity-1',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            agentSessionId: 'session-1',
            content: {
              type: 'response',
              body: 'Please continue',
            },
          },
        },
        userId: 'user-2',
      },
    ]);

    const {
      options,
      answerUserInputRequest,
      prepareActorScopedTurn,
      sendPrompt,
    } = createListenerOptions();

    const interval = createLinearMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(answerUserInputRequest).toHaveBeenCalledWith({
        requestId: 'rui:session:turn:call',
        answers: {
          language: {
            answers: ['Rust'],
          },
        },
        userId: 'user-2',
      });
      expect(prepareActorScopedTurn).toHaveBeenNthCalledWith(1, 'user-2', {
        onMismatch: 'skip',
      });
      expect(prepareActorScopedTurn).toHaveBeenNthCalledWith(2, 'user-2', {
        allowMcpReconnect: false,
        onMismatch: 'skip',
      });
      expect(answerUserInputRequest.mock.invocationCallOrder[0]).toBeLessThan(
        sendPrompt.mock.invocationCallOrder[0]!,
      );
      expect(sendPrompt).toHaveBeenCalledWith({
        prompt: 'Please continue',
        source: 'linear',
        autoSteerWhenQueued: true,
        userId: 'user-2',
      });
      expect(mockGetLinearMessages).toHaveBeenCalledWith({
        cloudJobId: 42,
      });
    } finally {
      clearInterval(interval);
    }
  });

  it('captures structured transport context when Linear message polling fails', async () => {
    const fetchError = new Error('fetch failed');
    mockGetLinearMessages.mockRejectedValueOnce(fetchError);

    const { options } = createListenerOptions();
    const interval = createLinearMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(mockCaptureWorkerException).toHaveBeenCalledWith(fetchError, {
        stage: 'listenForLinearEvents',
        cloudJobId: 42,
        harnessSessionId: 'task-1',
        sdkMethod: 'cloudJobs.getLinearMessages',
        failurePoint: 'queuedLinearMessages',
        trpcUrlOrigin: 'http://127.0.0.1:3001',
        trpcHostname: '127.0.0.1',
        isLoopbackTrpcUrl: true,
        hasAuthToken: true,
        hasBypassHeader: true,
      });
      expect(options.logger.error).toHaveBeenCalledWith(
        '[listenForLinearEvents] Failed to check for queued Linear messages for job 42',
        fetchError,
        {
          stage: 'listenForLinearEvents',
          cloudJobId: 42,
          harnessSessionId: 'task-1',
          sdkMethod: 'cloudJobs.getLinearMessages',
          failurePoint: 'queuedLinearMessages',
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

  it('requeues queued request_user_input answers when the harness rejects them', async () => {
    mockGetLinearRequestUserInputAnswers.mockResolvedValueOnce([
      {
        requestId: 'rui:session:turn:call',
        answers: {
          language: {
            answers: ['Rust'],
          },
        },
        userId: 'user-2',
        timestamp: 1710000000900,
      },
    ]);

    const { options, answerUserInputRequest } = createListenerOptions({
      answerUserInputRequest: () => false,
    });

    const interval = createLinearMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(answerUserInputRequest).toHaveBeenCalledWith({
        requestId: 'rui:session:turn:call',
        answers: {
          language: {
            answers: ['Rust'],
          },
        },
        userId: 'user-2',
      });
      expect(mockPrependLinearRequestUserInputAnswers).toHaveBeenCalledWith(
        42,
        [
          {
            requestId: 'rui:session:turn:call',
            answers: {
              language: {
                answers: ['Rust'],
              },
            },
            userId: 'user-2',
            timestamp: 1710000000900,
          },
        ],
      );
      expect(mockPrepareActorScopedTurn).toHaveBeenCalledWith('user-2', {
        onMismatch: 'skip',
      });
      expect(mockGetLinearMessages).not.toHaveBeenCalled();
    } finally {
      clearInterval(interval);
    }
  });

  it('requeues Linear request_user_input answers when actor-scoped preparation fails', async () => {
    mockGetLinearRequestUserInputAnswers.mockResolvedValueOnce([
      {
        requestId: 'rui:session:turn:call',
        answers: {
          language: {
            answers: ['Rust'],
          },
        },
        userId: 'user-2',
        timestamp: 1710000000900,
      },
    ]);
    mockPrepareActorScopedTurn.mockResolvedValueOnce(false);

    const { options, answerUserInputRequest } = createListenerOptions();
    const interval = createLinearMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(answerUserInputRequest).not.toHaveBeenCalled();
      expect(mockPrependLinearRequestUserInputAnswers).toHaveBeenCalledWith(
        42,
        [
          {
            requestId: 'rui:session:turn:call',
            answers: {
              language: {
                answers: ['Rust'],
              },
            },
            userId: 'user-2',
            timestamp: 1710000000900,
          },
        ],
      );
      expect(mockGetLinearMessages).not.toHaveBeenCalled();
    } finally {
      clearInterval(interval);
    }
  });

  it('requeues the blocked Linear request_user_input answer and later drained answers together', async () => {
    mockGetLinearRequestUserInputAnswers.mockResolvedValueOnce([
      {
        requestId: 'rui:first',
        answers: { language: { answers: ['Rust'] } },
        userId: 'user-2',
        timestamp: 1710000000900,
      },
      {
        requestId: 'rui:second',
        answers: { language: { answers: ['TypeScript'] } },
        userId: 'user-2',
        timestamp: 1710000000901,
      },
    ]);
    mockPrepareActorScopedTurn.mockResolvedValueOnce(false);

    const { options, answerUserInputRequest } = createListenerOptions();
    const interval = createLinearMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(answerUserInputRequest).not.toHaveBeenCalled();
      expect(mockPrependLinearRequestUserInputAnswers).toHaveBeenCalledWith(
        42,
        [
          {
            requestId: 'rui:first',
            answers: { language: { answers: ['Rust'] } },
            userId: 'user-2',
            timestamp: 1710000000900,
          },
          {
            requestId: 'rui:second',
            answers: { language: { answers: ['TypeScript'] } },
            userId: 'user-2',
            timestamp: 1710000000901,
          },
        ],
      );
      expect(mockGetLinearMessages).not.toHaveBeenCalled();
    } finally {
      clearInterval(interval);
    }
  });

  it('requeues the rejected Linear request_user_input answer and later drained answers together', async () => {
    mockGetLinearRequestUserInputAnswers.mockResolvedValueOnce([
      {
        requestId: 'rui:first',
        answers: { language: { answers: ['Rust'] } },
        userId: 'user-2',
        timestamp: 1710000000900,
      },
      {
        requestId: 'rui:second',
        answers: { language: { answers: ['TypeScript'] } },
        userId: 'user-2',
        timestamp: 1710000000901,
      },
    ]);

    const { options, answerUserInputRequest } = createListenerOptions({
      answerUserInputRequest: () => false,
    });
    const interval = createLinearMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(answerUserInputRequest).toHaveBeenCalledTimes(1);
      expect(mockPrependLinearRequestUserInputAnswers).toHaveBeenCalledWith(
        42,
        [
          {
            requestId: 'rui:first',
            answers: { language: { answers: ['Rust'] } },
            userId: 'user-2',
            timestamp: 1710000000900,
          },
          {
            requestId: 'rui:second',
            answers: { language: { answers: ['TypeScript'] } },
            userId: 'user-2',
            timestamp: 1710000000901,
          },
        ],
      );
      expect(mockGetLinearMessages).not.toHaveBeenCalled();
    } finally {
      clearInterval(interval);
    }
  });

  it('requeues Linear follow-ups when actor-scoped preparation fails', async () => {
    mockGetLinearMessages.mockResolvedValueOnce([
      {
        sessionId: 'session-1',
        organizationId: 'linear-org-1',
        action: 'prompted',
        timestamp: 1710000000901,
        payload: {
          type: 'AgentSessionEvent',
          action: 'prompted',
          organizationId: 'linear-org-1',
          webhookTimestamp: 1710000000901,
          webhookId: 'webhook-1',
          appUserId: 'app-user-1',
          agentSession: {
            id: 'session-1',
            issue: {
              id: 'issue-1',
              identifier: 'ENG-1',
              title: 'Test issue',
              url: 'https://linear.app/issue/ENG-1',
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          agentActivity: {
            id: 'activity-1',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            agentSessionId: 'session-1',
            content: {
              type: 'response',
              body: 'Please continue',
            },
          },
        },
        userId: 'user-2',
      },
    ]);
    mockPrepareActorScopedTurn.mockResolvedValueOnce(false);

    const { options, sendPrompt } = createListenerOptions();
    const interval = createLinearMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(sendPrompt).not.toHaveBeenCalled();
      expect(mockPrependLinearMessages).toHaveBeenCalledWith(42, [
        expect.objectContaining({
          sessionId: 'session-1',
          payload: expect.objectContaining({
            type: 'AgentSessionEvent',
            action: 'prompted',
          }),
          userId: 'user-2',
        }),
      ]);
    } finally {
      clearInterval(interval);
    }
  });

  it('allows MCP reconnects for queued Linear follow-ups when phase is unknown', async () => {
    mockGetLinearMessages.mockResolvedValueOnce([
      {
        sessionId: 'session-1',
        organizationId: 'linear-org-1',
        action: 'prompted',
        timestamp: 1710000000901,
        payload: {
          type: 'AgentSessionEvent',
          action: 'prompted',
          organizationId: 'linear-org-1',
          webhookTimestamp: 1710000000901,
          webhookId: 'webhook-1',
          appUserId: 'app-user-1',
          agentSession: {
            id: 'session-1',
            issue: {
              id: 'issue-1',
              identifier: 'ENG-1',
              title: 'Test issue',
              url: 'https://linear.app/issue/ENG-1',
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          agentActivity: {
            id: 'activity-1',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            agentSessionId: 'session-1',
            content: {
              type: 'response',
              body: 'Please continue',
            },
          },
        },
        userId: 'user-2',
      },
    ]);

    const { options, prepareActorScopedTurn } = createListenerOptions({
      phase: undefined,
    });
    const interval = createLinearMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(prepareActorScopedTurn).toHaveBeenCalledWith('user-2', {
        allowMcpReconnect: true,
        onMismatch: 'skip',
      });
    } finally {
      clearInterval(interval);
    }
  });

  it('allows MCP reconnects for queued Linear follow-ups after disconnect', async () => {
    mockGetLinearMessages.mockResolvedValueOnce([
      {
        sessionId: 'session-1',
        organizationId: 'linear-org-1',
        action: 'prompted',
        timestamp: 1710000000902,
        payload: {
          type: 'AgentSessionEvent',
          action: 'prompted',
          organizationId: 'linear-org-1',
          webhookTimestamp: 1710000000902,
          webhookId: 'webhook-2',
          appUserId: 'app-user-1',
          agentSession: {
            id: 'session-1',
            issue: {
              id: 'issue-1',
              identifier: 'ENG-1',
              title: 'Test issue',
              url: 'https://linear.app/issue/ENG-1',
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          agentActivity: {
            id: 'activity-2',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            agentSessionId: 'session-1',
            content: {
              type: 'response',
              body: 'Please continue',
            },
          },
        },
        userId: 'user-2',
      },
    ]);

    const { options, prepareActorScopedTurn } = createListenerOptions({
      phase: 'running',
      isConnected: false,
    });
    const interval = createLinearMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(prepareActorScopedTurn).toHaveBeenCalledWith('user-2', {
        allowMcpReconnect: true,
        onMismatch: 'skip',
      });
    } finally {
      clearInterval(interval);
    }
  });

  it('requeues the blocked Linear follow-up and later drained messages together', async () => {
    mockGetLinearMessages.mockResolvedValueOnce([
      {
        sessionId: 'session-1',
        organizationId: 'linear-org-1',
        action: 'prompted',
        timestamp: 1710000000901,
        payload: {
          type: 'AgentSessionEvent',
          action: 'prompted',
          organizationId: 'linear-org-1',
          webhookTimestamp: 1710000000901,
          webhookId: 'webhook-1',
          appUserId: 'app-user-1',
          agentSession: {
            id: 'session-1',
            issue: {
              id: 'issue-1',
              identifier: 'ENG-1',
              title: 'Test issue',
              url: 'https://linear.app/issue/ENG-1',
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          agentActivity: {
            id: 'activity-1',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            agentSessionId: 'session-1',
            content: {
              type: 'response',
              body: 'First follow-up',
            },
          },
        },
        userId: 'user-2',
      },
      {
        sessionId: 'session-1',
        organizationId: 'linear-org-1',
        action: 'prompted',
        timestamp: 1710000000902,
        payload: {
          type: 'AgentSessionEvent',
          action: 'prompted',
          organizationId: 'linear-org-1',
          webhookTimestamp: 1710000000902,
          webhookId: 'webhook-2',
          appUserId: 'app-user-1',
          agentSession: {
            id: 'session-1',
            issue: {
              id: 'issue-1',
              identifier: 'ENG-1',
              title: 'Test issue',
              url: 'https://linear.app/issue/ENG-1',
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          agentActivity: {
            id: 'activity-2',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            agentSessionId: 'session-1',
            content: {
              type: 'response',
              body: 'Second follow-up',
            },
          },
        },
        userId: 'user-2',
      },
    ]);
    mockPrepareActorScopedTurn.mockResolvedValueOnce(false);

    const { options, sendPrompt } = createListenerOptions();
    const interval = createLinearMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(sendPrompt).not.toHaveBeenCalled();
      expect(mockPrependLinearMessages).toHaveBeenCalledWith(42, [
        expect.objectContaining({
          sessionId: 'session-1',
          payload: expect.objectContaining({
            type: 'AgentSessionEvent',
            webhookId: 'webhook-1',
          }),
          userId: 'user-2',
        }),
        expect.objectContaining({
          sessionId: 'session-1',
          payload: expect.objectContaining({
            type: 'AgentSessionEvent',
            webhookId: 'webhook-2',
          }),
          userId: 'user-2',
        }),
      ]);
    } finally {
      clearInterval(interval);
    }
  });
});
