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
  sessionQueryState,
  fastTaskQueryState,
  searchParamsState,
  routerReplaceMock,
  artifactQueryState,
  artifactQueryInputs,
} = vi.hoisted(() => ({
  useMediaQueryMock: vi.fn(),
  sessionQueryState: { data: null as unknown },
  fastTaskQueryState: { data: null as unknown },
  searchParamsState: { value: '' },
  routerReplaceMock: vi.fn(),
  artifactQueryState: { dataByPath: {} as Record<string, unknown> },
  artifactQueryInputs: [] as Array<{
    taskId?: string;
    sessionId?: string;
    path: string;
    version?: number;
  }>,
}));

vi.mock('usehooks-ts', () => ({
  useMediaQuery: useMediaQueryMock,
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
          input: {
            taskId?: string;
            sessionId?: string;
            path: string;
            version?: number;
          },
          options?: Record<string, unknown>,
        ) => ({
          queryKey: ['artifacts', 'byPath', input],
          queryFn: async () => {
            artifactQueryInputs.push(input);
            return (
              artifactQueryState.dataByPath[
                `${input.taskId ?? input.sessionId}:${input.path}`
              ] ?? artifactQueryState.dataByPath[input.path]
            );
          },
          ...options,
        }),
      },
    },
  }),
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
  }: {
    taskId: string;
    onClose: () => void;
    onOpenArtifact: (path: string, version?: number) => void;
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
        Close panel
      </button>
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
  pullRequests: [],
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
}: {
  isMobile: boolean;
  children?: ReactNode;
  sessionOverride?: Partial<SessionInfo>;
  queriedTasks?: SessionInfo['tasks'];
  queriedFastTasks?: NonNullable<SessionInfo['taskCards']>;
  selectedTaskId?: string;
  searchParams?: string;
}) {
  useMediaQueryMock.mockReturnValue(!isMobile);
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
  const result = render(
    <QueryClientProvider client={queryClient}>
      <SandboxLayoutProvider>
        <SessionWorkspace session={initialSession}>{children}</SessionWorkspace>
      </SandboxLayoutProvider>
    </QueryClientProvider>,
  );

  return {
    ...result,
    queryClient,
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

  it('orders panel controls as tasks, artifacts, then session info', () => {
    renderWorkspace({
      isMobile: false,
      sessionOverride: { tasks: [singleTask] },
    });

    const tasks = screen.getByRole('button', { name: 'Tasks' });
    const artifacts = screen.getByRole('button', { name: 'Artifacts' });
    const sessionInfo = screen.getByRole('button', { name: 'Session info' });

    expect(tasks.compareDocumentPosition(artifacts)).toBe(
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

  it.each([false, true])(
    'keeps the full task closed when a sole task arrives without a selector and isMobile=%s',
    async (isMobile) => {
      renderWorkspace({
        isMobile,
        sessionOverride: { tasks: [] },
        queriedTasks: [singleTask],
        searchParams:
          'utm_source=slack&utm_medium=link&utm_campaign=slack.fast_reply',
      });

      if (isMobile) {
        fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
      }
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Tasks' })).toBeEnabled();
      });
      expect(screen.getByText('Session transcript')).toBeInTheDocument();
      expect(
        screen.queryByLabelText('Full task task-1'),
      ).not.toBeInTheDocument();
      expect(routerReplaceMock).not.toHaveBeenCalled();
    },
  );

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

      fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
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

  it('shows artifacts created directly by the Session', async () => {
    artifactQueryState.dataByPath['session-1:notes/decision.md'] = {
      id: 'session-artifact',
      taskId: null,
      sessionId: 'session-1',
      path: 'notes/decision.md',
      version: 1,
      artifactType: 'general',
      contentType: 'text/markdown',
      size: 100,
      createdAt: new Date('2026-01-05T00:00:00.000Z'),
      downloadUrl: '/api/artifacts/session-artifact/download',
    };
    renderWorkspace({
      isMobile: false,
      sessionOverride: {
        artifacts: [
          {
            id: 'session-artifact',
            path: 'notes/decision.md',
            version: 1,
            artifactType: 'general',
            contentType: 'text/markdown',
            size: 100,
            createdAt: new Date('2026-01-05T00:00:00.000Z'),
          },
        ],
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }));

    expect(
      screen.getByRole('button', { name: 'Open Decision from Session' }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', { name: 'Open Decision from Session' }),
    );
    await waitFor(() =>
      expect(artifactQueryInputs).toContainEqual({
        sessionId: 'session-1',
        path: 'notes/decision.md',
        version: 1,
      }),
    );
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
        },
        {
          taskId: 'task-3',
          title: 'Second running task',
          latestRun: {
            status: RunStatus.Pending,
            taskPhase: null,
          },
          artifacts: [],
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

  it('automatically opens the Tasks panel when a second task starts on desktop', async () => {
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
          },
          {
            taskId: 'task-3',
            title: 'Second running task',
            latestRun: {
              status: RunStatus.Pending,
              taskPhase: null,
            },
            artifacts: [],
          },
        ],
      );
    });

    expect(
      await screen.findByRole('button', {
        name: 'View coding task: Second running task',
      }),
    ).toBeVisible();
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
