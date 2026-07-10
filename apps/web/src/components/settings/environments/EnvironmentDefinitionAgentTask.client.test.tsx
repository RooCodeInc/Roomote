import type { HTMLAttributes, ReactNode } from 'react';
import { render, renderHook, screen } from '@testing-library/react';

const {
  buildAcpRenderBlocksMock,
  messagesPropsMock,
  sandboxLogsTerminalPropsMock,
  sandboxProviderPropsMock,
  showDebugUiState,
  userState,
  useTaskSessionMock,
  useEnvironmentMock,
  useSandboxLogsMock,
  useSandboxMessagesMock,
  useSandboxTaskStatusDisplayMock,
  usePendingUserInputRequestStateMock,
} = vi.hoisted(() => ({
  buildAcpRenderBlocksMock: vi.fn(() => [
    {
      kind: 'message',
      msg: { id: 'visible-message' },
    },
  ]),
  messagesPropsMock: vi.fn(),
  sandboxLogsTerminalPropsMock: vi.fn(),
  sandboxProviderPropsMock: vi.fn(),
  showDebugUiState: { enabled: false },
  userState: {
    isSignedIn: true,
    user: {
      featureFlags: {
        ShowDebugUISetting: false,
      },
    },
  },
  useTaskSessionMock: vi.fn(),
  useEnvironmentMock: vi.fn(),
  useSandboxLogsMock: vi.fn(),
  useSandboxMessagesMock: vi.fn(),
  useSandboxTaskStatusDisplayMock: vi.fn(),
  usePendingUserInputRequestStateMock: vi.fn(),
}));

vi.mock('@/app/(sandbox)/task/[taskId]/hooks', () => ({
  HistoricalSandboxProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  SandboxProvider: (props: { children: ReactNode }) => {
    sandboxProviderPropsMock(props);

    return <>{props.children}</>;
  },
  useTaskSession: (...args: unknown[]) => useTaskSessionMock(...args),
  useTaskMessageEnvelopes: () => ({
    data: [],
    isPending: false,
    isSuccess: true,
    isError: false,
  }),
  useSandboxMessages: useSandboxMessagesMock,
  useSandboxTaskStatusDisplay: useSandboxTaskStatusDisplayMock,
}));

vi.mock('@/hooks/environments', () => ({
  useEnvironment: (...args: unknown[]) => useEnvironmentMock(...args),
}));

vi.mock('@/app/(sandbox)/task/[taskId]/Messages', () => ({
  Messages: (props: unknown) => {
    messagesPropsMock(props);
    return <div data-testid="messages" />;
  },
}));

vi.mock('@/app/(sandbox)/task/[taskId]/messages/acp/render-blocks', () => ({
  buildAcpRenderBlocks: buildAcpRenderBlocksMock,
}));

vi.mock('@/app/(sandbox)/task/[taskId]/PendingEnvVarRequestPanel', () => ({
  PendingEnvVarRequestPanel: () => <div data-testid="pending-env-vars" />,
}));

vi.mock('@/app/(sandbox)/task/[taskId]/PendingUserInputRequestPanel', () => ({
  PendingUserInputRequestPanel: () => <div data-testid="pending-user-input" />,
  PendingUserInputRequestStateProvider: ({
    children,
  }: {
    children: ReactNode;
  }) => <>{children}</>,
  usePendingUserInputRequestState: () => usePendingUserInputRequestStateMock(),
  useOptionalPendingUserInputRequestState: () =>
    usePendingUserInputRequestStateMock(),
}));

vi.mock('@/app/(sandbox)/task/[taskId]/QueuedMessages', () => ({
  QueuedMessages: () => <div data-testid="queued-messages" />,
}));

vi.mock('@/app/(sandbox)/task/[taskId]/TodoList', () => ({
  TodoList: () => <div data-testid="todo-list" />,
}));

vi.mock('@/app/(sandbox)/task/[taskId]/prompt-input/PromptInput', () => ({
  PromptInput: () => <div data-testid="prompt-input" />,
}));

vi.mock('@/components/sandbox', () => ({
  SandboxLogsTerminal: (props: unknown) => {
    sandboxLogsTerminalPropsMock(props);
    return <div data-testid="sandbox-logs" />;
  },
  TaskStatusIndicator: () => <span>Status</span>,
  useSandboxLogs: (...args: unknown[]) => useSandboxLogsMock(...args),
}));

vi.mock('@/components/system', () => ({
  Spinner: ({ className }: { className?: string }) => (
    <div className={className} data-testid="spinner" />
  ),
}));

vi.mock('@/hooks/useNarrationMode', () => ({
  useNarrationMode: () => ({
    enabled: false,
    isLoading: false,
    isUpdating: false,
    setEnabled: vi.fn(),
  }),
}));

