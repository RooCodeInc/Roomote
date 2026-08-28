import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { SandboxLayoutContext } from '../../use-sandbox-layout';
import { SessionWorkspace, type SessionInfo } from './SessionWorkspace';
import { useOpenSessionTaskPanel } from './session-task-panel-context';

const {
  useMediaQueryMock,
  sessionQueryState,
  fastTaskQueryState,
  searchParamsRef,
  useTaskSummaryMock,
} = vi.hoisted(() => ({
  useMediaQueryMock: vi.fn(),
  sessionQueryState: { data: null as unknown },
  fastTaskQueryState: { data: null as unknown },
  searchParamsRef: { current: new URLSearchParams() },
  useTaskSummaryMock: vi.fn(),
}));

vi.mock('usehooks-ts', () => ({
  useMediaQuery: useMediaQueryMock,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => searchParamsRef.current,
}));

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@streamdown/code', () => ({ code: () => null }));
vi.mock('@streamdown/mermaid', () => ({ mermaid: () => null }));
vi.mock('@streamdown/cjk', () => ({ cjk: () => null }));

vi.mock('../../task/[taskId]/hooks/use-task-summary', () => ({
  useTaskSummary: useTaskSummaryMock,
}));

vi.mock('@/hooks/task-models/useLaunchTaskModels', () => ({
  useLaunchTaskModels: () => ({
    data: { models: [{ id: 'model-1', displayName: 'Model One' }] },
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    sessions: {
      byId: {
        queryOptions: (
          input: { sessionId: string },
          options?: Record<string, unknown>,
        ) => ({
          queryKey: ['sessions', 'byId', input.sessionId],
          queryFn: async () => sessionQueryState.data,
          ...options,
        }),
      },
    },
    fastSessions: {
      tasks: {
        queryOptions: (
          input: { sessionId: string },
          options?: Record<string, unknown>,
        ) => ({
          queryKey: ['fastSessions', 'tasks', input.sessionId],
          queryFn: async () => fastTaskQueryState.data,
          ...options,
        }),
      },
    },
  }),
}));

vi.mock('./NestedTaskSidePanel', () => ({
  NestedTaskSidePanel: ({ taskId }: { taskId: string }) => (
    <div>Nested panel {taskId}</div>
  ),
}));

vi.mock('../../task/[taskId]/messages/acp/DelegatedTaskCard', () => ({
  DelegatedTaskCard: ({
    taskId,
    prompt,
    onOpen,
  }: {
    taskId: string;
    prompt: string | null;
    onOpen: (taskId: string) => void;
  }) => (
    <button
      type="button"
      aria-label={`View coding task: ${prompt}`}
      onClick={() => onOpen(taskId)}
    >
      {prompt}
    </button>
  ),
}));

const session: SessionInfo = {
  id: 'session-1',
  ownerName: 'Test User',
  ownerEmail: 'test@example.com',
  ownerImageUrl: null,
  surface: 'slack',
  model: 'model-1',
  reasoningEffort: null,
  inferenceCostMicroUsd: 1_000_000,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  status: 'needs_input',
  tasks: [],
};

function SandboxLayoutProvider({ children }: { children: ReactNode }) {
  const [isSidebarVisible, setSidebarVisible] = useState(true);

  return (
    <SandboxLayoutContext.Provider
      value={{
        isSidebarVisible,
        setSidebarVisible,
        toggleSidebar: () => setSidebarVisible((visible) => !visible),
      }}
    >
      {children}
    </SandboxLayoutContext.Provider>
  );
}

function renderWorkspace({
  isMobile,
  children = <div>Session transcript</div>,
  sessionOverride,
  queriedTasks,
  queriedFastTasks,
  selectedTaskId,
}: {
  isMobile: boolean;
  children?: ReactNode;
  sessionOverride?: Partial<SessionInfo>;
  queriedTasks?: SessionInfo['tasks'];
  queriedFastTasks?: Array<
    Pick<SessionInfo['tasks'][number], 'taskId' | 'title'>
  >;
  selectedTaskId?: string;
}) {
  useMediaQueryMock.mockReturnValue(!isMobile);
  let viewportChangeListener: ((event: MediaQueryListEvent) => void) | null =
    null;
  const mediaQuery = {
    matches: isMobile,
    addEventListener: vi.fn(
      (event: string, listener: (event: MediaQueryListEvent) => void) => {
        if (event === 'change') {
          viewportChangeListener = listener;
        }
      },
    ),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockReturnValue(mediaQuery),
  });
  searchParamsRef.current = new URLSearchParams(
    selectedTaskId ? { task: selectedTaskId } : undefined,
  );

  const initialSession = { ...session, ...sessionOverride };
  sessionQueryState.data = {
    ...initialSession,
    tasks: queriedTasks ?? initialSession.tasks,
  };
  fastTaskQueryState.data = queriedFastTasks ?? initialSession.taskCards ?? [];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <SandboxLayoutProvider>
        <SessionWorkspace session={initialSession}>{children}</SessionWorkspace>
      </SandboxLayoutProvider>
    </QueryClientProvider>,
  );

  return {
    ...result,
    resizeToMobile() {
      mediaQuery.matches = true;
      act(() =>
        viewportChangeListener?.({ matches: true } as MediaQueryListEvent),
      );
    },
  };
}

