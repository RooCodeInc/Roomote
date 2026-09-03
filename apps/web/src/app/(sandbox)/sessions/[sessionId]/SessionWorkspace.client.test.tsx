import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RunStatus } from '@roomote/types';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { SandboxLayoutContext } from '../../use-sandbox-layout';
import {
  getSessionTaskPanelCapacity,
  SessionHeaderPullRequests,
  SessionWorkspace,
  type SessionInfo,
} from './SessionWorkspace';
import {
  useOpenSessionTaskPanel,
  useOpenSessionTasksPanel,
  useSessionRunningTaskCount,
} from './session-task-panel-context';

const {
  useMediaQueryMock,
  useResizeObserverMock,
  sessionQueryState,
  fastTaskQueryState,
  searchParamsState,
  routerReplaceMock,
  artifactQueryState,
  artifactQueryInputs,
} = vi.hoisted(() => ({
  useMediaQueryMock: vi.fn(),
  useResizeObserverMock: vi.fn(),
  sessionQueryState: { data: null as unknown },
  fastTaskQueryState: { data: null as unknown },
  searchParamsState: { value: '' },
  routerReplaceMock: vi.fn(),
  artifactQueryState: { dataByPath: {} as Record<string, unknown> },
  artifactQueryInputs: [] as Array<{
    taskId: string;
    path: string;
    version?: number;
  }>,
}));

vi.mock('usehooks-ts', () => ({
  useMediaQuery: useMediaQueryMock,
  useResizeObserver: useResizeObserverMock,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: routerReplaceMock }),
  useSearchParams: () => new URLSearchParams(searchParamsState.value),
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
    artifacts: {
      byPath: {
        queryOptions: (
          input: { taskId: string; path: string; version?: number },
          options?: Record<string, unknown>,
        ) => ({
          queryKey: ['artifacts', 'byPath', input],
          queryFn: async () => {
            artifactQueryInputs.push(input);
            return (
              artifactQueryState.dataByPath[`${input.taskId}:${input.path}`] ??
              artifactQueryState.dataByPath[input.path]
            );
          },
          ...options,
        }),
      },
    },
    previewSettings: {
      taskStatus: {
        queryOptions: (
          input: { taskId: string },
          options?: Record<string, unknown>,
        ) => ({
          queryKey: ['previewSettings', 'taskStatus', input],
          queryFn: async () => null,
          ...options,
        }),
        queryKey: (input: { taskId: string }) => [
          'previewSettings',
          'taskStatus',
          input,
        ],
      },
      startSetupTask: {
        mutationOptions: (options?: Record<string, unknown>) => ({
          mutationFn: async () => ({ taskId: 'task-1', alreadyRunning: false }),
          ...options,
        }),
      },
    },
  }),
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ isAdmin: true }),
}));

vi.mock('@/components/tasks/ArtifactViewerContent', () => ({
  ArtifactViewerContent: ({
    artifact,
  }: {
    artifact: { path: string } | null;
  }) => <div>Artifact preview: {artifact?.path}</div>,
}));

