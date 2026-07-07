import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ButtonHTMLAttributes,
  ComponentProps,
  HTMLAttributes,
  ReactNode,
  SVGProps,
} from 'react';

import { getSetupStepDefinition } from './types';

const {
  cancelTaskMutateMock,
  environmentDefinitionAgentTaskPanelMock,
  queryKeyMock,
  resetSelectionMutateMock,
  startTaskMutateMock,
  toastErrorMock,
  useEnvironmentDefinitionAgentStateMock,
} = vi.hoisted(() => ({
  cancelTaskMutateMock: vi.fn().mockResolvedValue(undefined),
  environmentDefinitionAgentTaskPanelMock: vi.fn(),
  queryKeyMock: vi.fn(() => ['setupNew', 'status']),
  resetSelectionMutateMock: vi.fn().mockResolvedValue(undefined),
  startTaskMutateMock: vi.fn().mockResolvedValue({
    taskId: 'task-started',
    startedAt: '2026-03-25T10:00:00.000Z',
  }),
  toastErrorMock: vi.fn(),
  useEnvironmentDefinitionAgentStateMock: vi.fn(),
}));

const ONBOARDING_AGENT_STEP_TITLE =
  getSetupStepDefinition('onboarding-agent').title;

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
  },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setupNew: {
      startOnboardingTask: {
        mutationOptions: (options = {}) => ({
          mutationFn: startTaskMutateMock,
          ...options,
        }),
      },
      cancelOnboardingTask: {
        mutationOptions: (options = {}) => ({
          mutationFn: cancelTaskMutateMock,
          ...options,
        }),
      },
      resetSelection: {
        mutationOptions: (options = {}) => ({
          mutationFn: resetSelectionMutateMock,
          ...options,
        }),
      },
      status: {
        queryKey: queryKeyMock,
      },
    },
  }),
}));

vi.mock('@/components/system', () => ({
  ArrowLeft: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  ArrowRight: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Button: ({
    children,
    ...props
  }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={props.type ?? 'button'} {...props}>
      {children}
    </button>
  ),
  Card: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  CardContent: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  CardDescription: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props}>{children}</p>
  ),
  CardFooter: ({
    children,
    ...props
  }: {
    children: ReactNode;
    align?: string;
  } & HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  CardHeader: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  CardTitle: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLHeadingElement>) => (
    <h2 {...props}>{children}</h2>
  ),
  Dialog: ({
    children,
    open,
  }: {
    children: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => <div>{open ? children : null}</div>,
  DialogContent: ({
    children,
    ...props
  }: {
    children: ReactNode;
    size?: string;
  } & HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogDescription: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props}>{children}</p>
  ),
  DialogFooter: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogHeader: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogTitle: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLHeadingElement>) => (
    <h2 {...props}>{children}</h2>
  ),
  Loader2: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Skeleton: (props: HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  Slack: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
}));

vi.mock('@/components/sandbox', () => ({
  TaskStatusIndicator: ({ status }: { status?: string }) => <div>{status}</div>,
}));

vi.mock(
  '@/components/settings/environments/EnvironmentDefinitionAgentTask',
  () => ({
    EnvironmentDefinitionAgentTaskPanel: (props: Record<string, unknown>) => {
      environmentDefinitionAgentTaskPanelMock(props);
      return <div>task panel</div>;
    },
    useEnvironmentDefinitionAgentState: (...args: unknown[]) =>
      useEnvironmentDefinitionAgentStateMock(...args),
  }),
);