vi.mock('@/hooks/useShowDebugUI', () => ({
  useShowDebugUI: () => ({
    isDebugUIVisible: showDebugUiState.enabled,
    isLoading: false,
    isUpdating: false,
    setDebugUIVisible: vi.fn(),
  }),
}));

vi.mock('@/hooks/useUser', () => ({
  useUser: () =>
    userState.isSignedIn
      ? { isSignedIn: true as const, user: userState.user }
      : { isSignedIn: false as const, user: null, authStatus: 'signed-out' },
}));

vi.mock('@/components/ai-elements', () => ({
  Shimmer: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLSpanElement>) => (
    <span {...props}>{children}</span>
  ),
}));

import {
  EnvironmentDefinitionAgentTaskPanel,
  useEnvironmentDefinitionAgentState,
} from './EnvironmentDefinitionAgentTask';

describe('EnvironmentDefinitionAgentTaskPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildAcpRenderBlocksMock.mockReturnValue([
      {
        kind: 'message',
        msg: { id: 'visible-message' },
      },
    ]);
    useSandboxMessagesMock.mockReturnValue({
      messages: [{ id: 'message-1' }],
    });
    useSandboxTaskStatusDisplayMock.mockReturnValue({
      lastErrorMessage: null,
    });
    userState.isSignedIn = true;
    userState.user.featureFlags.ShowDebugUISetting = false;
    showDebugUiState.enabled = false;
    sandboxLogsTerminalPropsMock.mockReset();
    useSandboxLogsMock.mockReturnValue({
      logs: [],
      error: null,
      isConnected: false,
    });
    usePendingUserInputRequestStateMock.mockReturnValue({
      shouldHidePromptInput: false,
    });
  });

  it('renders pending input requests in the prompt stack', () => {
    render(
      <EnvironmentDefinitionAgentTaskPanel
        session={
          {
            taskId: 'task-1',
            token: 'token',
            isLoading: false,
            sessionState: 'ready',
            taskRun: {
              status: 'running',
              taskPhase: 'running',
              sandboxServerUrl: 'http://localhost:3001',
            },
          } as never
        }
      />,
    );

    const pendingEnvVars = screen.getByTestId('pending-env-vars');
    const todoList = screen.getByTestId('todo-list');
    const pendingUserInput = screen.getByTestId('pending-user-input');
    const queuedMessages = screen.getByTestId('queued-messages');
    const promptInput = screen.getByTestId('prompt-input');

    expect(pendingEnvVars.nextElementSibling).toBe(todoList);
    expect(todoList.nextElementSibling).toBe(pendingUserInput);
    expect(pendingUserInput.nextElementSibling).toBe(queuedMessages);
    expect(queuedMessages.nextElementSibling).toBe(promptInput.parentElement);
  });

  it('passes refreshConnection into the live sandbox provider', () => {
    const refreshConnection = vi.fn();

    render(
      <EnvironmentDefinitionAgentTaskPanel
        session={
          {
            taskId: 'task-1',
            token: 'token',
            refreshConnection,
            isLoading: false,
            sessionState: 'ready',
            taskRun: {
              status: 'running',
              taskPhase: 'running',
              sandboxServerUrl: 'http://localhost:3001',
            },
          } as never
        }
      />,
    );

    expect(sandboxProviderPropsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        url: 'http://localhost:3001',
        token: 'token',
        refreshConnection,
      }),
    );
  });

  it('hides the free-form prompt input while option input requests are active', () => {
    usePendingUserInputRequestStateMock.mockReturnValue({
      shouldHidePromptInput: true,
    });

    render(
      <EnvironmentDefinitionAgentTaskPanel
        session={
          {
            taskId: 'task-1',
            token: 'token',
            isLoading: false,
            sessionState: 'ready',
            taskRun: {
              status: 'running',
              taskPhase: 'running',
              sandboxServerUrl: 'http://localhost:3001',
            },
          } as never
        }
      />,
    );

    expect(screen.getByTestId('pending-user-input')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-input').parentElement).toHaveClass(
      'hidden',
    );
  });

  it('can keep secure env var requests visible without the todo list or prompt input', () => {
    render(
      <EnvironmentDefinitionAgentTaskPanel
        session={
          {
            taskId: 'task-1',
            token: 'token',
            isLoading: false,
            sessionState: 'ready',
            taskRun: {
              status: 'running',
              taskPhase: 'running',
              sandboxServerUrl: 'http://localhost:3001',
            },
          } as never
        }
        showPendingEnvVarRequests={true}
        showQueuedMessages={false}
        showTodoList={false}
        showPromptInput={false}
      />,
    );

    expect(screen.getByTestId('pending-env-vars')).toBeInTheDocument();
    expect(screen.queryByTestId('todo-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('queued-messages')).not.toBeInTheDocument();
    expect(screen.queryByTestId('prompt-input')).not.toBeInTheDocument();
  });

  it('keeps secure env var requests visible for historical sessions', () => {
    render(
      <EnvironmentDefinitionAgentTaskPanel
        session={
          {
            taskId: 'task-1',
            token: undefined,
            isLoading: false,
            sessionState: 'historical',
            taskRun: {
              status: 'completed',
              taskPhase: 'completed',
              sandboxServerUrl: null,
            },
          } as never
        }
        showPendingEnvVarRequests={true}
        showQueuedMessages={false}
        showTodoList={false}
        showPromptInput={false}
      />,
    );

    expect(screen.getByTestId('pending-env-vars')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-user-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('queued-messages')).not.toBeInTheDocument();
    expect(screen.queryByTestId('todo-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('prompt-input')).not.toBeInTheDocument();
  });

  it('forwards narration mode to the message panel when requested', () => {
    render(
      <EnvironmentDefinitionAgentTaskPanel
        session={
          {
            taskId: 'task-1',
            token: 'token',
            isLoading: false,
            sessionState: 'ready',
            taskRun: {
              status: 'running',
              taskPhase: 'running',
              sandboxServerUrl: 'http://localhost:3001',
            },
          } as never
        }
        messageUiOptions={{ displayMode: 'narration' }}
      />,
    );

    expect(messagesPropsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageUiOptions: {
          displayMode: 'narration',
          hideNewTaskAction: true,
        },
      }),
    );
  });

  it('shows a loading placeholder before the first live update arrives', () => {
    useSandboxMessagesMock.mockReturnValue({
      messages: [],
    });
    buildAcpRenderBlocksMock.mockReturnValue([]);

    render(
      <EnvironmentDefinitionAgentTaskPanel
        session={
          {
            taskId: 'task-1',
            token: 'token',
            isLoading: false,
            sessionState: 'ready',
            taskRun: {
              status: 'running',
              taskPhase: 'running',
              sandboxServerUrl: 'http://localhost:3001',
            },
          } as never
        }
        showPendingEnvVarRequests={true}
        showQueuedMessages={false}
        showTodoList={false}
        showPromptInput={false}
      />,
    );

    expect(screen.getByText('Waiting for setup details')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Roomote will stream status updates and secure follow-up requests here as soon as the setup agent reports them.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    expect(screen.queryByTestId('messages')).not.toBeInTheDocument();
    expect(screen.getByTestId('pending-env-vars')).toBeInTheDocument();
  });

  it('keeps the loading placeholder when transcript updates are not yet displayable', () => {
    useSandboxMessagesMock.mockReturnValue({
      messages: [
        {
          id: 'message-hidden',
          kind: 'text',
          role: 'user',
          partial: false,
          sessionId: 'session-1',
          updateType: 'user_prompt',
          text: '$environment-setup',
          data: {},
        },
      ],
    });
    buildAcpRenderBlocksMock.mockReturnValue([]);

    render(
      <EnvironmentDefinitionAgentTaskPanel
        session={
          {
            taskId: 'task-1',
            token: 'token',
            isLoading: false,
            sessionState: 'ready',
            taskRun: {
              status: 'running',
              taskPhase: 'running',
              sandboxServerUrl: 'http://localhost:3001',
            },
          } as never
        }
      />,
    );

    expect(screen.getByText('Waiting for setup details')).toBeInTheDocument();
    expect(screen.queryByTestId('messages')).not.toBeInTheDocument();
  });

  it('treats internal transcript rows as visible when debug UI is enabled', () => {
    useSandboxMessagesMock.mockReturnValue({
      messages: [
        {
          id: 'message-internal',
          kind: 'tool_result',
        },
      ],
    });
    userState.user.featureFlags.ShowDebugUISetting = true;
    showDebugUiState.enabled = true;
    buildAcpRenderBlocksMock.mockImplementation((...args: unknown[]) => {
      const options = args[1] as { showInternalMessages?: boolean } | undefined;

      return options?.showInternalMessages
        ? [
            {
              kind: 'message',
              msg: { id: 'internal-visible' },
            },
          ]
        : [];
    });

    render(
      <EnvironmentDefinitionAgentTaskPanel
        session={
          {
            taskId: 'task-1',
            token: 'token',
            isLoading: false,
            sessionState: 'ready',
            taskRun: {
              status: 'running',
              taskPhase: 'running',
              sandboxServerUrl: 'http://localhost:3001',
            },
          } as never
        }
      />,
    );

    expect(buildAcpRenderBlocksMock).toHaveBeenCalledWith(
      [{ id: 'message-internal', kind: 'tool_result' }],
      expect.objectContaining({
        displayMode: 'default',
        showInternalMessages: true,
      }),
    );
    expect(
      screen.queryByText('Waiting for setup details'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('messages')).toBeInTheDocument();
  });

  it('keeps startup copy visible while booting before visible logs arrive', () => {
    useSandboxLogsMock.mockReturnValue({
      logs: [],
      error: null,
      isConnected: true,
    });

    render(
      <EnvironmentDefinitionAgentTaskPanel
        session={
          {
            taskId: 'task-1',
            token: 'token',
            isLoading: false,
            sessionState: 'booting',
            taskRun: {
              id: 'task-run-1',
              status: 'starting',
              taskPhase: 'starting',
              sandboxServerUrl: 'http://localhost:3001',
            },
          } as never
        }
      />,
    );

    expect(
      screen.getByText('Starting the environment definition agent...'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-logs')).toBeInTheDocument();
    expect(sandboxLogsTerminalPropsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        loadingMessage: 'Starting the environment definition agent...',
      }),
    );
  });

  it('hides startup copy once the agent boot fails', () => {
    useSandboxLogsMock.mockReturnValue({
      logs: [],
      error: null,
      isConnected: true,
    });

    render(
      <EnvironmentDefinitionAgentTaskPanel
        session={
          {
            taskId: 'task-1',
            token: 'token',
            isLoading: false,
            sessionState: 'boot-failed',
            taskRun: {
              id: 'task-run-1',
              status: 'failed',
              taskPhase: 'stopped',
              sandboxServerUrl: 'http://localhost:3001',
            },
          } as never
        }
      />,
    );

    expect(
      screen.queryByText('Starting the environment definition agent...'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Sorry, the agent failed to start. Try again or switch to editing the YAML directly.',
      ),
    ).toBeInTheDocument();
    expect(sandboxLogsTerminalPropsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        loadingMessage: 'The environment definition agent failed to start.',
      }),
    );
  });
});

