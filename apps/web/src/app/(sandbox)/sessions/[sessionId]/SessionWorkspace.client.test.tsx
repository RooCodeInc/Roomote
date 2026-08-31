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
  searchParamsState,
  routerReplaceMock,
  artifactQueryState,
} = vi.hoisted(() => ({
  useMediaQueryMock: vi.fn(),
  sessionQueryState: { data: null as unknown },
  fastTaskQueryState: { data: null as unknown },
  searchParamsState: { value: '' },
  routerReplaceMock: vi.fn(),
  artifactQueryState: { dataByPath: {} as Record<string, unknown> },
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
          input: { taskId: string; path: string; version?: number },
          options?: Record<string, unknown>,
        ) => ({
          queryKey: ['artifacts', 'byPath', input],
          queryFn: async () => artifactQueryState.dataByPath[input.path],
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
  queriedFastTasks?: Array<
    Pick<SessionInfo['tasks'][number], 'taskId' | 'title'>
  >;
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
    routerReplaceMock.mockClear();
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
      expect(screen.queryByText('Execution details')).not.toBeInTheDocument();
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
    'keeps execution details closed when a sole task arrives after navigation and isMobile=%s',
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
      expect(screen.queryByText('Execution details')).not.toBeInTheDocument();
      expect(routerReplaceMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'opens explicitly selected execution details when isMobile=%s',
    (isMobile) => {
      renderWorkspace({
        isMobile,
        sessionOverride: { tasks: [singleTask] },
        searchParams:
          'utm_source=slack&utm_medium=link&utm_campaign=slack.fast_reply&task=task-1',
      });

      expect(screen.getByText('Execution details')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Close execution details' }),
      ).toBeInTheDocument();
      expect(routerReplaceMock).not.toHaveBeenCalled();

      fireEvent.click(
        screen.getByRole('button', { name: 'Close execution details' }),
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

      expect(await screen.findByText('Execution details')).toBeInTheDocument();
      expect(routerReplaceMock).not.toHaveBeenCalled();
    },
  );

  it('omits the Artifacts section from execution details when empty', () => {
    renderWorkspace({
      isMobile: false,
      selectedTaskId: singleTask.taskId,
      sessionOverride: { tasks: [singleTask] },
    });

    expect(screen.queryByRole('heading', { name: 'Artifacts' })).toBeNull();
    expect(screen.queryByText('No artifacts in this task yet.')).toBeNull();
  });

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

  it.each([false, true])(
    'groups artifacts and opens image and file previews inside execution details when isMobile=%s',
    async (isMobile) => {
      renderWorkspace({
        isMobile,
        selectedTaskId: 'task-1',
        sessionOverride: {
          tasks: [
            {
              taskId: 'task-1',
              title: 'Capture sidebar proof',
              workflow: 'standard',
              state: 'completed',
              repositoryName: 'RooCodeInc/Roomote',
              latestOutput: null,
              inferenceCostMicroUsd: 0,
              canAccessDetails: true,
              latestRun: null,
              artifacts: [
                {
                  id: 'artifact-image',
                  path: 'tmp/capture-visual-proof/sidebar-alignment.png',
                  artifactType: 'visual-proof',
                  contentType: 'image/png',
                  thumbnailUrl: '/api/artifacts/artifact-image/raw?sig=test',
                },
                {
                  id: 'artifact-file',
                  path: 'plans/sidebar.md',
                  artifactType: 'plan',
                  contentType: 'text/markdown',
                },
                {
                  id: 'artifact-image-older',
                  path: 'tmp/capture-visual-proof/sidebar-alignment.png',
                  artifactType: 'visual-proof',
                  contentType: 'image/png',
                  thumbnailUrl:
                    '/api/artifacts/artifact-image-older/raw?sig=test',
                },
                {
                  id: 'artifact-video',
                  path: 'recordings/session-walkthrough.webm',
                  artifactType: 'visual-proof',
                  contentType: 'video/webm',
                  previewUrl: '/api/artifacts/artifact-video/raw?sig=test',
                },
              ],
              pullRequests: [],
            },
          ],
        },
      });

      expect(
        screen.getByRole('heading', { name: 'Screenshots' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: 'Files' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: 'Videos' }),
      ).toBeInTheDocument();

      const imageButton = screen.getByRole('button', {
        name: /Sidebar Alignment/,
      });
      const thumbnail = screen.getByRole('img', { name: 'Sidebar Alignment' });
      expect(thumbnail).toHaveAttribute(
        'src',
        '/api/artifacts/artifact-image/raw?sig=test',
      );
      fireEvent.error(thumbnail);
      expect(
        screen.queryByRole('img', { name: 'Sidebar Alignment' }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sidebar' })).toBeVisible();
      expect(
        screen.queryByText('tmp/capture-visual-proof/sidebar-alignment.png'),
      ).not.toBeInTheDocument();
      const videoPreview = screen.getByLabelText(
        'Video preview: Session Walkthrough',
      );
      expect(videoPreview).toHaveAttribute(
        'src',
        '/api/artifacts/artifact-video/raw?sig=test',
      );
      fireEvent.error(videoPreview);
      expect(
        screen.queryByLabelText('Video preview: Session Walkthrough'),
      ).not.toBeInTheDocument();

      fireEvent.click(imageButton);
      expect(
        await screen.findByText(
          'Artifact preview: tmp/capture-visual-proof/sidebar-alignment.png',
        ),
      ).toBeVisible();
      expect(routerReplaceMock).not.toHaveBeenCalled();

      fireEvent.click(
        screen.getByRole('button', { name: 'Back to artifacts' }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Sidebar' }));
      expect(
        await screen.findByText('Artifact preview: plans/sidebar.md'),
      ).toBeVisible();
      expect(routerReplaceMock).not.toHaveBeenCalled();

      fireEvent.click(
        screen.getByRole('button', { name: 'Back to artifacts' }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: /Session Walkthrough/ }),
      );
      expect(
        await screen.findByText(
          'Artifact preview: recordings/session-walkthrough.webm',
        ),
      ).toBeVisible();
      expect(routerReplaceMock).not.toHaveBeenCalled();
    },
  );

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
});