function OpenNestedTask() {
  const openTaskPanel = useOpenSessionTaskPanel();

  return (
    <button type="button" onClick={() => openTaskPanel?.('child-1')}>
      Open child
    </button>
  );
}

describe('SessionWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTaskSummaryMock.mockReturnValue({
      enabled: true,
      summary: null,
      isLoadingSummary: false,
      errorMessage: null,
      isSummaryStale: false,
      regenerateSummary: vi.fn(),
    });
  });

  it('matches the task sidebar replacement behavior and controls on mobile', () => {
    renderWorkspace({ isMobile: true });

    expect(screen.getByText('Session transcript')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chat' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Session info' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));

    expect(screen.getByRole('button', { name: 'Chat' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Session info' }));

    expect(screen.queryByText('Session transcript')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Session Info' }),
    ).toBeInTheDocument();
    expect(screen.getByText('needs input')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Close session info' }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));

    expect(
      screen.getByRole('button', { name: 'Close session info' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close session info' }));

    expect(screen.getByText('Session transcript')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Session info' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Session info' }));

    expect(
      screen.getByRole('heading', { name: 'Session Info' }),
    ).toBeInTheDocument();
  });

  it('preserves the split panel and close control on desktop', () => {
    renderWorkspace({ isMobile: false });

    expect(screen.getByRole('button', { name: 'Session info' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Session info' }));

    expect(screen.getByText('Session transcript')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Close session info' }),
    ).toBeInTheDocument();
  });

  it('disables the Tasks panel button until the session has a task', () => {
    renderWorkspace({ isMobile: false });

    expect(screen.getByRole('button', { name: 'Tasks' })).toBeDisabled();
  });

  it('lists session tasks with delegated task cards', () => {
    renderWorkspace({
      isMobile: false,
      sessionOverride: {
        tasks: [
          {
            taskId: 'task-1',
            title: 'Update homepage background',
            workflow: 'standard',
            state: 'active',
            repositoryName: null,
            latestOutput: null,
            inferenceCostMicroUsd: 0,
            canAccessDetails: true,
            latestRun: null,
            artifacts: [],
            pullRequests: [],
          },
        ],
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));

    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'View coding task: Update homepage background',
      }),
    );

    expect(screen.getByText('Nested panel task-1')).toBeInTheDocument();
  });

  it('enables and populates the Tasks panel from refreshed session tasks', async () => {
    const delegatedTask = {
      taskId: 'task-2',
      title: 'Refreshed coding task',
      workflow: 'standard',
      state: 'active',
      repositoryName: null,
      latestOutput: null,
      inferenceCostMicroUsd: 0,
      canAccessDetails: true,
      latestRun: null,
      artifacts: [],
      pullRequests: [],
    };
    renderWorkspace({
      isMobile: false,
      sessionOverride: { taskSource: 'fast', taskCards: [] },
      queriedFastTasks: [delegatedTask],
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Tasks' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));

    expect(
      screen.getByRole('button', {
        name: 'View coding task: Refreshed coding task',
      }),
    ).toBeInTheDocument();
  });

  it('opens delegated tasks in the existing session side-panel slot', () => {
    renderWorkspace({ isMobile: false, children: <OpenNestedTask /> });

    fireEvent.click(screen.getByRole('button', { name: 'Open child' }));

    expect(screen.getByText('Nested panel child-1')).toBeInTheDocument();
  });

  it('collapses the right rail when the viewport changes from desktop to mobile', () => {
    const { resizeToMobile } = renderWorkspace({ isMobile: false });

    expect(screen.getByRole('button', { name: 'Session info' })).toBeVisible();

    resizeToMobile();

    expect(screen.queryByRole('button', { name: 'Session info' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
  });

  it('shows a generated summary in execution details', () => {
    useTaskSummaryMock.mockReturnValue({
      enabled: true,
      summary: 'The task updated the session sidebar and verified the result.',
      isLoadingSummary: false,
      errorMessage: null,
      isSummaryStale: false,
      regenerateSummary: vi.fn(),
    });

    renderWorkspace({
      isMobile: false,
      selectedTaskId: 'task-1',
      sessionOverride: { tasks: [createSessionTask()] },
    });

    expect(
      screen.getByRole('heading', { name: 'Summary' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'The task updated the session sidebar and verified the result.',
      ),
    ).toBeInTheDocument();
    expect(useTaskSummaryMock).toHaveBeenCalledWith('task-1');
  });

  it('shows loading and retryable error states for task summaries', () => {
    useTaskSummaryMock.mockReturnValue({
      enabled: true,
      summary: null,
      isLoadingSummary: true,
      errorMessage: null,
      isSummaryStale: false,
      regenerateSummary: vi.fn(),
    });
    const task = createSessionTask();
    const { rerender } = renderWorkspace({
      isMobile: false,
      selectedTaskId: task.taskId,
      sessionOverride: { tasks: [task] },
    });

    expect(
      screen.getByLabelText('Generating task summary'),
    ).toBeInTheDocument();

    const regenerateSummary = vi.fn();
    useTaskSummaryMock.mockReturnValue({
      enabled: true,
      summary: null,
      isLoadingSummary: false,
      errorMessage:
        'Summary is temporarily unavailable. Try again in a moment.',
      isSummaryStale: false,
      regenerateSummary,
    });
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <SandboxLayoutProvider>
          <SessionWorkspace session={{ ...session, tasks: [task] }}>
            <div>Session transcript</div>
          </SessionWorkspace>
        </SandboxLayoutProvider>
      </QueryClientProvider>,
    );

    expect(
      screen.getByText(
        'Summary is temporarily unavailable. Try again in a moment.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(regenerateSummary).toHaveBeenCalledOnce();
  });

  it('allows a stale generated summary to be refreshed', () => {
    const regenerateSummary = vi.fn();
    useTaskSummaryMock.mockReturnValue({
      enabled: true,
      summary: 'The execution completed its original scope.',
      isLoadingSummary: false,
      errorMessage: null,
      isSummaryStale: true,
      regenerateSummary,
    });

    renderWorkspace({
      isMobile: false,
      selectedTaskId: 'task-1',
      sessionOverride: { tasks: [createSessionTask()] },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh summary' }));
    expect(regenerateSummary).toHaveBeenCalledOnce();
  });

  it('falls back gracefully while an execution has too little activity', () => {
    renderWorkspace({
      isMobile: false,
      selectedTaskId: 'task-1',
      sessionOverride: { tasks: [createSessionTask()] },
    });

    expect(
      screen.getByText('A summary will appear as this execution progresses.'),
    ).toBeInTheDocument();
  });

  it('uses the latest execution output when a generated summary is unavailable', () => {
    renderWorkspace({
      isMobile: false,
      selectedTaskId: 'task-1',
      sessionOverride: {
        tasks: [
          createSessionTask({
            latestOutput: 'Implemented the sidebar summary and ran the tests.',
          }),
        ],
      },
    });

    expect(
      screen.getByText('Implemented the sidebar summary and ran the tests.'),
    ).toBeInTheDocument();
  });

  it('shows a terminal empty state when a completed execution has no summary', () => {
    useTaskSummaryMock.mockReturnValue({
      enabled: false,
      summary: null,
      isLoadingSummary: false,
      errorMessage: null,
      isSummaryStale: false,
      regenerateSummary: vi.fn(),
    });

    renderWorkspace({
      isMobile: false,
      selectedTaskId: 'task-1',
      sessionOverride: {
        tasks: [createSessionTask({ state: 'completed' })],
      },
    });

    expect(
      screen.getByText('No summary is available for this execution yet.'),
    ).toBeInTheDocument();
  });

  it('does not request a summary for an inaccessible execution', () => {
    renderWorkspace({
      isMobile: false,
      selectedTaskId: 'task-1',
      sessionOverride: {
        tasks: [createSessionTask({ canAccessDetails: false })],
      },
    });

    expect(
      screen.getByText('Execution details require task access.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Summary' })).toBeNull();
    expect(useTaskSummaryMock).not.toHaveBeenCalled();
  });
});

function createSessionTask(
  overrides?: Partial<SessionInfo['tasks'][number]>,
): SessionInfo['tasks'][number] {
  return {
    taskId: 'task-1',
    title: 'Summarize session execution',
    workflow: 'standard',
    state: 'active',
    repositoryName: 'RooCodeInc/Roomote',
    latestOutput: null,
    inferenceCostMicroUsd: 0,
    canAccessDetails: true,
    latestRun: null,
    artifacts: [],
    pullRequests: [],
    ...overrides,
  };
}
