import type { ReactNode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import {
  acpQueuedMessagesUpdate,
  acpRequestUserInput,
  acpRequestUserInputResponse,
  acpUsageUpdate,
  acpUserPrompt,
} from './use-sandbox-store-test-kit';
import type { TaskMessageEnvelope } from '@/types';

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://postgres:password@localhost:5432/test',
    },
  };
});

const {
  addBreadcrumbMock,
  captureMessageMock,
  clearLiveTaskStatusMock,
  createTRPCProxyClientMock,
  createWSClientMock,
  httpBatchLinkMock,
  setLiveTaskStatusMock,
  splitLinkMock,
  useTRPCMock,
  useUserMock,
  withScopeMock,
  wsLinkMock,
} = vi.hoisted(() => ({
  addBreadcrumbMock: vi.fn(),
  captureMessageMock: vi.fn(),
  clearLiveTaskStatusMock: vi.fn(),
  createTRPCProxyClientMock: vi.fn(),
  createWSClientMock: vi.fn(() => ({
    close: vi.fn(),
  })),
  httpBatchLinkMock: vi.fn(() => ({})),
  setLiveTaskStatusMock: vi.fn(),
  splitLinkMock: vi.fn(() => ({})),
  useTRPCMock: vi.fn(() => ({
    sandboxSession: {
      byTaskId: {
        queryKey: ({ taskId }: { taskId: string }) => [
          'sandboxSession',
          taskId,
        ],
      },
    },
    tasks: {
      messageEnvelopes: {
        queryKey: ({ taskId }: { taskId: string }) => [
          'tasks.messageEnvelopes',
          taskId,
        ],
      },
      list: {
        queryKey: () => ['tasks'],
      },
    },
  })),
  useUserMock: vi.fn(() => ({ user: null })),
  withScopeMock: vi.fn((callback: (scope: unknown) => void) =>
    callback({
      setTag: vi.fn(),
      setContext: vi.fn(),
    }),
  ),
  wsLinkMock: vi.fn(() => ({})),
}));

vi.mock('@trpc/client', () => ({
  createTRPCProxyClient: createTRPCProxyClientMock,
  createWSClient: createWSClientMock,
  httpBatchLink: httpBatchLinkMock,
  splitLink: splitLinkMock,
  wsLink: wsLinkMock,
}));

vi.mock('@sentry/nextjs', () => ({
  addBreadcrumb: addBreadcrumbMock,
  captureMessage: captureMessageMock,
  withScope: withScopeMock,
}));

vi.mock('@/hooks/useUser', () => ({
  useUser: useUserMock,
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: useTRPCMock,
}));

vi.mock('@/hooks/tasks', () => ({
  clearLiveTaskStatus: clearLiveTaskStatusMock,
  setLiveTaskStatus: setLiveTaskStatusMock,
}));

import {
  SandboxProvider,
  useSandboxConnectionStatus,
  useSandboxPendingEnvVarRequest,
  useSandboxQueuedMessages,
  useSandboxPendingUserInputRequests,
  useSandboxTaskPhase,
} from '../SandboxProvider';

function createDeferred<T>() {
  let resolve: (value: T) => void;
  let reject: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject: reject!, resolve: resolve! };
}