vi.mock('./StepCompletedBadge', () => ({
  StepCompletedBadge: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock('./StepTitle', () => ({
  StepTitle: ({ text }: { text: string }) => <h1>{text}</h1>,
}));

import { StepOnboardingAgent } from './StepOnboardingAgent';

function renderStep(
  overrides: Partial<ComponentProps<typeof StepOnboardingAgent>> = {},
) {
  const queryClient = new QueryClient();
  const invalidateQueriesSpy = vi.spyOn(queryClient, 'invalidateQueries');

  const props: ComponentProps<typeof StepOnboardingAgent> = {
    selectedRepositories: [{ id: 'repo-1', fullName: 'acme/api' }],
    onboardingTaskId: null,
    onboardingTaskStartedAt: null,
    slackChannel: null,
    slackThreadTs: null,
    chatHandoffProvider: null,
    onboardingFinished: false,
    onContinue: vi.fn(),
    onDoLater: vi.fn(),
    onReturnToSelection: vi.fn(),
    onStartFailure: vi.fn(),
    onTaskStarted: vi.fn(),
    ...overrides,
  };

  render(
    <QueryClientProvider client={queryClient}>
      <StepOnboardingAgent {...props} />
    </QueryClientProvider>,
  );

  return {
    props,
    invalidateQueriesSpy,
  };
}

describe('StepOnboardingAgent', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    startTaskMutateMock.mockResolvedValue({
      taskId: 'task-started',
      startedAt: '2026-03-25T10:00:00.000Z',
    });
    cancelTaskMutateMock.mockResolvedValue(undefined);
    resetSelectionMutateMock.mockResolvedValue(undefined);
    useEnvironmentDefinitionAgentStateMock.mockReturnValue({
      session: {
        cloudJob: {
          status: 'running',
          taskPhase: 'running',
        },
      },
      succeeded: false,
      failed: false,
      matchingEnvironment: null,
    });
  });

  it('lands on the setup console immediately and auto-starts the Slack handoff', async () => {
    const { props, invalidateQueriesSpy } = renderStep();

    expect(
      screen.getByRole('heading', {
        name: ONBOARDING_AGENT_STEP_TITLE,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Roomote is starting your setup task.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Do this later' }));
    expect(props.onDoLater).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(startTaskMutateMock).toHaveBeenCalledTimes(1);
    });

    expect(props.onTaskStarted).toHaveBeenCalledWith('task-started');
    await waitFor(() => {
      expect(invalidateQueriesSpy).toHaveBeenCalledWith({
        queryKey: ['setupNew', 'status'],
      });
    });
    expect(await screen.findByText('task panel')).toBeInTheDocument();
    expect(environmentDefinitionAgentTaskPanelMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        showHeader: false,
        showPendingEnvVarRequests: true,
        showQueuedMessages: false,
        showTodoList: false,
        showPromptInput: false,
        messageUiOptions: { displayMode: 'narration' },
      }),
    );
  });

  it('shows retry UI when the task start fails, then retries successfully', async () => {
    startTaskMutateMock
      .mockRejectedValueOnce(new Error('Slack DM failed'))
      .mockResolvedValueOnce({
        taskId: 'task-retry',
        startedAt: '2026-03-25T11:00:00.000Z',
      });

    const { props } = renderStep();

    expect(
      await screen.findByText('Setup could not start'),
    ).toBeInTheDocument();
    expect(props.onStartFailure).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith('Slack DM failed');

    fireEvent.click(screen.getByRole('button', { name: 'Retry setup' }));

    await waitFor(() => {
      expect(startTaskMutateMock).toHaveBeenCalledTimes(2);
    });
    expect(props.onTaskStarted).toHaveBeenCalledWith('task-retry');
    expect(await screen.findByText('task panel')).toBeInTheDocument();
  });

  it('lets admins defer setup while the agent task is still running', () => {
    const { props } = renderStep({
      onboardingTaskId: 'task-running',
      onboardingTaskStartedAt: '2026-03-25T10:00:00.000Z',
    });

    expect(screen.getByText('Roomote is working...')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Continue' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Do this later' }));

    expect(props.onDoLater).toHaveBeenCalledTimes(1);
  });

  it('lets admins change repositories from the failed start state', async () => {
    startTaskMutateMock.mockRejectedValueOnce(new Error('Slack DM failed'));

    const { props, invalidateQueriesSpy } = renderStep();

    expect(
      await screen.findByText('Setup could not start'),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /Change repositories/i }),
    );

    await waitFor(() => {
      expect(resetSelectionMutateMock).toHaveBeenCalledTimes(1);
    });

    expect(cancelTaskMutateMock).not.toHaveBeenCalled();
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: ['setupNew', 'status'],
    });
    expect(props.onReturnToSelection).toHaveBeenCalledTimes(1);
  });

  it('shows the setup summary and enables continue after setup succeeds', () => {
    useEnvironmentDefinitionAgentStateMock.mockReturnValue({
      session: {
        cloudJob: {
          status: 'completed',
          taskPhase: 'done',
        },
      },
      succeeded: true,
      failed: false,
      matchingEnvironment: {
        id: 'env-1',
        name: 'Acme Stack',
      },
    });

    const { props } = renderStep({
      onboardingTaskId: 'task-1',
      onboardingTaskStartedAt: '2026-03-25T10:00:00.000Z',
      slackChannel: 'D123',
      slackThreadTs: '171.0001',
    });

    expect(screen.getByText('Acme Stack is ready.')).toBeInTheDocument();
    expect(screen.getByText(/Selected (repo|repos):/i)).toHaveTextContent(
      'Selected repos: acme/api',
    );
    expect(
      screen.queryByText(/Slack handoff started at/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Slack is linked to this setup task/i),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });

  it('shows the web-only setup console copy for in-flight tasks without Slack handoff metadata', () => {
    renderStep({
      onboardingTaskId: 'task-legacy',
      onboardingTaskStartedAt: '2026-03-25T10:00:00.000Z',
    });

    expect(
      screen.getByRole('heading', {
        name: ONBOARDING_AGENT_STEP_TITLE,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Roomote is working...')).toBeInTheDocument();
    expect(
      screen.getByText(/Watch below as Roomote does its thing/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Roomote will update you on Slack/i),
    ).not.toBeInTheDocument();
    expect(screen.getByText('task panel')).toBeInTheDocument();
  });

  it('keeps the defer action visible when the agent task fails', () => {
    useEnvironmentDefinitionAgentStateMock.mockReturnValue({
      session: {
        cloudJob: {
          status: 'failed',
          taskPhase: 'failed',
        },
      },
      succeeded: false,
      failed: true,
      matchingEnvironment: null,
    });

    const { props } = renderStep({
      onboardingTaskId: 'task-failed',
      onboardingTaskStartedAt: '2026-03-25T10:00:00.000Z',
    });

    expect(
      screen.getByText(
        'Setup needs attention before Roomote can finish your first environment.',
      ),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('button', { name: /Change repos or guidance/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Continue' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Do this later' }));

    expect(props.onDoLater).toHaveBeenCalledTimes(1);
  });

  it('shows the Slack handoff copy for tasks with Slack metadata', () => {
    renderStep({
      onboardingTaskId: 'task-slack',
      onboardingTaskStartedAt: '2026-03-25T10:00:00.000Z',
      slackChannel: 'D123',
      slackThreadTs: '171.0001',
    });

    expect(
      screen.getByText(/Roomote will update you on Slack/i),
    ).toBeInTheDocument();
  });

  it('can cancel the active task and reset the repository selection', async () => {
    const { props, invalidateQueriesSpy } = renderStep({
      onboardingTaskId: 'task-1',
      onboardingTaskStartedAt: '2026-03-25T10:00:00.000Z',
    });

    fireEvent.click(
      screen.getAllByRole('button', { name: /Change repos or guidance/i })[0]!,
    );

    expect(screen.getByText('Change repositories?')).toBeInTheDocument();

    fireEvent.click(
      screen.getAllByRole('button', { name: 'Change repositories' }).at(-1)!,
    );

    await waitFor(() => {
      expect(cancelTaskMutateMock).toHaveBeenCalledTimes(1);
    });
    expect(resetSelectionMutateMock).toHaveBeenCalledTimes(1);
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: ['setupNew', 'status'],
    });
    expect(props.onReturnToSelection).toHaveBeenCalledTimes(1);
  });
});