describe('useEnvironmentDefinitionAgentState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks create mode as succeeded while the setup task is idle once the environment is linked', () => {
    useTaskSessionMock.mockReturnValue({
      taskRun: {
        status: 'idle',
        taskPhase: 'waiting_for_prompt',
        payload: {
          environmentDefinitionId: 'env-1',
        },
      },
    });
    useEnvironmentMock.mockImplementation((id?: string) =>
      id === 'env-1'
        ? {
            data: { id: 'env-1', name: 'Acme Stack' },
            isFetched: true,
            refetch: vi.fn(),
          }
        : {
            data: null,
            isFetched: false,
            refetch: vi.fn(),
          },
    );

    const { result } = renderHook(() =>
      useEnvironmentDefinitionAgentState({
        taskId: 'task-1',
        mode: 'create',
      }),
    );

    expect(result.current.succeeded).toBe(true);
    expect(result.current.failed).toBe(false);
    expect(result.current.taskIsActive).toBe(true);
    expect(result.current.matchingEnvironment).toEqual({
      id: 'env-1',
      name: 'Acme Stack',
    });
  });

  it('does not mark create mode as succeeded when the idle task is still running', () => {
    useTaskSessionMock.mockReturnValue({
      taskRun: {
        status: 'idle',
        taskPhase: 'running',
        payload: {
          environmentDefinitionId: 'env-1',
        },
      },
    });
    useEnvironmentMock.mockImplementation((id?: string) =>
      id === 'env-1'
        ? {
            data: { id: 'env-1', name: 'Acme Stack' },
            isFetched: true,
            refetch: vi.fn(),
          }
        : {
            data: null,
            isFetched: false,
            refetch: vi.fn(),
          },
    );

    const { result } = renderHook(() =>
      useEnvironmentDefinitionAgentState({
        taskId: 'task-1',
        mode: 'create',
      }),
    );

    expect(result.current.succeeded).toBe(false);
    expect(result.current.failed).toBe(false);
    expect(result.current.taskIsActive).toBe(true);
  });

  it('marks create mode as succeeded once the setup task completes', () => {
    useTaskSessionMock.mockReturnValue({
      taskRun: {
        status: 'completed',
        payload: {
          environmentDefinitionId: 'env-1',
        },
      },
    });
    useEnvironmentMock.mockImplementation((id?: string) =>
      id === 'env-1'
        ? {
            data: { id: 'env-1', name: 'Acme Stack' },
            isFetched: true,
            refetch: vi.fn(),
          }
        : {
            data: null,
            isFetched: false,
            refetch: vi.fn(),
          },
    );

    const { result } = renderHook(() =>
      useEnvironmentDefinitionAgentState({
        taskId: 'task-1',
        mode: 'create',
      }),
    );

    expect(result.current.succeeded).toBe(true);
    expect(result.current.failed).toBe(false);
    expect(result.current.taskIsActive).toBe(false);
    expect(result.current.matchingEnvironment).toEqual({
      id: 'env-1',
      name: 'Acme Stack',
    });
  });
});