function createWrapper(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const hydratedHistory = {
  data: [],
  isPending: false,
  isSuccess: true,
  isError: false,
};

function ProviderStateProbe() {
  const pendingRequests = useSandboxPendingUserInputRequests();
  const pendingEnvVarRequest = useSandboxPendingEnvVarRequest();
  const queuedMessages = useSandboxQueuedMessages();
  const phase = useSandboxTaskPhase();

  return (
    <div>
      <div data-testid="pending-count">{pendingRequests.length}</div>
      <div data-testid="pending-env-var-count">
        {pendingEnvVarRequest ? pendingEnvVarRequest.variables.length : 0}
      </div>
      <div data-testid="queued-count">{queuedMessages.length}</div>
      <div data-testid="phase">{phase ?? 'none'}</div>
    </div>
  );
}

function ConnectionStateProbe() {
  const {
    connected,
    hasConnectedOnce,
    connectionError,
    connectionFailureCategory,
    reconnecting,
  } = useSandboxConnectionStatus();

  return (
    <div>
      <div data-testid="connected">{String(connected)}</div>
      <div data-testid="has-connected-once">{String(hasConnectedOnce)}</div>
      <div data-testid="connection-error">{String(connectionError)}</div>
      <div data-testid="connection-failure-category">
        {connectionFailureCategory ?? 'none'}
      </div>
      <div data-testid="reconnecting">{String(reconnecting)}</div>
    </div>
  );
}

describe('SandboxProvider runtime state sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps workspace children mounted while history is loading', () => {
    render(
      createWrapper(
        <SandboxProvider
          taskId="task-loading-shell"
          url="http://sandbox.test"
          token={undefined}
          history={{ data: undefined, isSuccess: false, isError: false }}
          fallback={<div>loading</div>}
        >
          <div data-testid="workspace-shell" />
        </SandboxProvider>,
      ),
    );

    expect(screen.getByTestId('workspace-shell')).toBeInTheDocument();
    expect(screen.queryByText('loading')).not.toBeInTheDocument();
  });

  it('renders hydrated children before the websocket connects and waits for a token before opening transport', async () => {
    createTRPCProxyClientMock.mockReturnValue({
      commands: {
        getRuntimeState: {
          query: vi.fn(),
        },
        sandboxStream: {
          subscribe: vi.fn(),
        },
      },
    });

    const { rerender } = render(
      createWrapper(
        <SandboxProvider
          taskId="task-early-render"
          url="http://sandbox.test"
          token={undefined}
          history={hydratedHistory}
          initialTaskPhase="waiting_for_prompt"
          fallback={<div>loading</div>}
        >
          <ProviderStateProbe />
        </SandboxProvider>,
      ),
    );

    await waitFor(() => {
      expect(screen.queryByText('loading')).not.toBeInTheDocument();
      expect(screen.getByTestId('phase')).toHaveTextContent(
        'waiting_for_prompt',
      );
    });

    expect(createWSClientMock).not.toHaveBeenCalled();

    rerender(
      createWrapper(
        <SandboxProvider
          taskId="task-early-render"
          url="http://sandbox.test"
          token="token-123"
          history={hydratedHistory}
          initialTaskPhase="waiting_for_prompt"
          fallback={<div>loading</div>}
        >
          <ProviderStateProbe />
        </SandboxProvider>,
      ),
    );

    await waitFor(() => {
      expect(createWSClientMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'ws://sandbox.test/ws/trpc',
        }),
      );
    });
  });

  it('retries the initial websocket bootstrap before surfacing a disconnect error', async () => {
    const runtimeState = {
      status: {
        phase: 'running' as const,
        taskStateEvent: null,
        sessionId: 'session-retry',
        isConnected: true,
        sleepRemainingMs: null,
        lastErrorMessage: undefined,
      },
      pendingUserInputRequests: [],
      pendingEnvVarRequest: null,
      queuedMessages: [],
    };

    const subscribeMock = vi.fn();
    const refreshConnectionMock = vi.fn().mockResolvedValue({
      url: 'http://sandbox-refreshed.test',
      token: 'token-refreshed',
    });

    createTRPCProxyClientMock.mockReturnValue({
      commands: {
        getRuntimeState: {
          query: vi.fn().mockResolvedValue(runtimeState),
        },
        sandboxStream: {
          subscribe: subscribeMock.mockImplementation(
            (
              _input: undefined,
              handlers: {
                onStarted: () => void;
                onData: (event: unknown) => void;
                onError: (error: unknown) => void;
                onComplete: () => void;
              },
            ) => {
              if (subscribeMock.mock.calls.length === 1) {
                return { unsubscribe: vi.fn() };
              }

              handlers.onStarted();
              return { unsubscribe: vi.fn() };
            },
          ),
        },
      },
    });

    render(
      createWrapper(
        <SandboxProvider
          taskId="task-initial-retry"
          url="http://sandbox.test"
          token="token-123"
          refreshConnection={refreshConnectionMock}
          history={hydratedHistory}
          fallback={<div>loading</div>}
        >
          <ConnectionStateProbe />
        </SandboxProvider>,
      ),
    );

    await waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(1);
    });

    expect(createWSClientMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: 'ws://sandbox.test/ws/trpc',
      }),
    );

    expect(screen.getByTestId('connected')).toHaveTextContent('false');
    expect(screen.getByTestId('has-connected-once')).toHaveTextContent('false');
    expect(screen.getByTestId('connection-error')).toHaveTextContent('false');
    expect(screen.getByTestId('reconnecting')).toHaveTextContent('false');

    await waitFor(
      () => {
        expect(refreshConnectionMock).toHaveBeenCalledTimes(1);
        expect(subscribeMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(screen.getByTestId('connected')).toHaveTextContent('true');
      },
      { timeout: 8_000 },
    );

    expect(createWSClientMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: 'ws://sandbox-refreshed.test/ws/trpc',
      }),
    );
    const refreshedWsClientConfig = (
      createWSClientMock.mock.calls as unknown as Array<
        [
          {
            connectionParams?: () => { token: string };
          },
        ]
      >
    )[1]?.[0];
    expect(refreshedWsClientConfig?.connectionParams?.()).toEqual({
      token: 'token-refreshed',
    });
    expect(screen.getByTestId('connection-error')).toHaveTextContent('false');
    expect(screen.getByTestId('reconnecting')).toHaveTextContent('false');
    expect(screen.getByTestId('has-connected-once')).toHaveTextContent('true');
  }, 15_000);

  it('surfaces an error after the initial connection retry budget is exhausted', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refreshConnectionMock = vi.fn().mockResolvedValue(undefined);
    const subscribeMock = vi.fn().mockImplementation(() => ({
      unsubscribe: vi.fn(),
    }));

    createTRPCProxyClientMock.mockReturnValue({
      commands: {
        getRuntimeState: {
          query: vi.fn(),
        },
        sandboxStream: {
          subscribe: subscribeMock,
        },
      },
    });

    render(
      createWrapper(
        <SandboxProvider
          taskId="task-initial-retry-failure"
          url="http://sandbox.test"
          token="token-123"
          refreshConnection={refreshConnectionMock}
          history={hydratedHistory}
          fallback={<div>loading</div>}
        >
          <ConnectionStateProbe />
        </SandboxProvider>,
      ),
    );

    const firstWsConfig = (
      createWSClientMock.mock.calls as unknown as Array<
        [{ onClose?: (cause?: { code?: number }) => void }]
      >
    )[0]?.[0];
    firstWsConfig?.onClose?.({ code: 1006 });

    try {
      await waitFor(
        () => {
          expect(refreshConnectionMock).toHaveBeenCalledTimes(2);
          expect(subscribeMock.mock.calls.length).toBeGreaterThanOrEqual(3);
          expect(screen.getByTestId('connected')).toHaveTextContent('false');
          expect(screen.getByTestId('has-connected-once')).toHaveTextContent(
            'false',
          );
          expect(screen.getByTestId('connection-error')).toHaveTextContent(
            'true',
          );
          expect(
            screen.getByTestId('connection-failure-category'),
          ).toHaveTextContent('backend_unavailable');
          expect(screen.getByTestId('reconnecting')).toHaveTextContent('false');
        },
        { timeout: 20_000 },
      );

      expect(addBreadcrumbMock).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'sandbox.websocket',
          data: expect.objectContaining({
            taskId: 'task-initial-retry-failure',
            closeCode: 1006,
          }),
        }),
      );
      expect(captureMessageMock).toHaveBeenCalledWith(
        'Sandbox live connection retries exhausted',
        'warning',
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('retrying initial connection'),
        expect.objectContaining({
          closeCode: 1006,
          taskId: 'task-initial-retry-failure',
        }),
      );

      // Coming back online should automatically restart the exhausted
      // connection instead of waiting for a manual Reconnect click.
      const subscribeCallsAfterExhaustion = subscribeMock.mock.calls.length;

      window.dispatchEvent(new Event('online'));

      await waitFor(() => {
        expect(subscribeMock.mock.calls.length).toBeGreaterThan(
          subscribeCallsAfterExhaustion,
        );
      });
    } finally {
      warnSpy.mockRestore();
    }
  }, 25_000);

  it('marks an established disconnect as reconnecting before surfacing an error', async () => {
    const refreshConnectionMock = vi.fn().mockResolvedValue(undefined);
    const handlers: Array<{
      onStarted: () => void;
      onData: (event: unknown) => void;
      onError: (error: unknown) => void;
      onComplete: () => void;
    }> = [];
    const subscribeMock = vi.fn().mockImplementation(
      (
        _input: undefined,
        nextHandlers: {
          onStarted: () => void;
          onData: (event: unknown) => void;
          onError: (error: unknown) => void;
          onComplete: () => void;
        },
      ) => {
        handlers.push(nextHandlers);
        nextHandlers.onStarted();
        return { unsubscribe: vi.fn() };
      },
    );

    createTRPCProxyClientMock.mockImplementation(() => ({
      commands: {
        getRuntimeState: {
          query: vi.fn().mockResolvedValue({
            status: {
              phase: 'running' as const,
              taskStateEvent: null,
              sessionId: 'session-established-retry',
              isConnected: true,
              sleepRemainingMs: null,
              lastErrorMessage: undefined,
            },
            pendingUserInputRequests: [],
            pendingEnvVarRequest: null,
            queuedMessages: [],
          }),
        },
        sandboxStream: {
          subscribe: subscribeMock,
        },
      },
    }));

    render(
      createWrapper(
        <SandboxProvider
          taskId="task-established-retry"
          url="http://sandbox.test"
          token="token-123"
          refreshConnection={refreshConnectionMock}
          history={hydratedHistory}
          fallback={<div>loading</div>}
        >
          <ConnectionStateProbe />
        </SandboxProvider>,
      ),
    );

    await waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('connected')).toHaveTextContent('true');
      expect(screen.getByTestId('has-connected-once')).toHaveTextContent(
        'true',
      );
      expect(screen.getByTestId('reconnecting')).toHaveTextContent('false');
    });

    act(() => {
      handlers[0]?.onComplete();
    });

    expect(screen.getByTestId('connected')).toHaveTextContent('false');
    expect(screen.getByTestId('connection-error')).toHaveTextContent('false');
    expect(screen.getByTestId('reconnecting')).toHaveTextContent('true');
    expect(refreshConnectionMock).not.toHaveBeenCalled();
  });

  it('invalidates the task session instead of retrying a stale websocket when refreshConnection returns null after disconnect', async () => {
    const refreshConnectionMock = vi.fn().mockResolvedValue(null);
    const handlers: Array<{
      onStarted: () => void;
      onData: (event: unknown) => void;
      onError: (error: unknown) => void;
      onComplete: () => void;
    }> = [];
    const subscribeMock = vi.fn().mockImplementation(
      (
        _input: undefined,
        nextHandlers: {
          onStarted: () => void;
          onData: (event: unknown) => void;
          onError: (error: unknown) => void;
          onComplete: () => void;
        },
      ) => {
        handlers.push(nextHandlers);

        if (subscribeMock.mock.calls.length === 1) {
          nextHandlers.onStarted();
        }

        return { unsubscribe: vi.fn() };
      },
    );

    createTRPCProxyClientMock.mockImplementation(() => ({
      commands: {
        getRuntimeState: {
          query: vi.fn().mockResolvedValue({
            status: {
              phase: 'running' as const,
              taskStateEvent: null,
              sessionId: 'session-refresh-null',
              isConnected: true,
              sleepRemainingMs: null,
              lastErrorMessage: undefined,
            },
            pendingUserInputRequests: [],
            pendingEnvVarRequest: null,
            queuedMessages: [],
          }),
        },
        sandboxStream: {
          subscribe: subscribeMock,
        },
      },
    }));

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const invalidateQueriesMock = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <QueryClientProvider client={queryClient}>
        <SandboxProvider
          taskId="task-refresh-null"
          url="http://sandbox.test"
          token="token-123"
          refreshConnection={refreshConnectionMock}
          history={hydratedHistory}
          fallback={<div>loading</div>}
        >
          <ConnectionStateProbe />
        </SandboxProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('connected')).toHaveTextContent('true');
    });

    act(() => {
      handlers[0]?.onComplete();
    });

    expect(screen.getByTestId('connected')).toHaveTextContent('false');
    expect(screen.getByTestId('reconnecting')).toHaveTextContent('true');

    await waitFor(
      () => {
        expect(refreshConnectionMock).toHaveBeenCalledTimes(1);
      },
      { timeout: 3_000 },
    );

    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ['sandboxSession', 'task-refresh-null'],
    });
    expect(subscribeMock).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('surfaces terminal refreshConnection failures immediately during established reconnect retries', async () => {
    const refreshConnectionMock = vi
      .fn()
      .mockRejectedValue(new Error('401 unauthorized'));
    const handlers: Array<{
      onStarted: () => void;
      onData: (event: unknown) => void;
      onError: (error: unknown) => void;
      onComplete: () => void;
    }> = [];
    const subscribeMock = vi.fn().mockImplementation(
      (
        _input: undefined,
        nextHandlers: {
          onStarted: () => void;
          onData: (event: unknown) => void;
          onError: (error: unknown) => void;
          onComplete: () => void;
        },
      ) => {
        handlers.push(nextHandlers);
        nextHandlers.onStarted();
        return { unsubscribe: vi.fn() };
      },
    );

    createTRPCProxyClientMock.mockImplementation(() => ({
      commands: {
        getRuntimeState: {
          query: vi.fn().mockResolvedValue({
            status: {
              phase: 'running' as const,
              taskStateEvent: null,
              sessionId: 'session-refresh-terminal-reconnect',
              isConnected: true,
              sleepRemainingMs: null,
              lastErrorMessage: undefined,
            },
            pendingUserInputRequests: [],
            pendingEnvVarRequest: null,
            queuedMessages: [],
          }),
        },
        sandboxStream: {
          subscribe: subscribeMock,
        },
      },
    }));

    render(
      createWrapper(
        <SandboxProvider
          taskId="task-refresh-terminal-reconnect"
          url="http://sandbox.test"
          token="token-123"
          refreshConnection={refreshConnectionMock}
          history={hydratedHistory}
          fallback={<div>loading</div>}
        >
          <ConnectionStateProbe />
        </SandboxProvider>,
      ),
    );

    await waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('connected')).toHaveTextContent('true');
    });

    act(() => {
      handlers[0]?.onComplete();
    });

    expect(screen.getByTestId('reconnecting')).toHaveTextContent('true');

    await waitFor(
      () => {
        expect(refreshConnectionMock).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('connected')).toHaveTextContent('false');
        expect(screen.getByTestId('reconnecting')).toHaveTextContent('false');
        expect(screen.getByTestId('connection-error')).toHaveTextContent(
          'true',
        );
        expect(
          screen.getByTestId('connection-failure-category'),
        ).toHaveTextContent('auth_error');
      },
      { timeout: 3_000 },
    );
  }, 10_000);

  it('refreshes before surfacing established auth reconnect errors as terminal', async () => {
    const refreshConnectionMock = vi
      .fn()
      .mockRejectedValue(new Error('401 unauthorized'));
    const handlers: Array<{
      onStarted: () => void;
      onData: (event: unknown) => void;
      onError: (error: unknown) => void;
      onComplete: () => void;
    }> = [];
    const subscribeMock = vi.fn().mockImplementation(
      (
        _input: undefined,
        nextHandlers: {
          onStarted: () => void;
          onData: (event: unknown) => void;
          onError: (error: unknown) => void;
          onComplete: () => void;
        },
      ) => {
        handlers.push(nextHandlers);
        nextHandlers.onStarted();
        return { unsubscribe: vi.fn() };
      },
    );

    createTRPCProxyClientMock.mockImplementation(() => ({
      commands: {
        getRuntimeState: {
          query: vi.fn().mockResolvedValue({
            status: {
              phase: 'running' as const,
              taskStateEvent: null,
              sessionId: 'session-terminal-reconnect',
              isConnected: true,
              sleepRemainingMs: null,
              lastErrorMessage: undefined,
            },
            pendingUserInputRequests: [],
            pendingEnvVarRequest: null,
            queuedMessages: [],
          }),
        },
        sandboxStream: {
          subscribe: subscribeMock,
        },
      },
    }));

    render(
      createWrapper(
        <SandboxProvider
          taskId="task-terminal-reconnect"
          url="http://sandbox.test"
          token="token-123"
          refreshConnection={refreshConnectionMock}
          history={hydratedHistory}
          fallback={<div>loading</div>}
        >
          <ConnectionStateProbe />
        </SandboxProvider>,
      ),
    );

    await waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('connected')).toHaveTextContent('true');
    });

    act(() => {
      handlers[0]?.onError(new Error('401 unauthorized'));
    });

    expect(screen.getByTestId('connected')).toHaveTextContent('false');
    expect(screen.getByTestId('reconnecting')).toHaveTextContent('true');
    expect(screen.getByTestId('connection-error')).toHaveTextContent('false');

    await waitFor(
      () => {
        expect(refreshConnectionMock).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('reconnecting')).toHaveTextContent('false');
        expect(screen.getByTestId('connection-error')).toHaveTextContent(
          'true',
        );
        expect(
          screen.getByTestId('connection-failure-category'),
        ).toHaveTextContent('auth_error');
      },
      { timeout: 3_000 },
    );
  }, 10_000);

  it('does not let a stale runtime snapshot overwrite newer live task status or request_user_input events', async () => {
    const runtimeStateDeferred = createDeferred<{
      status: {
        phase: 'waiting_for_user_input';
        taskStateEvent: null;
        sessionId: string;
        isConnected: true;
        sleepRemainingMs: number | null;
        lastErrorMessage: undefined;
      };
      pendingUserInputRequests: Array<{
        requestId: string;
        sessionId: string;
        turnId: string;
        callId: string;
        status: 'pending';
        ts: number;
        questions: Array<{
          id: string;
          header: string;
          question: string;
          isOther: boolean;
          isSecret: boolean;
          options: Array<{ label: string; description: string }>;
        }>;
      }>;
      pendingEnvVarRequest: {
        key: string;
        ts: number;
        variables: Array<{ name: string }>;
      } | null;
      queuedMessages: Array<{
        id: string;
        text: string;
        timestamp: number;
      }>;
    }>();
    const unsubscribeMock = vi.fn();
    let handlers:
      | {
          onStarted: () => void;
          onData: (event: unknown) => void;
          onError: (error: unknown) => void;
          onComplete: () => void;
        }
      | undefined;

    createTRPCProxyClientMock.mockReturnValue({
      commands: {
        getRuntimeState: {
          query: vi.fn(() => runtimeStateDeferred.promise),
        },
        sandboxStream: {
          subscribe: vi.fn(
            (
              _input: undefined,
              nextHandlers: {
                onStarted: () => void;
                onData: (event: unknown) => void;
                onError: (error: unknown) => void;
                onComplete: () => void;
              },
            ) => {
              handlers = nextHandlers;
              nextHandlers.onStarted();
              return { unsubscribe: unsubscribeMock };
            },
          ),
        },
      },
    });

    render(
      createWrapper(
        <SandboxProvider
          taskId="task-123"
          url="http://sandbox.test"
          token="token-123"
          history={hydratedHistory}
          fallback={<div>loading</div>}
        >
          <ProviderStateProbe />
        </SandboxProvider>,
      ),
    );

    await waitFor(() => {
      expect(handlers).toBeDefined();
      expect(screen.getByTestId('pending-count')).toHaveTextContent('0');
      expect(screen.getByTestId('pending-env-var-count')).toHaveTextContent(
        '0',
      );
      expect(screen.getByTestId('queued-count')).toHaveTextContent('0');
      expect(screen.getByTestId('phase')).toHaveTextContent('none');
    });

    act(() => {
      handlers?.onData({
        type: 'runtimeOutput',
        event: acpQueuedMessagesUpdate(
          [
            {
              id: 'runtime-queued-live',
              text: 'Use the live queue state',
              timestamp: 9,
            },
          ],
          { ts: 9, sequence: 9 },
        ),
      });
      handlers?.onData({
        type: 'runtimeOutput',
        event: acpRequestUserInput({
          ts: 10,
          requestId: 'rui:session-1:turn-1:call-1',
          questions: [
            {
              id: 'color',
              header: 'Color',
              question: 'Pick a color',
              isOther: false,
              isSecret: false,
              options: [
                {
                  label: 'Blue',
                  description: 'Use blue.',
                },
              ],
            },
          ],
        }),
      });
      handlers?.onData({
        type: 'runtimeOutput',
        event: acpRequestUserInputResponse({
          ts: 11,
          requestId: 'rui:session-1:turn-1:call-1',
          answers: {
            color: {
              answers: ['Blue'],
            },
          },
        }),
      });
      handlers?.onData({
        type: 'taskStatus',
        status: {
          phase: 'running',
          taskStateEvent: null,
          sessionId: 'session-1',
          isConnected: true,
          sleepRemainingMs: 15_000,
          lastErrorMessage: undefined,
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('pending-count')).toHaveTextContent('0');
      expect(screen.getByTestId('pending-env-var-count')).toHaveTextContent(
        '0',
      );
      expect(screen.getByTestId('queued-count')).toHaveTextContent('1');
      expect(screen.getByTestId('phase')).toHaveTextContent('running');
    });

    await act(async () => {
      runtimeStateDeferred.resolve({
        status: {
          phase: 'waiting_for_user_input',
          taskStateEvent: null,
          sessionId: 'session-1',
          isConnected: true,
          sleepRemainingMs: 30_000,
          lastErrorMessage: undefined,
        },
        pendingUserInputRequests: [
          {
            requestId: 'rui:session-1:turn-1:call-1',
            sessionId: 'session-1',
            turnId: 'turn-1',
            callId: 'call-1',
            status: 'pending',
            ts: 9,
            questions: [
              {
                id: 'color',
                header: 'Color',
                question: 'Pick a color',
                isOther: false,
                isSecret: false,
                options: [
                  {
                    label: 'Blue',
                    description: 'Use blue.',
                  },
                ],
              },
            ],
          },
        ],
        pendingEnvVarRequest: null,
        queuedMessages: [
          {
            id: 'runtime-queued-stale',
            text: 'Stale runtime queue state',
            timestamp: 8,
          },
        ],
      });
      await runtimeStateDeferred.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId('pending-count')).toHaveTextContent('0');
      expect(screen.getByTestId('pending-env-var-count')).toHaveTextContent(
        '0',
      );
      expect(screen.getByTestId('queued-count')).toHaveTextContent('1');
      expect(screen.getByTestId('phase')).toHaveTextContent('running');
    });

    expect(setLiveTaskStatusMock).toHaveBeenCalledWith(
      'task-123',
      expect.objectContaining({
        phase: 'running',
      }),
    );
    expect(setLiveTaskStatusMock).not.toHaveBeenCalledWith(
      'task-123',
      expect.objectContaining({
        phase: 'waiting_for_user_input',
      }),
    );
  });

  it('hydrates queued follow-up prompts from getRuntimeState after reconnect', async () => {
    const unsubscribeMock = vi.fn();

    createTRPCProxyClientMock.mockReturnValue({
      commands: {
        getRuntimeState: {
          query: vi.fn(async () => ({
            status: {
              phase: 'running',
              taskStateEvent: null,
              sessionId: 'session-queued',
              isConnected: true,
              sleepRemainingMs: null,
              lastErrorMessage: undefined,
            },
            pendingUserInputRequests: [],
            pendingEnvVarRequest: null,
            queuedMessages: [
              {
                id: 'runtime-queued-1',
                text: 'Follow up once the draft is ready',
                timestamp: 1_001,
              },
              {
                id: 'runtime-queued-2',
                text: 'Then update the PR description',
                timestamp: 1_002,
              },
            ],
          })),
        },
        sandboxStream: {
          subscribe: vi.fn(
            (
              _input: undefined,
              nextHandlers: {
                onStarted: () => void;
                onData: (event: unknown) => void;
                onError: (error: unknown) => void;
                onComplete: () => void;
              },
            ) => {
              nextHandlers.onStarted();
              return { unsubscribe: unsubscribeMock };
            },
          ),
        },
      },
    });

    render(
      createWrapper(
        <SandboxProvider
          taskId="task-queued"
          url="http://sandbox.test"
          token="token-queued"
          history={hydratedHistory}
          fallback={<div>loading</div>}
        >
          <ProviderStateProbe />
        </SandboxProvider>,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('phase')).toHaveTextContent('running');
      expect(screen.getByTestId('queued-count')).toHaveTextContent('2');
    });
  });

  it('hydrates queued follow-up prompts from getRuntimeState after reconnect even when the runtime is waiting_for_prompt', async () => {
    const unsubscribeMock = vi.fn();

    createTRPCProxyClientMock.mockReturnValue({
      commands: {
        getRuntimeState: {
          query: vi.fn(async () => ({
            status: {
              phase: 'waiting_for_prompt',
              taskStateEvent: 'taskCompleted',
              sessionId: 'session-queued-waiting',
              isConnected: true,
              sleepRemainingMs: 30_000,
              lastErrorMessage: undefined,
            },
            pendingUserInputRequests: [],
            pendingEnvVarRequest: null,
            queuedMessages: [
              {
                id: 'runtime-queued-waiting-1',
                text: 'Follow up after the current turn settles',
                timestamp: 1_101,
              },
            ],
          })),
        },
        sandboxStream: {
          subscribe: vi.fn(
            (
              _input: undefined,
              nextHandlers: {
                onStarted: () => void;
                onData: (event: unknown) => void;
                onError: (error: unknown) => void;
                onComplete: () => void;
              },
            ) => {
              nextHandlers.onStarted();
              return { unsubscribe: unsubscribeMock };
            },
          ),
        },
      },
    });

    render(
      createWrapper(
        <SandboxProvider
          taskId="task-queued-waiting"
          url="http://sandbox.test"
          token="token-queued-waiting"
          history={hydratedHistory}
          fallback={<div>loading</div>}
        >
          <ProviderStateProbe />
        </SandboxProvider>,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('phase')).toHaveTextContent(
        'waiting_for_prompt',
      );
      expect(screen.getByTestId('queued-count')).toHaveTextContent('1');
    });
  });

  it('defaults missing queued follow-up prompts from reconnect runtime state to an empty queue', async () => {
    const unsubscribeMock = vi.fn();

    createTRPCProxyClientMock.mockReturnValue({
      commands: {
        getRuntimeState: {
          query: vi.fn(async () => ({
            status: {
              phase: 'running',
              taskStateEvent: null,
              sessionId: 'session-queued-normalized',
              isConnected: true,
              sleepRemainingMs: null,
              lastErrorMessage: undefined,
            },
            pendingUserInputRequests: [],
            pendingEnvVarRequest: null,
          })),
        },
        sandboxStream: {
          subscribe: vi.fn(
            (
              _input: undefined,
              nextHandlers: {
                onStarted: () => void;
                onData: (event: unknown) => void;
                onError: (error: unknown) => void;
                onComplete: () => void;
              },
            ) => {
              nextHandlers.onStarted();
              return { unsubscribe: unsubscribeMock };
            },
          ),
        },
      },
    });

    render(
      createWrapper(
        <SandboxProvider
          taskId="task-queued-normalized"
          url="http://sandbox.test"
          token="token-queued-normalized"
          history={hydratedHistory}
          fallback={<div>loading</div>}
        >
          <ProviderStateProbe />
        </SandboxProvider>,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('phase')).toHaveTextContent('running');
      expect(screen.getByTestId('queued-count')).toHaveTextContent('0');
    });
  });

  it('hydrates pending env-var requests from getRuntimeState after reconnect', async () => {
    const unsubscribeMock = vi.fn();

    createTRPCProxyClientMock.mockReturnValue({
      commands: {
        getRuntimeState: {
          query: vi.fn(async () => ({
            status: {
              phase: 'waiting_for_user_input',
              taskStateEvent: null,
              sessionId: 'session-env-var',
              isConnected: true,
              sleepRemainingMs: null,
              lastErrorMessage: undefined,
            },
            pendingUserInputRequests: [],
            pendingEnvVarRequest: {
              key: 'env-var-request-runtime',
              ts: 1001,
              variables: [{ name: 'OPENAI_API_KEY' }],
            },
            queuedMessages: [],
          })),
        },
        sandboxStream: {
          subscribe: vi.fn(
            (
              _input: undefined,
              nextHandlers: {
                onStarted: () => void;
                onData: (event: unknown) => void;
                onError: (error: unknown) => void;
                onComplete: () => void;
              },
            ) => {
              nextHandlers.onStarted();
              return { unsubscribe: unsubscribeMock };
            },
          ),
        },
      },
    });

    render(
      createWrapper(
        <SandboxProvider
          taskId="task-env-var"
          url="http://sandbox.test"
          token="token-env-var"
          history={hydratedHistory}
          fallback={<div>loading</div>}
        >
          <ProviderStateProbe />
        </SandboxProvider>,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('phase')).toHaveTextContent(
        'waiting_for_user_input',
      );
      expect(screen.getByTestId('pending-env-var-count')).toHaveTextContent(
        '1',
      );
    });
  });

  it('does not let an empty runtime snapshot clear a history-derived pending env-var request', async () => {
    const unsubscribeMock = vi.fn();

    createTRPCProxyClientMock.mockReturnValue({
      commands: {
        getRuntimeState: {
          query: vi.fn(async () => ({
            status: {
              phase: 'waiting_for_user_input',
              taskStateEvent: null,
              sessionId: 'session-env-var-history',
              isConnected: true,
              sleepRemainingMs: null,
              lastErrorMessage: undefined,
            },
            pendingUserInputRequests: [],
            pendingEnvVarRequest: null,
            queuedMessages: [],
          })),
        },
        sandboxStream: {
          subscribe: vi.fn(
            (
              _input: undefined,
              nextHandlers: {
                onStarted: () => void;
                onData: (event: unknown) => void;
                onError: (error: unknown) => void;
                onComplete: () => void;
              },
            ) => {
              nextHandlers.onStarted();
              return { unsubscribe: unsubscribeMock };
            },
          ),
        },
      },
    });

    render(
      createWrapper(
        <SandboxProvider
          taskId="task-env-var-history"
          url="http://sandbox.test"
          token="token-env-var-history"
          history={{
            data: [
              {
                id: 'env-var-history',
                userId: null,
                userName: null,
                userEmail: null,
                userImageUrl: null,
                taskId: 'task-env-var-history',
                ts: 100,
                createdAt: 100,
                sequence: 1,
                eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
                role: 'tool',
                kind: 'tool_result',
                protocol: 'roomote_runtime',
                contentBlocks: [],
                metadata: null,
                payload: {
                  toolCallId: 'tool-call-env-history',
                  isMcp: true,
                  toolName: 'request_environment_variables',
                  mcpToolName: 'request_environment_variables',
                  output: JSON.stringify({
                    success: true,
                    requestCreated: true,
                    requestedNames: ['OPENAI_API_KEY'],
                  }),
                },
              },
            ],
            isSuccess: true,
            isError: false,
          }}
          fallback={<div>loading</div>}
        >
          <ProviderStateProbe />
        </SandboxProvider>,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('pending-env-var-count')).toHaveTextContent(
        '1',
      );
      expect(screen.getByTestId('phase')).toHaveTextContent(
        'waiting_for_user_input',
      );
    });
  });

  it('backfills a missed pending env-var request when refreshed history arrives after initial hydration', async () => {
    const unsubscribeMock = vi.fn();

    createTRPCProxyClientMock.mockReturnValue({
      commands: {
        getRuntimeState: {
          query: vi.fn(async () => ({
            status: {
              phase: 'waiting_for_user_input',
              taskStateEvent: null,
              sessionId: 'session-env-var-refetch',
              isConnected: true,
              sleepRemainingMs: null,
              lastErrorMessage: undefined,
            },
            pendingUserInputRequests: [],
            pendingEnvVarRequest: null,
            queuedMessages: [],
          })),
        },
        sandboxStream: {
          subscribe: vi.fn(
            (
              _input: undefined,
              nextHandlers: {
                onStarted: () => void;
                onData: (event: unknown) => void;
                onError: (error: unknown) => void;
                onComplete: () => void;
              },
            ) => {
              nextHandlers.onStarted();
              return { unsubscribe: unsubscribeMock };
            },
          ),
        },
      },
    });

    const { rerender } = render(
      createWrapper(
        <SandboxProvider
          taskId="task-env-var-refetch"
          url="http://sandbox.test"
          token="token-env-var-refetch"
          history={hydratedHistory}
          fallback={<div>loading</div>}
        >
          <ProviderStateProbe />
        </SandboxProvider>,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('pending-env-var-count')).toHaveTextContent(
        '0',
      );
      expect(screen.getByTestId('phase')).toHaveTextContent(
        'waiting_for_user_input',
      );
    });

    rerender(
      createWrapper(
        <SandboxProvider
          taskId="task-env-var-refetch"
          url="http://sandbox.test"
          token="token-env-var-refetch"
          history={{
            data: [
              {
                id: 'env-var-refetch',
                userId: null,
                userName: null,
                userEmail: null,
                userImageUrl: null,
                taskId: 'task-env-var-refetch',
                ts: 200,
                createdAt: 200,
                sequence: 2,
                eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
                role: 'tool',
                kind: 'tool_result',
                protocol: 'roomote_runtime',
                contentBlocks: [],
                metadata: null,
                payload: {
                  toolCallId: 'tool-call-env-refetch',
                  isMcp: true,
                  toolName: 'request_environment_variables',
                  mcpToolName: 'request_environment_variables',
                  output: JSON.stringify({
                    success: true,
                    requestCreated: true,
                    requestedNames: ['FOO'],
                  }),
                },
              },
            ],
            isSuccess: true,
            isError: false,
          }}
          fallback={<div>loading</div>}
        >
          <ProviderStateProbe />
        </SandboxProvider>,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('pending-env-var-count')).toHaveTextContent(
        '1',
      );
    });
  });

  it('still hydrates queued messages when a live task status arrives before getRuntimeState resolves', async () => {
    const runtimeStateDeferred = createDeferred<{
      status: {
        phase: 'waiting_for_user_input';
        taskStateEvent: null;
        sessionId: string;
        isConnected: true;
        sleepRemainingMs: number | null;
        lastErrorMessage: undefined;
      };
      pendingUserInputRequests: [];
      queuedMessages: Array<{
        id: string;
        text: string;
        timestamp: number;
      }>;
    }>();
    const unsubscribeMock = vi.fn();
    let handlers:
      | {
          onStarted: () => void;
          onData: (event: unknown) => void;
          onError: (error: unknown) => void;
          onComplete: () => void;
        }
      | undefined;

    createTRPCProxyClientMock.mockReturnValue({
      commands: {
        getRuntimeState: {
          query: vi.fn(() => runtimeStateDeferred.promise),
        },
        sandboxStream: {
          subscribe: vi.fn(
            (
              _input: undefined,
              nextHandlers: {
                onStarted: () => void;
                onData: (event: unknown) => void;
                onError: (error: unknown) => void;
                onComplete: () => void;
              },
            ) => {
              handlers = nextHandlers;
              nextHandlers.onStarted();
              return { unsubscribe: unsubscribeMock };
            },
          ),
        },
      },
    });

    render(
      createWrapper(
        <SandboxProvider
          taskId="task-queued-race"
          url="http://sandbox.test"
          token="token-queued-race"
          history={hydratedHistory}
          fallback={<div>loading</div>}
        >
          <ProviderStateProbe />
        </SandboxProvider>,
      ),
    );

    await waitFor(() => {
      expect(handlers).toBeDefined();
      expect(screen.getByTestId('queued-count')).toHaveTextContent('0');
      expect(screen.getByTestId('phase')).toHaveTextContent('none');
    });

    act(() => {
      handlers?.onData({
        type: 'taskStatus',
        status: {
          phase: 'running',
          taskStateEvent: null,
          sessionId: 'session-queued-race',
          isConnected: true,
          sleepRemainingMs: null,
          lastErrorMessage: undefined,
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('phase')).toHaveTextContent('running');
      expect(screen.getByTestId('queued-count')).toHaveTextContent('0');
    });

    await act(async () => {
      runtimeStateDeferred.resolve({
        status: {
          phase: 'waiting_for_user_input',
          taskStateEvent: null,
          sessionId: 'session-queued-race',
          isConnected: true,
          sleepRemainingMs: 30_000,
          lastErrorMessage: undefined,
        },
        pendingUserInputRequests: [],
        queuedMessages: [
          {
            id: 'runtime-queued-race-1',
            text: 'Hydrate even after the live running status arrives',
            timestamp: 2_001,
          },
        ],
      });
      await runtimeStateDeferred.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId('phase')).toHaveTextContent('running');
      expect(screen.getByTestId('queued-count')).toHaveTextContent('1');
    });
  });

  it('uses task status embedded in usage_update events as fresh live status', async () => {
    const runtimeStateDeferred = createDeferred<{
      status: {
        phase: 'waiting_for_user_input';
        taskStateEvent: null;
        sessionId: string;
        isConnected: true;
        sleepRemainingMs: number | null;
        lastErrorMessage: undefined;
      };
      pendingUserInputRequests: [];
      queuedMessages: [];
    }>();
    const unsubscribeMock = vi.fn();
    let handlers:
      | {
          onStarted: () => void;
          onData: (event: unknown) => void;
          onError: (error: unknown) => void;
          onComplete: () => void;
        }
      | undefined;

    createTRPCProxyClientMock.mockReturnValue({
      commands: {
        getRuntimeState: {
          query: vi.fn(() => runtimeStateDeferred.promise),
        },
        sandboxStream: {
          subscribe: vi.fn(
            (
              _input: undefined,
              nextHandlers: {
                onStarted: () => void;
                onData: (event: unknown) => void;
                onError: (error: unknown) => void;
                onComplete: () => void;
              },
            ) => {
              handlers = nextHandlers;
              nextHandlers.onStarted();
              return { unsubscribe: unsubscribeMock };
            },
          ),
        },
      },
    });

    render(
      createWrapper(
        <SandboxProvider
          taskId="task-usage"
          url="http://sandbox.test"
          token="token-usage"
          history={hydratedHistory}
          fallback={<div>loading</div>}
        >
          <ProviderStateProbe />
        </SandboxProvider>,
      ),
    );

    await waitFor(() => {
      expect(handlers).toBeDefined();
      expect(screen.getByTestId('phase')).toHaveTextContent('none');
    });

    act(() => {
      handlers?.onData({
        type: 'runtimeOutput',
        event: acpUsageUpdate({
          sessionId: 'session-usage',
          ts: 20,
          used: 1_024,
          size: 8_192,
          taskStatus: {
            phase: 'running',
            taskStateEvent: null,
            sessionId: 'session-usage',
            isConnected: true,
            sleepRemainingMs: null,
            lastErrorMessage: undefined,
          },
        }),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('phase')).toHaveTextContent('running');
    });

    await act(async () => {
      runtimeStateDeferred.resolve({
        status: {
          phase: 'waiting_for_user_input',
          taskStateEvent: null,
          sessionId: 'session-usage',
          isConnected: true,
          sleepRemainingMs: 30_000,
          lastErrorMessage: undefined,
        },
        pendingUserInputRequests: [],
        queuedMessages: [],
      });
      await runtimeStateDeferred.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId('phase')).toHaveTextContent('running');
    });

    expect(setLiveTaskStatusMock).toHaveBeenCalledWith(
      'task-usage',
      expect.objectContaining({
        phase: 'running',
      }),
    );
    expect(setLiveTaskStatusMock).not.toHaveBeenCalledWith(
      'task-usage',
      expect.objectContaining({
        phase: 'waiting_for_user_input',
      }),
    );
  });

  it('settles the optimistic message history cache when the live persisted user prompt arrives', async () => {
    const runtimeStateDeferred = createDeferred<{
      status: {
        phase: 'running';
        taskStateEvent: null;
        sessionId: string;
        isConnected: true;
        sleepRemainingMs: null;
        lastErrorMessage: undefined;
      };
      pendingUserInputRequests: [];
      queuedMessages: [];
    }>();
    const unsubscribeMock = vi.fn();
    let handlers:
      | {
          onStarted: () => void;
          onData: (event: unknown) => void;
          onError: (error: unknown) => void;
          onComplete: () => void;
        }
      | undefined;

    createTRPCProxyClientMock.mockReturnValue({
      commands: {
        getRuntimeState: {
          query: vi.fn(() => runtimeStateDeferred.promise),
        },
        sandboxStream: {
          subscribe: vi.fn(
            (
              _input: undefined,
              nextHandlers: {
                onStarted: () => void;
                onData: (event: unknown) => void;
                onError: (error: unknown) => void;
                onComplete: () => void;
              },
            ) => {
              handlers = nextHandlers;
              nextHandlers.onStarted();
              return { unsubscribe: unsubscribeMock };
            },
          ),
        },
      },
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const invalidateQueriesSpy = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockResolvedValue();
    const queryKey = ['tasks.messageEnvelopes', 'task-live-user-prompt'];
    const optimisticEnvelope: TaskMessageEnvelope = {
      id: 'local:client-message-1',
      userId: 'user-optimistic',
      userName: 'Optimistic User',
      userEmail: 'optimistic@example.com',
      userImageUrl: 'https://example.com/optimistic.png',
      taskId: 'task-live-user-prompt',
      ts: 1_000,
      createdAt: 1_000,
      sequence: null,
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      role: 'user',
      kind: 'text',
      protocol: 'roomote_runtime',
      contentBlocks: [{ type: 'text', text: 'keep going' }],
      metadata: { optimistic: true, visibleInTranscript: true },
      payload: {
        clientMessageId: 'client-message-1',
        prompt: [{ type: 'text', text: 'keep going' }],
        content: { type: 'text', text: 'keep going' },
      },
      visibleInTranscript: true,
      text: 'keep going',
    };

    queryClient.setQueryData(queryKey, [optimisticEnvelope]);

    render(
      <QueryClientProvider client={queryClient}>
        <SandboxProvider
          taskId="task-live-user-prompt"
          url="http://sandbox.test"
          token="token-live-user-prompt"
          history={hydratedHistory}
          fallback={<div>loading</div>}
        >
          <ProviderStateProbe />
        </SandboxProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(handlers).toBeDefined();
    });

    vi.useFakeTimers();

    act(() => {
      handlers?.onData({
        type: 'runtimeOutput',
        event: acpUserPrompt('keep going', {
          id: 'persisted:client-message-1',
          ts: 1_100,
          metadata: {
            sessionId: 'session-live-user-prompt',
            sequence: 5,
            userId: 'user-from-metadata',
            userName: 'Metadata User',
            userEmail: 'metadata@example.com',
            userImageUrl: 'https://example.com/metadata.png',
          },
          clientMessageId: 'client-message-1',
        }),
      });
    });

    expect(
      queryClient.getQueryData<TaskMessageEnvelope[]>(queryKey),
    ).toMatchObject([
      {
        id: 'persisted:client-message-1',
        userId: 'user-from-metadata',
        userName: 'Metadata User',
        userEmail: 'metadata@example.com',
        userImageUrl: 'https://example.com/metadata.png',
        metadata: {
          sessionId: 'session-live-user-prompt',
          sequence: 5,
          userId: 'user-from-metadata',
          userName: 'Metadata User',
          userEmail: 'metadata@example.com',
          userImageUrl: 'https://example.com/metadata.png',
        },
        payload: {
          clientMessageId: 'client-message-1',
        },
        text: 'keep going',
      },
    ]);

    expect(invalidateQueriesSpy).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey });
  });
});
