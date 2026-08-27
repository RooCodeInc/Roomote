import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { RunStatus, TaskPayloadKind } from '@roomote/types';

const {
  replaceMock,
  recordVisitMock,
  setSidebarVisibleMock,
  useTaskSessionMock,
  usePathnameMock,
  usePageTitleMock,
  useParamsMock,
  useRouterMock,
  useSearchParamsMock,
  useTaskCompletionNotificationMock,
  useTaskMessageEnvelopesMock,
  useTRPCMock,
} = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  recordVisitMock: vi.fn(),
  setSidebarVisibleMock: vi.fn(),
  useTaskSessionMock: vi.fn(),
  usePathnameMock: vi.fn(() => '/task/route-task'),
  usePageTitleMock: vi.fn(),
  useParamsMock: vi.fn(() => ({ taskId: 'route-task' })),
  useRouterMock: vi.fn(() => ({ replace: replaceMock })),
  useSearchParamsMock: vi.fn(() => new URLSearchParams()),
  useTaskCompletionNotificationMock: vi.fn(),
  useTaskMessageEnvelopesMock: vi.fn(),
  useTRPCMock: vi.fn(() => ({
    sandboxSession: {
      byTaskId: {
        queryKey: () => ['sandboxSession.byTaskId'],
      },
    },
    tasks: {
      messageEnvelopes: {
        queryKey: () => ['tasks.messageEnvelopes'],
      },
    },
  })),
}));

vi.mock('next/navigation', () => ({
  useParams: useParamsMock,
  usePathname: usePathnameMock,
  useRouter: useRouterMock,
  useSearchParams: useSearchParamsMock,
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: useTRPCMock,
}));

vi.mock('@/hooks/usePageTitle', () => ({
  usePageTitle: usePageTitleMock,
}));

vi.mock('@/hooks/useRecentTasks', () => ({
  useRecentTasks: () => ({
    recordVisit: recordVisitMock,
  }),
}));

vi.mock('../../use-sandbox-layout', () => ({
  useSandboxLayout: () => ({
    setSidebarVisible: setSidebarVisibleMock,
  }),
}));

vi.mock('./hooks', () => ({
  HistoricalSandboxProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="historical-provider">{children}</div>
  ),
  SandboxProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="sandbox-provider">{children}</div>
  ),
  useTaskSession: useTaskSessionMock,
  useTaskCompletionNotification: useTaskCompletionNotificationMock,
  useTaskMessageEnvelopes: useTaskMessageEnvelopesMock,
}));

vi.mock('./startup', () => ({
  Startup: ({ prompt }: { prompt?: string }) => (
    <div data-testid="startup" data-prompt={prompt}>
      Startup
    </div>
  ),
  ProductTips: () => <div data-testid="product-tips" />,
  SnapshotResumeFailureFooter: () => (
    <div data-testid="snapshot-resume-failure-footer">Startup failure</div>
  ),
}));

vi.mock('./DraftPromptBanner', () => ({
  DraftPromptBanner: () => <div data-testid="draft-prompt-banner" />,
}));

vi.mock('./Header', () => ({
  Header: () => <div data-testid="header" />,
}));

vi.mock('./HistoricalContent', () => ({
  HistoricalContent: ({ footer }: { footer?: ReactNode }) => (
    <div data-testid="historical-content">
      {footer ? (
        <>
          <div data-testid="historical-footer" />
          {footer}
        </>
      ) : null}
    </div>
  ),
}));

vi.mock('./LiveContent', () => ({
  MemoizedLiveContent: () => <div data-testid="live-content" />,
}));

import SandboxPage from './page';

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <SandboxPage />
    </QueryClientProvider>,
  );
}

const baseSession = {
  artifacts: [],
  blank: false,
  taskRun: {
    id: 1,
    sandboxServerUrl: 'http://sandbox.test',
    status: 'running',
    taskPhase: null,
    harness: 'opencode-server',
  },
  draftPrompt: null,
  harness: 'opencode-server',
  hasTransportError: false,
  transportErrorCategory: null,
  isLoading: false,
  isSessionLoading: false,
  isTokenLoading: false,
  prompt: null,
  refreshConnection: vi.fn(),
  sessionState: 'booting',
  task: {
    title: 'Task title',
  },
  taskId: 'task-123',
  token: undefined,
};

