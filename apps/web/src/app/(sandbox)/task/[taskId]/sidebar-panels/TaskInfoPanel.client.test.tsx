import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { TaskPayloadKind } from '@roomote/types';

const {
  useSandboxMessagesMock,
  useTaskSummaryMock,
  userState,
  showDebugUiState,
} = vi.hoisted(() => ({
  useSandboxMessagesMock: vi.fn(),
  useTaskSummaryMock: vi.fn(),
  userState: {
    isSignedIn: true,
    user: {
      featureFlags: {
        ShowDebugUISetting: false,
      },
    },
  },
  showDebugUiState: {
    isDebugUIVisible: false,
  },
}));

vi.mock('../hooks', () => ({
  useSandboxMessages: useSandboxMessagesMock,
  useTaskSummary: useTaskSummaryMock,
}));

vi.mock('@/hooks/useShowDebugUI', () => ({
  useShowDebugUI: () => ({
    isDebugUIVisible: showDebugUiState.isDebugUIVisible,
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

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@streamdown/code', () => ({
  code: () => null,
}));

vi.mock('@streamdown/mermaid', () => ({
  mermaid: () => null,
}));

vi.mock('@streamdown/cjk', () => ({
  cjk: () => null,
}));

vi.mock('@/components/sandbox', () => ({
  WorkspaceBadge: ({
    environmentId,
    repo,
  }: {
    environmentId?: string;
    repo?: string;
  }) => (
    <span>{environmentId ? `Workspace ${environmentId}` : `Repo ${repo}`}</span>
  ),
  PullRequestBadge: ({
    repo,
    prNumber,
  }: {
    repo: string;
    prNumber: number;
  }) => (
    <span>
      {repo}#{prNumber}
    </span>
  ),
}));

vi.mock('./SidePanelHeader', () => ({
  SidePanelHeader: ({ title }: { title: string }) => <div>{title}</div>,
}));

import { TaskInfoPanel } from './TaskInfoPanel';

const baseTask = {
  id: 'task-1',
  initiatorKind: 'user',
  initiatorUserId: 'user-1',
  title: 'Task title',
  model: 'openrouter/openai/gpt-5.4',
  user: null,
};

const baseCloudJob = {
  payload: {
    environmentId: 'env-1',
  },
  harness: 'opencode-server',
  vendor: 'docker',
  startedAt: new Date('2026-05-01T12:00:00.000Z'),
  error: null,
  payloadKind: TaskPayloadKind.StandardTask,
};

describe('TaskInfoPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userState.isSignedIn = true;
    userState.user.featureFlags.ShowDebugUISetting = false;
    showDebugUiState.isDebugUIVisible = false;

    useSandboxMessagesMock.mockReturnValue({
      messages: [],
      protocol: 'roomote_runtime',
    });

    useTaskSummaryMock.mockReturnValue({
      enabled: false,
      summary: null,
      isLoadingSummary: false,
      errorMessage: null,
      isSummaryStale: false,
      regenerateSummary: vi.fn(),
    });
  });

  it('hides the runtime row by default', () => {
    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={baseCloudJob as never}
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText('Runtime')).not.toBeInTheDocument();
    expect(screen.queryByText('OpenCode')).not.toBeInTheDocument();
  });

  it('shows the inference provider inline after the model name', () => {
    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={baseCloudJob as never}
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('GPT 5.4 via OpenRouter')).toBeInTheDocument();
  });

  it('omits the inference provider suffix for bare model ids', () => {
    render(
      <TaskInfoPanel
        active={true}
        task={{ ...baseTask, model: 'gpt-4' } as never}
        cloudJob={baseCloudJob as never}
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('gpt-4')).toBeInTheDocument();
    expect(screen.queryByText('gpt-4 via Gpt-4')).not.toBeInTheDocument();
  });

  it('shows the sandbox provider row', () => {
    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={baseCloudJob as never}
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Sandbox Provider')).toBeInTheDocument();
    expect(screen.getByText('Local Docker')).toBeInTheDocument();
  });

  it('shows the task model beneath the sandbox provider', () => {
    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={baseCloudJob as never}
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.getByText('GPT 5.4 via OpenRouter')).toBeInTheDocument();
    expect(
      screen.getByText('GPT 5.4 via OpenRouter').closest('span'),
    ).toHaveClass('truncate');
  });

  it('shows the task model thinking level when available', () => {
    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={
          {
            ...baseCloudJob,
            payload: {
              ...baseCloudJob.payload,
              reasoningEffort: 'high',
            },
          } as never
        }
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText('GPT 5.4 via OpenRouter • High'),
    ).toBeInTheDocument();
  });

  it('shows the running inference cost rounded to the nearest cent', () => {
    render(
      <TaskInfoPanel
        active={true}
        task={
          {
            ...baseTask,
            inferenceUsage: {
              eventCount: 2,
              costMicroUsd: 15_000,
            },
          } as never
        }
        cloudJob={baseCloudJob as never}
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Inference Cost')).toBeInTheDocument();
    expect(screen.getByText('0.02')).toBeInTheDocument();
  });

  it('shows zero inference cost before usage is recorded', () => {
    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={baseCloudJob as never}
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Inference Cost')).toBeInTheDocument();
    expect(screen.getByText('0.00')).toBeInTheDocument();
  });

  it('renders normalized task summary errors from the hook', () => {
    useTaskSummaryMock.mockReturnValue({
      enabled: true,
      summary: null,
      isLoadingSummary: false,
      errorMessage:
        'Summary is temporarily unavailable. Try again in a moment.',
      isSummaryStale: false,
      regenerateSummary: vi.fn(),
    });

    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={baseCloudJob as never}
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        'Summary is temporarily unavailable. Try again in a moment.',
      ),
    ).toBeInTheDocument();
  });

  it('uses title case labels for task info titles', () => {
    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={
          {
            ...baseCloudJob,
            prRepo: 'RooCodeInc/Roomote',
            prNumber: 123,
            error: 'Something broke',
          } as never
        }
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Task Info')).toBeInTheDocument();
    expect(screen.getByText('Sandbox Provider')).toBeInTheDocument();
    expect(screen.getByText('Inference Cost')).toBeInTheDocument();
    expect(screen.getByText('Pull Request')).toBeInTheDocument();
    expect(screen.getByText('Started At')).toBeInTheDocument();
    expect(screen.getByText('Started From')).toBeInTheDocument();
    expect(screen.getByText('Last Error')).toBeInTheDocument();
  });

  it('shows the runtime row when debug UI is enabled', () => {
    showDebugUiState.isDebugUIVisible = true;

    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={baseCloudJob as never}
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Runtime')).toBeInTheDocument();
    expect(screen.getByText('OpenCode')).toBeInTheDocument();
  });

  it('keeps the runtime row hidden when the feature flag is off', () => {
    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={baseCloudJob as never}
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText('Runtime')).not.toBeInTheDocument();
  });

  it('keeps the runtime row hidden when the debug UI preference is off', () => {
    userState.user.featureFlags.ShowDebugUISetting = true;

    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={baseCloudJob as never}
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText('Runtime')).not.toBeInTheDocument();
  });

  it('falls back to the session harness when the cloud job harness is absent', () => {
    showDebugUiState.isDebugUIVisible = true;

    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={
          {
            ...baseCloudJob,
            harness: undefined,
          } as never
        }
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('OpenCode')).toBeInTheDocument();
  });

  it('labels Telegram-started tasks from the communication provider payload', () => {
    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={
          {
            ...baseCloudJob,
            payload: {
              ...baseCloudJob.payload,
              communicationProvider: 'telegram',
            },
          } as never
        }
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Telegram')).toBeInTheDocument();
  });

  it('labels Teams-started tasks from the communication provider payload', () => {
    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={
          {
            ...baseCloudJob,
            payload: {
              ...baseCloudJob.payload,
              communicationProvider: 'teams',
            },
          } as never
        }
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Teams')).toBeInTheDocument();
  });

  it('labels GitLab PR-review tasks from the source control provider payload', () => {
    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={
          {
            ...baseCloudJob,
            payloadKind: TaskPayloadKind.GithubPrReview,
            payload: {
              ...baseCloudJob.payload,
              sourceControlProvider: 'gitlab',
            },
          } as never
        }
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('GitLab')).toBeInTheDocument();
  });

  it('labels Gitea PR-review tasks from the source control provider payload', () => {
    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={
          {
            ...baseCloudJob,
            payloadKind: TaskPayloadKind.GithubPrReview,
            payload: {
              ...baseCloudJob.payload,
              sourceControlProvider: 'gitea',
            },
          } as never
        }
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Gitea')).toBeInTheDocument();
  });

  it('labels Azure DevOps PR-review tasks from the source control provider payload', () => {
    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={
          {
            ...baseCloudJob,
            payloadKind: TaskPayloadKind.GithubPrReview,
            payload: {
              ...baseCloudJob.payload,
              sourceControlProvider: 'ado',
            },
          } as never
        }
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Azure DevOps')).toBeInTheDocument();
  });

  it('labels GitHub PR-review tasks when no source control provider is set', () => {
    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={
          {
            ...baseCloudJob,
            payloadKind: TaskPayloadKind.GithubPrReview,
            prRepo: 'RooCodeInc/Roomote',
            prNumber: 42,
          } as never
        }
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('GitHub')).toBeInTheDocument();
  });

  it('defaults to Web when no communication provider is set', () => {
    render(
      <TaskInfoPanel
        active={true}
        task={baseTask as never}
        cloudJob={baseCloudJob as never}
        harness="opencode-server"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Web')).toBeInTheDocument();
  });
});