vi.mock('./NestedTaskSidePanel', () => ({
  NestedTaskSidePanel: ({
    taskId,
    onClose,
    onOpenArtifact,
    onSelectTask,
    tasks,
  }: {
    taskId: string;
    onClose: () => void;
    onOpenArtifact: (path: string, version?: number) => void;
    onSelectTask: (taskId: string) => void;
    tasks: Array<{ taskId: string }>;
  }) => (
    <div aria-label={`Full task ${taskId}`}>
      Nested panel {taskId}
      <button
        type="button"
        onClick={() => onOpenArtifact('proof/nested.png', 3)}
      >
        Open nested artifact
      </button>
      <button type="button" onClick={onClose}>
        Close panel {taskId}
      </button>
      {tasks.map((task) => (
        <button
          key={task.taskId}
          type="button"
          onClick={() => onSelectTask(task.taskId)}
        >
          Select {task.taskId} from {taskId}
        </button>
      ))}
    </div>
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
  inferenceCostBreakdown: {
    directInferenceCostMicroUsd: 1_000_000,
    tasks: [],
  },
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  status: 'needs_input',
  tasks: [],
};

const singleTask: SessionInfo['tasks'][number] = {
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
  previews: [],
  pullRequests: [],
};

const secondTask: SessionInfo['tasks'][number] = {
  ...singleTask,
  taskId: 'task-2',
  title: 'Review homepage accessibility',
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
  searchParams,
  workspaceWidth,
}: {
  isMobile: boolean;
  children?: ReactNode;
  sessionOverride?: Partial<SessionInfo>;
  queriedTasks?: SessionInfo['tasks'];
  queriedFastTasks?: NonNullable<SessionInfo['taskCards']>;
  selectedTaskId?: string;
  searchParams?: string;
  workspaceWidth?: number;
}) {
  useMediaQueryMock.mockReturnValue(!isMobile);
  let observedWorkspaceWidth = workspaceWidth ?? (isMobile ? 390 : 1024);
  useResizeObserverMock.mockImplementation(() => ({
    width: observedWorkspaceWidth,
    height: 800,
  }));
  searchParamsState.value =
    searchParams ?? (selectedTaskId ? `task=${selectedTaskId}` : '');
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

  const initialSession = { ...session, ...sessionOverride };
  sessionQueryState.data = {
    ...initialSession,
    tasks: queriedTasks ?? initialSession.tasks,
  };
  fastTaskQueryState.data = queriedFastTasks ?? initialSession.taskCards ?? [];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const workspace = () => (
    <QueryClientProvider client={queryClient}>
      <SandboxLayoutProvider>
        <SessionWorkspace session={initialSession}>{children}</SessionWorkspace>
      </SandboxLayoutProvider>
    </QueryClientProvider>
  );
  const result = render(workspace());

  return {
    ...result,
    queryClient,
    resizeWorkspace(width: number) {
      observedWorkspaceWidth = width;
      result.rerender(workspace());
    },
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

function RunningTaskCount() {
  const count = useSessionRunningTaskCount();
  return <output aria-label="Running task count">{count}</output>;
}

function OpenTasksPanel() {
  const openTasksPanel = useOpenSessionTasksPanel();
  return (
    <button type="button" onClick={openTasksPanel ?? undefined}>
      Open tasks
    </button>
  );
}

describe('SessionWorkspace', () => {
  beforeEach(() => {
    routerReplaceMock.mockClear();
    artifactQueryInputs.length = 0;
    artifactQueryState.dataByPath = {
      'tmp/capture-visual-proof/sidebar-alignment.png': {
        id: 'artifact-image',
        taskId: 'task-1',
        path: 'tmp/capture-visual-proof/sidebar-alignment.png',
        version: 1,
        artifactType: 'visual-proof',
        contentType: 'image/png',
        size: 1024,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        downloadUrl: '/api/artifacts/artifact-image/download',
      },
      'plans/sidebar.md': {
        id: 'artifact-file',
        taskId: 'task-1',
        path: 'plans/sidebar.md',
        version: 1,
        artifactType: 'plan',
        contentType: 'text/markdown',
        size: 512,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        downloadUrl: '/api/artifacts/artifact-file/download',
        content: '# Sidebar',
      },
      'recordings/session-walkthrough.webm': {
        id: 'artifact-video',
        taskId: 'task-1',
        path: 'recordings/session-walkthrough.webm',
        version: 1,
        artifactType: 'visual-proof',
        contentType: 'video/webm',
        size: 2048,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        downloadUrl: '/api/artifacts/artifact-video/download',
      },
    };
  });

  it('orders panel controls as tasks, preview, artifacts, then session info', () => {
    renderWorkspace({
      isMobile: false,
      sessionOverride: { tasks: [singleTask] },
    });

    const tasks = screen.getByRole('button', { name: 'Tasks' });
    const preview = screen.getByRole('button', { name: 'Live Preview' });
    const artifacts = screen.getByRole('button', { name: 'Artifacts' });
    const sessionInfo = screen.getByRole('button', { name: 'Session info' });

    expect(tasks.compareDocumentPosition(preview)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(preview.compareDocumentPosition(artifacts)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(artifacts.compareDocumentPosition(sessionInfo)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(artifacts.querySelector('svg')).toHaveClass('lucide-layout-grid');
  });

  it('aggregates task pull requests in the header and removes duplicates', async () => {
    const firstTask = {
      ...singleTask,
      pullRequests: [
        {
          id: 'pr-1',
          url: 'https://github.com/acme/widgets/pull/42',
          number: 42,
          title: 'First PR',
          repository: 'acme/widgets',
          status: 'open',
        },
      ],
    };
    const secondTask = {
      ...singleTask,
      taskId: 'task-2',
      pullRequests: [
        {
          id: 'pr-duplicate-number',
          url: 'https://github.com/acme/widgets/pull/42?duplicate=1',
          number: 42,
          title: 'Duplicate PR',
          repository: 'acme/widgets',
          status: 'open',
        },
        {
          id: 'pr-duplicate-url',
          url: 'https://github.com/acme/widgets/pull/42',
          number: 99,
          title: 'Duplicate URL',
          repository: 'acme/other',
          status: 'open',
        },
        {
          id: 'pr-2',
          url: 'https://github.com/acme/api/pull/7',
          number: 7,
          title: 'Second PR',
          repository: 'acme/api',
          status: 'open',
        },
        {
          id: 'pr-closed',
          url: 'https://github.com/acme/api/pull/8',
          number: 8,
          title: 'Closed PR',
          repository: 'acme/api',
          status: 'closed',
        },
        {
          id: 'pr-merged',
          url: 'https://github.com/acme/api/pull/9',
          number: 9,
          title: 'Merged PR',
          repository: 'acme/api',
          status: 'merged',
        },
      ],
    };

    renderWorkspace({
      isMobile: false,
      children: <SessionHeaderPullRequests />,
      sessionOverride: { tasks: [firstTask, secondTask] },
    });

    expect(screen.queryByText('active')).toBeNull();
    expect(screen.getByRole('link', { name: 'widgets#42' })).toHaveAttribute(
      'href',
      'https://github.com/acme/widgets/pull/42',
    );
    expect(screen.getByRole('link', { name: 'api#7' })).toHaveAttribute(
      'href',
      'https://github.com/acme/api/pull/7',
    );
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('updates header pull requests from refreshed session tasks', async () => {
    const { queryClient } = renderWorkspace({
      isMobile: false,
      children: <SessionHeaderPullRequests />,
      sessionOverride: { tasks: [] },
    });

    expect(screen.queryByRole('link')).toBeNull();
    await waitFor(() =>
      expect(
        queryClient.getQueryState(['sessions', 'byId', session.id])?.status,
      ).toBe('success'),
    );
    act(() => {
      queryClient.setQueryData(['sessions', 'byId', session.id], {
        ...session,
        status: 'active',
        tasks: [
          {
            ...singleTask,
            pullRequests: [
              {
                id: 'pr-new',
                url: 'https://github.com/acme/new/pull/123',
                number: 123,
                title: 'Newly opened PR',
                repository: 'acme/new',
                status: 'open',
              },
            ],
          },
        ],
      });
    });

    expect(
      await screen.findByRole('link', { name: 'new#123' }),
    ).toHaveAttribute('target', '_blank');
    expect(screen.queryByText('active')).toBeNull();
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
    expect(screen.queryByText('needs input')).not.toBeInTheDocument();
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

  it('shows direct and per-task inference costs, including zero-cost tasks', () => {
    renderWorkspace({
      isMobile: false,
      sessionOverride: {
        inferenceCostMicroUsd: 3_500_000,
        inferenceCostBreakdown: {
          directInferenceCostMicroUsd: 1_000_000,
          tasks: [
            {
              taskId: 'task-costly',
              title: 'Implement session totals',
              inferenceCostMicroUsd: 2_500_000,
            },
            {
              taskId: 'task-zero',
              title: 'Zero-cost audit',
              inferenceCostMicroUsd: 0,
            },
          ],
        },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Session info' }));

    const costTrigger = screen.getByRole('button', {
      name: 'Show inference cost breakdown',
    });
    expect(costTrigger).toHaveTextContent('3.50');
    fireEvent.click(costTrigger);

    expect(screen.getByText('Inference cost breakdown')).toBeInTheDocument();
    expect(screen.getByText('Direct session')).toBeInTheDocument();
    expect(screen.getByText('Implement session totals')).toBeInTheDocument();
    expect(screen.getByText('Zero-cost audit')).toBeInTheDocument();
    expect(screen.getByText('$1.00')).toBeInTheDocument();
    expect(screen.getByText('$2.50')).toBeInTheDocument();
    expect(screen.getByText('$0.00')).toBeInTheDocument();
    expect(screen.getByText('$3.50')).toBeInTheDocument();
  });

  it.each([false, true])(
    'lands on the transcript for a normal single-task session URL when isMobile=%s',
    (isMobile) => {
      renderWorkspace({
        isMobile,
        sessionOverride: { tasks: [singleTask] },
        searchParams:
          'utm_source=slack&utm_medium=link&utm_campaign=slack.fast_reply',
      });

      expect(screen.getByText('Session transcript')).toBeInTheDocument();
      expect(
        screen.queryByLabelText('Full task task-1'),
      ).not.toBeInTheDocument();
      expect(routerReplaceMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'keeps the first manually opened panel visible from a normal attributed URL when isMobile=%s',
    (isMobile) => {
      renderWorkspace({
        isMobile,
        sessionOverride: { tasks: [singleTask] },
        searchParams:
          'utm_source=slack&utm_medium=link&utm_campaign=slack.fast_reply',
      });

      if (isMobile) {
        fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
      }
      fireEvent.click(screen.getByRole('button', { name: 'Session info' }));

      expect(
        screen.getByRole('heading', { name: 'Session Info' }),
      ).toBeInTheDocument();
      expect(routerReplaceMock).not.toHaveBeenCalled();
    },
  );

  it('keeps a newly arrived task closed on mobile without a selector', async () => {
    renderWorkspace({
      isMobile: true,
      sessionOverride: { tasks: [] },
      queriedTasks: [singleTask],
      searchParams:
        'utm_source=slack&utm_medium=link&utm_campaign=slack.fast_reply',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Tasks' })).toBeEnabled();
    });
    expect(screen.getByText('Session transcript')).toBeInTheDocument();
    expect(screen.queryByLabelText('Full task task-1')).not.toBeInTheDocument();
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  it('opens as many initial task panels as fit beside the session', async () => {
    renderWorkspace({
      isMobile: false,
      workspaceWidth: 2560,
      sessionOverride: {
        tasks: Array.from({ length: 7 }, (_, index) => ({
          ...singleTask,
          taskId: `task-${index + 1}`,
          title: `Task ${index + 1}`,
        })),
      },
    });

    expect(await screen.findByLabelText('Full task task-1')).toBeVisible();
    for (let index = 2; index <= 6; index += 1) {
      expect(screen.getByLabelText(`Full task task-${index}`)).toBeVisible();
    }
    expect(screen.queryByLabelText('Full task task-7')).toBeNull();
    expect(screen.getByText('Session transcript')).toBeVisible();

    fireEvent.click(
      screen.getByRole('button', { name: 'Select task-7 from task-6' }),
    );

    expect(screen.getByLabelText('Full task task-7')).toBeVisible();
    expect(screen.queryByLabelText('Full task task-6')).toBeNull();
  });

  it('restores task panels after temporarily viewing a utility panel', async () => {
    renderWorkspace({
      isMobile: false,
      workspaceWidth: 1280,
      sessionOverride: { tasks: [singleTask, secondTask] },
    });

    expect(await screen.findByLabelText('Full task task-1')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Session info' }));
    expect(screen.getByRole('heading', { name: 'Session Info' })).toBeVisible();
    expect(screen.queryByLabelText('Full task task-1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close session info' }));
    expect(screen.getByLabelText('Full task task-1')).toBeVisible();
    expect(screen.getByLabelText('Full task task-2')).toBeVisible();
  });

  it('keeps multi-task sessions on the transcript below xl widths', () => {
    renderWorkspace({
      isMobile: false,
      sessionOverride: { tasks: [singleTask, secondTask] },
    });

    expect(screen.getByText('Session transcript')).toBeVisible();
    expect(screen.queryByLabelText('Full task task-1')).toBeNull();
    expect(screen.queryByLabelText('Full task task-2')).toBeNull();
  });

  it('retains task panel selections as workspace capacity changes', async () => {
    const thirdTask = {
      ...singleTask,
      taskId: 'task-3',
      title: 'Add homepage tests',
    };
    const { resizeWorkspace } = renderWorkspace({
      isMobile: false,
      workspaceWidth: 1024,
      sessionOverride: { tasks: [singleTask, secondTask, thirdTask] },
    });

    expect(screen.queryByLabelText('Full task task-1')).toBeNull();
    resizeWorkspace(1600);
    expect(await screen.findByLabelText('Full task task-1')).toBeVisible();
    expect(screen.getByLabelText('Full task task-2')).toBeVisible();
    expect(screen.getByLabelText('Full task task-3')).toBeVisible();

    resizeWorkspace(1024);
    expect(screen.getByLabelText('Full task task-1')).toBeVisible();
    expect(screen.queryByLabelText('Full task task-2')).toBeNull();
    resizeWorkspace(1600);
    expect(screen.getByLabelText('Full task task-2')).toBeVisible();
    expect(screen.getByLabelText('Full task task-3')).toBeVisible();
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  it('opens a newly created task in the rightmost visible panel', async () => {
    const { queryClient } = renderWorkspace({
      isMobile: false,
      workspaceWidth: 1280,
      sessionOverride: { tasks: [singleTask, secondTask] },
    });
    const thirdTask = {
      ...singleTask,
      taskId: 'task-3',
      title: 'Add homepage tests',
    };

    expect(await screen.findByLabelText('Full task task-2')).toBeVisible();
    act(() => {
      queryClient.setQueryData(['sessions', 'byId', session.id], {
        ...session,
        tasks: [singleTask, secondTask, thirdTask],
      });
    });

    expect(await screen.findByLabelText('Full task task-3')).toBeVisible();
    expect(screen.getByLabelText('Full task task-1')).toBeVisible();
    expect(screen.queryByLabelText('Full task task-2')).toBeNull();
  });

  it('opens the first newly created task beside the session on a wide screen', async () => {
    const { queryClient } = renderWorkspace({
      isMobile: false,
      workspaceWidth: 1024,
      sessionOverride: { tasks: [] },
    });

    await waitFor(() =>
      expect(
        queryClient.getQueryState(['sessions', 'byId', session.id])?.status,
      ).toBe('success'),
    );
    act(() => {
      queryClient.setQueryData(['sessions', 'byId', session.id], {
        ...session,
        tasks: [singleTask],
      });
    });

    expect(await screen.findByLabelText('Full task task-1')).toBeVisible();
    expect(screen.getByText('Session transcript')).toBeVisible();
  });

  it('swaps task panels when a title dropdown selects another open task', async () => {
    renderWorkspace({
      isMobile: false,
      workspaceWidth: 1280,
      sessionOverride: { tasks: [singleTask, secondTask] },
    });

    const primary = await screen.findByLabelText('Full task task-1');
    const secondary = screen.getByLabelText('Full task task-2');
    expect(primary.compareDocumentPosition(secondary)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Select task-1 from task-2' }),
    );

    const swappedPrimary = screen.getByLabelText('Full task task-2');
    const swappedSecondary = screen.getByLabelText('Full task task-1');
    expect(swappedPrimary.compareDocumentPosition(swappedSecondary)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it.each([false, true])(
    'opens an explicitly selected full task in the responsive panel when isMobile=%s',
    (isMobile) => {
      renderWorkspace({
        isMobile,
        sessionOverride: { tasks: [singleTask] },
        searchParams:
          'utm_source=slack&utm_medium=link&utm_campaign=slack.fast_reply&task=task-1',
      });

      expect(screen.getByLabelText('Full task task-1')).toBeInTheDocument();
      if (isMobile) {
        expect(
          screen.queryByText('Session transcript'),
        ).not.toBeInTheDocument();
      } else {
        expect(screen.getByText('Session transcript')).toBeInTheDocument();
      }
      expect(routerReplaceMock).not.toHaveBeenCalled();

      fireEvent.click(
        screen.getByRole('button', { name: 'Close panel task-1' }),
      );
      expect(routerReplaceMock).toHaveBeenCalledWith(
        '/sessions/session-1?utm_source=slack&utm_medium=link&utm_campaign=slack.fast_reply',
      );
    },
  );

  it.each([false, true])(
    'opens an explicitly selected task when its details arrive after navigation and isMobile=%s',
    async (isMobile) => {
      renderWorkspace({
        isMobile,
        sessionOverride: { tasks: [] },
        queriedTasks: [singleTask],
        selectedTaskId: singleTask.taskId,
      });

      expect(
        await screen.findByLabelText('Full task task-1'),
      ).toBeInTheDocument();
      expect(routerReplaceMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'opens a Slack-linked Fast task from task cards when isMobile=%s',
    (isMobile) => {
      renderWorkspace({
        isMobile,
        sessionOverride: {
          tasks: [],
          taskSource: 'fast',
          taskCards: [singleTask],
        },
        searchParams:
          'utm_source=slack&utm_medium=link&utm_campaign=fast-delegation&task=task-1',
      });

      expect(screen.getByLabelText('Full task task-1')).toBeInTheDocument();
      if (isMobile) {
        expect(
          screen.queryByText('Session transcript'),
        ).not.toBeInTheDocument();
      } else {
        expect(screen.getByText('Session transcript')).toBeInTheDocument();
      }
      expect(routerReplaceMock).not.toHaveBeenCalled();
    },
  );

  it('disables the Tasks panel button until the session has a task', () => {
    renderWorkspace({ isMobile: false });

    expect(screen.getByRole('button', { name: 'Tasks' })).toBeDisabled();
  });

  it('lists session tasks with delegated task cards', () => {
    renderWorkspace({
      isMobile: false,
      sessionOverride: { tasks: [singleTask] },
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

  it('replaces the URL-selected task when a task card opens at one-panel capacity', () => {
    renderWorkspace({
      isMobile: false,
      workspaceWidth: 1024,
      sessionOverride: { tasks: [singleTask, secondTask] },
      selectedTaskId: singleTask.taskId,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'View coding task: Review homepage accessibility',
      }),
    );

    expect(routerReplaceMock).toHaveBeenCalledWith(
      '/sessions/session-1?task=task-2',
    );
  });

  it('navigates to an empty session Artifacts panel and back', () => {
    renderWorkspace({ isMobile: false });

    fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }));

    expect(
      screen.getByRole('heading', { name: 'Artifacts' }),
    ).toBeInTheDocument();
    expect(screen.getByText('No artifacts in this session yet.')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Close artifacts' }));
    expect(screen.queryByText('No artifacts in this session yet.')).toBeNull();
  });

  it('aggregates latest artifacts per task and preserves duplicate paths across tasks', async () => {
    const sharedPath = 'reports/result.md';
    const firstTask = {
      ...singleTask,
      title: 'First execution',
      artifacts: [
        {
          id: 'first-latest',
          path: sharedPath,
          version: 2,
          artifactType: 'plan' as const,
          contentType: 'text/markdown',
          size: 200,
          createdAt: new Date('2026-01-03T00:00:00.000Z'),
        },
        {
          id: 'first-older',
          path: sharedPath,
          version: 1,
          artifactType: 'plan' as const,
          contentType: 'text/markdown',
          size: 100,
          createdAt: new Date('2026-01-04T00:00:00.000Z'),
        },
      ],
    };
    const secondTask = {
      ...singleTask,
      taskId: 'task-2',
      title: 'Second execution',
      artifacts: [
        {
          id: 'second-latest',
          path: sharedPath,
          version: 1,
          artifactType: 'plan' as const,
          contentType: 'text/markdown',
          size: 300,
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ],
    };
    artifactQueryState.dataByPath[`task-1:${sharedPath}`] = {
      id: 'first-latest',
      taskId: 'task-1',
      path: sharedPath,
      version: 2,
      artifactType: 'plan',
      contentType: 'text/markdown',
      size: 200,
      createdAt: new Date('2026-01-03T00:00:00.000Z'),
      downloadUrl: '/api/artifacts/first-latest/download',
    };
    artifactQueryState.dataByPath[`task-2:${sharedPath}`] = {
      id: 'second-latest',
      taskId: 'task-2',
      path: sharedPath,
      version: 1,
      artifactType: 'plan',
      contentType: 'text/markdown',
      size: 300,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      downloadUrl: '/api/artifacts/second-latest/download',
    };

    renderWorkspace({
      isMobile: false,
      sessionOverride: { tasks: [firstTask, secondTask] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }));

    expect(
      screen.getByRole('button', {
        name: 'Open Result from First execution',
      }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', {
        name: 'Open Result from Second execution',
      }),
    ).toBeVisible();
    expect(screen.getAllByText('Result')).toHaveLength(2);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open Result from First execution',
      }),
    );
    expect(
      await screen.findByText(`Artifact preview: ${sharedPath}`),
    ).toBeVisible();
    expect(artifactQueryInputs).toContainEqual({
      taskId: 'task-1',
      path: sharedPath,
      version: 2,
    });
    expect(routerReplaceMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Back to artifacts' }));
    expect(
      screen.getByRole('button', {
        name: 'Open Result from Second execution',
      }),
    ).toBeVisible();
  });

  it('disables the Live Preview control until a linked task has a live preview', () => {
    renderWorkspace({
      isMobile: false,
      sessionOverride: { tasks: [singleTask] },
    });

    expect(screen.getByRole('button', { name: 'Live Preview' })).toBeDisabled();
  });

  it('collates live previews across tasks into the embedded preview panel', () => {
    const firstTask = {
      ...singleTask,
      title: 'First execution',
      previews: [
        {
          serviceName: 'WEB_APP',
          url: 'https://task-1-web-app.preview.test/dashboard',
          isPrimary: true,
          runId: 11,
        },
      ],
    };
    const secondTask = {
      ...singleTask,
      taskId: 'task-2',
      title: 'Second execution',
      previews: [
        {
          serviceName: 'API',
          url: 'https://task-2-api.preview.test/',
          isPrimary: true,
          runId: 22,
        },
      ],
    };

    renderWorkspace({
      isMobile: false,
      sessionOverride: { tasks: [firstTask, secondTask] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Live Preview' }));

    // The first task's primary preview opens by default, with the task title
    // folded into the service picker since several tasks expose previews.
    expect(
      screen.getByRole('button', {
        name: /Live Preview: Web App - First execution/,
      }),
    ).toBeVisible();
    const iframe = screen.getByTitle('Live Preview');
    expect(iframe).toHaveAttribute(
      'src',
      `/api/auth/preview-iframe?${new URLSearchParams({
        preview_url: 'https://task-1-web-app.preview.test/dashboard',
        task_run_id: '11',
      }).toString()}`,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(screen.queryByTitle('Live Preview')).toBeNull();
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
      previews: [],
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

  it('selects the task from transcript context when exactly one task is running', async () => {
    renderWorkspace({
      isMobile: false,
      children: <OpenTasksPanel />,
      sessionOverride: { taskSource: 'fast', taskCards: [] },
      queriedFastTasks: [
        {
          taskId: 'task-2',
          title: 'Running coding task',
          latestRun: {
            status: RunStatus.Running,
            taskPhase: 'running',
          },
          artifacts: [],
          previews: [],
        },
      ],
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Tasks' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open tasks' }));

    expect(routerReplaceMock).toHaveBeenCalledWith(
      '/sessions/session-1?task=task-2',
    );
    expect(
      screen.queryByRole('button', {
        name: 'View coding task: Running coding task',
      }),
    ).not.toBeInTheDocument();
  });

  it('opens the Tasks panel from transcript context when multiple tasks are running', async () => {
    renderWorkspace({
      isMobile: false,
      children: <OpenTasksPanel />,
      sessionOverride: { taskSource: 'fast', taskCards: [] },
      queriedFastTasks: [
        {
          taskId: 'task-2',
          title: 'First running task',
          latestRun: {
            status: RunStatus.Running,
            taskPhase: 'running',
          },
          artifacts: [],
          previews: [],
        },
        {
          taskId: 'task-3',
          title: 'Second running task',
          latestRun: {
            status: RunStatus.Pending,
            taskPhase: null,
          },
          artifacts: [],
          previews: [],
        },
      ],
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Tasks' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open tasks' }));

    expect(
      screen.getByRole('button', {
        name: 'View coding task: First running task',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'View coding task: Second running task',
      }),
    ).toBeInTheDocument();
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  it('automatically opens a newly started task in a desktop panel', async () => {
    const { queryClient } = renderWorkspace({
      isMobile: false,
      sessionOverride: { taskSource: 'fast', taskCards: [] },
      queriedFastTasks: [
        {
          taskId: 'task-2',
          title: 'First running task',
          latestRun: {
            status: RunStatus.Running,
            taskPhase: 'running',
          },
          artifacts: [],
          previews: [],
        },
      ],
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Tasks' })).toBeEnabled(),
    );

    act(() => {
      queryClient.setQueryData(
        ['fastSessions', 'tasks', session.id],
        [
          {
            taskId: 'task-2',
            title: 'First running task',
            latestRun: {
              status: RunStatus.Running,
              taskPhase: 'running',
            },
            artifacts: [],
            previews: [],
          },
          {
            taskId: 'task-3',
            title: 'Second running task',
            latestRun: {
              status: RunStatus.Pending,
              taskPhase: null,
            },
            artifacts: [],
            previews: [],
          },
        ],
      );
    });

    expect(await screen.findByLabelText('Full task task-3')).toBeVisible();
    expect(screen.queryByLabelText('Full task task-2')).toBeNull();
  });

  it('populates the Artifacts panel from refreshed Fast-session tasks', async () => {
    renderWorkspace({
      isMobile: false,
      sessionOverride: { taskSource: 'fast', taskCards: [] },
      queriedFastTasks: [
        {
          taskId: 'fast-task-1',
          title: 'Fast execution',
          latestRun: null,
          previews: [],
          artifacts: [
            {
              id: 'fast-artifact-1',
              path: 'reports/fast-result.md',
              version: 1,
              artifactType: 'plan',
              contentType: 'text/markdown',
              size: 200,
              createdAt: new Date('2026-01-02T00:00:00.000Z'),
            },
          ],
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }));

    expect(
      await screen.findByRole('button', {
        name: 'Open Fast Result from Fast execution',
      }),
    ).toBeVisible();
    expect(screen.queryByText('No artifacts in this session yet.')).toBeNull();
  });

  it('counts only canonically running tasks and updates when they finish', async () => {
    const task = (
      taskId: string,
      status: RunStatus,
      taskPhase: string | null,
    ): NonNullable<SessionInfo['taskCards']>[number] => ({
      taskId,
      title: taskId,
      latestRun: {
        status,
        taskPhase,
      },
      artifacts: [],
      previews: [],
    });
    const { queryClient } = renderWorkspace({
      isMobile: false,
      children: <RunningTaskCount />,
      sessionOverride: { taskSource: 'fast', taskCards: [] },
      queriedFastTasks: [
        task('booting', RunStatus.Pending, null),
        task('working', RunStatus.Running, 'running'),
        task('waiting', RunStatus.Running, 'waiting_for_user_input'),
        task('finished', RunStatus.Completed, null),
      ],
    });

    await waitFor(() =>
      expect(
        screen.getByRole('status', { name: 'Running task count' }),
      ).toHaveTextContent('2'),
    );
    act(() => {
      queryClient.setQueryData(
        ['fastSessions', 'tasks', session.id],
        [
          task('booting', RunStatus.Completed, null),
          task('working', RunStatus.Idle, 'waiting_for_prompt'),
        ],
      );
    });

    await waitFor(() =>
      expect(
        screen.getByRole('status', { name: 'Running task count' }),
      ).toHaveTextContent('0'),
    );
  });

  it('counts a follow-up turn when the run status remains idle', async () => {
    renderWorkspace({
      isMobile: false,
      children: <RunningTaskCount />,
      queriedTasks: [
        {
          ...singleTask,
          latestRun: {
            id: 1,
            status: RunStatus.Idle,
            taskPhase: 'running',
            error: null,
            result: null,
          },
        },
      ],
    });

    await waitFor(() =>
      expect(
        screen.getByRole('status', { name: 'Running task count' }),
      ).toHaveTextContent('1'),
    );
  });

  it('opens delegated tasks in the existing session side-panel slot', () => {
    renderWorkspace({ isMobile: false, children: <OpenNestedTask /> });

    fireEvent.click(screen.getByRole('button', { name: 'Open child' }));

    expect(screen.getByText('Nested panel child-1')).toBeInTheDocument();
  });

  it.each([false, true])(
    'returns from a nested task artifact to the same nested task when isMobile=%s',
    async (isMobile) => {
      artifactQueryState.dataByPath['child-1:proof/nested.png'] = {
        id: 'nested-artifact',
        taskId: 'child-1',
        path: 'proof/nested.png',
        version: 3,
        artifactType: 'visual-proof',
        contentType: 'image/png',
        size: 200,
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      };
      renderWorkspace({ isMobile, children: <OpenNestedTask /> });

      fireEvent.click(screen.getByRole('button', { name: 'Open child' }));
      fireEvent.click(
        screen.getByRole('button', { name: 'Open nested artifact' }),
      );

      expect(
        await screen.findByText('Artifact preview: proof/nested.png'),
      ).toBeVisible();
      expect(artifactQueryInputs).toContainEqual({
        taskId: 'child-1',
        path: 'proof/nested.png',
        version: 3,
      });

      fireEvent.click(screen.getByRole('button', { name: 'Back to task' }));

      expect(screen.getByText('Nested panel child-1')).toBeInTheDocument();
    },
  );

  it('collapses the right rail when the viewport changes from desktop to mobile', () => {
    const { resizeToMobile } = renderWorkspace({ isMobile: false });

    expect(screen.getByRole('button', { name: 'Session info' })).toBeVisible();

    resizeToMobile();

    expect(screen.queryByRole('button', { name: 'Session info' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
  });
});

describe('getSessionTaskPanelCapacity', () => {
  it.each([
    { width: 700, isMdOrLarger: false, expected: 1 },
    { width: 1024, isMdOrLarger: true, expected: 1 },
    { width: 1280, isMdOrLarger: true, expected: 2 },
    { width: 1920, isMdOrLarger: true, expected: 4 },
    { width: 2560, isMdOrLarger: true, expected: 6 },
    { width: 3840, isMdOrLarger: true, expected: 10 },
  ])(
    'returns $expected task panels for a $width px workspace',
    ({ width, isMdOrLarger, expected }) => {
      expect(getSessionTaskPanelCapacity(width, isMdOrLarger)).toBe(expected);
    },
  );
});