describe('SandboxPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  it('warms task history immediately and renders the transcript while booting once history exists', () => {
    useTaskSessionMock.mockReturnValue(baseSession);
    useTaskMessageEnvelopesMock.mockReturnValue({
      data: [{ id: 'msg-1' }],
    });

    renderPage();

    expect(useTaskMessageEnvelopesMock).toHaveBeenCalledWith('route-task', {
      enabled: true,
    });
    expect(screen.getByTestId('sandbox-provider')).toBeInTheDocument();
    expect(screen.getByTestId('live-content')).toBeInTheDocument();
    expect(screen.queryByTestId('startup')).not.toBeInTheDocument();
  });

  it('shows the task workspace skeleton while session metadata is loading', () => {
    useTaskSessionMock.mockReturnValue({
      ...baseSession,
      isSessionLoading: true,
    });
    useTaskMessageEnvelopesMock.mockReturnValue({});

    renderPage();

    expect(screen.getByLabelText('Loading task workspace')).toBeInTheDocument();
  });

  it('keeps the startup surface for booting tasks with no transcript content yet', () => {
    useTaskSessionMock.mockReturnValue(baseSession);
    useTaskMessageEnvelopesMock.mockReturnValue({
      data: [],
    });

    renderPage();

    expect(screen.getByTestId('startup')).toBeInTheDocument();
    expect(screen.getByTestId('product-tips')).toBeInTheDocument();
    expect(screen.queryByTestId('sandbox-provider')).not.toBeInTheDocument();
  });

  it('does not open a live sandbox when the session has no task run', () => {
    useTaskSessionMock.mockReturnValue({
      ...baseSession,
      taskRun: undefined,
      sessionState: 'interactive',
    });
    useTaskMessageEnvelopesMock.mockReturnValue({
      data: [],
    });

    renderPage();

    expect(
      screen.getByText(
        'This task session is still preparing. Refresh the page or try again in a moment.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('sandbox-provider')).not.toBeInTheDocument();
  });

  it('renders paused setup onboarding tasks with the live task surface', () => {
    useTaskSessionMock.mockReturnValue({
      ...baseSession,
      sessionState: 'interactive',
      task: {
        ...baseSession.task,
        workflow: 'setup_onboarding',
      },
      taskRun: {
        ...baseSession.taskRun,
        status: RunStatus.Idle,
        taskPhase: 'waiting_for_prompt',
      },
    });
    useTaskMessageEnvelopesMock.mockReturnValue({
      data: [],
    });

    renderPage();

    expect(screen.getByTestId('sandbox-provider')).toBeInTheDocument();
    expect(screen.getByTestId('live-content')).toBeInTheDocument();
    expect(screen.queryByTestId('historical-provider')).not.toBeInTheDocument();
  });

  it('renders the transcript while booting when the initial prompt is visible even before messages exist', () => {
    useTaskSessionMock.mockReturnValue({
      ...baseSession,
      prompt: {
        id: 'prompt-1',
        visibleInTranscript: true,
      },
    });
    useTaskMessageEnvelopesMock.mockReturnValue({
      data: [],
    });

    renderPage();

    expect(screen.getByTestId('sandbox-provider')).toBeInTheDocument();
    expect(screen.getByTestId('live-content')).toBeInTheDocument();
    expect(screen.queryByTestId('startup')).not.toBeInTheDocument();
  });

  it('keeps historical task content visible for boot failures when transcript history already exists', () => {
    useTaskSessionMock.mockReturnValue({
      ...baseSession,
      taskRun: {
        ...baseSession.taskRun,
        status: RunStatus.Failed,
        payloadKind: TaskPayloadKind.SnapshotResume,
        sourceRunId: 42,
        sourceSnapshotId: 'snapshot-123',
      },
      sessionState: 'boot-failed',
    });
    useTaskMessageEnvelopesMock.mockReturnValue({
      data: [{ id: 'msg-1' }],
    });

    renderPage();

    expect(screen.getByTestId('historical-provider')).toBeInTheDocument();
    expect(screen.getByTestId('historical-content')).toBeInTheDocument();
    expect(screen.getByTestId('historical-footer')).toBeInTheDocument();
    expect(
      screen.getByTestId('snapshot-resume-failure-footer'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('startup')).not.toBeInTheDocument();
  });

  it('keeps the startup surface for first-run boot failures even when the launch prompt is visible', () => {
    useTaskSessionMock.mockReturnValue({
      ...baseSession,
      taskRun: {
        ...baseSession.taskRun,
        status: RunStatus.Failed,
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { environmentId: 'env-1' },
      },
      task: {
        ...baseSession.task,
        model: 'openrouter/openai/gpt-5.4',
      },
      prompt: {
        id: 'prompt-1',
        text: 'Fix the build',
        visibleInTranscript: true,
      },
      draftPrompt: {
        text: 'Change the failed task',
        images: [],
      },
      sessionState: 'boot-failed',
    });
    useTaskMessageEnvelopesMock.mockReturnValue({
      data: [],
    });

    renderPage();

    expect(screen.getByTestId('startup')).toHaveAttribute(
      'data-prompt',
      'Fix the build',
    );
    expect(screen.queryByTestId('product-tips')).not.toBeInTheDocument();
    expect(screen.queryByTestId('draft-prompt-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('historical-content')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('snapshot-resume-failure-footer'),
    ).not.toBeInTheDocument();
  });
});
