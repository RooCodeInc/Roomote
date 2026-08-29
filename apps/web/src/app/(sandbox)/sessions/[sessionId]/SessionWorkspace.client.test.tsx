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
} = vi.hoisted(() => ({
  useMediaQueryMock: vi.fn(),
  sessionQueryState: { data: null as unknown },
  fastTaskQueryState: { data: null as unknown },
  searchParamsState: { value: '' },
}));

vi.mock('usehooks-ts', () => ({
  useMediaQuery: useMediaQueryMock,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
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
  searchParamsState.value = selectedTaskId ? `task=${selectedTaskId}` : '';
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

  it('renders image thumbnails and file links in execution details', () => {
    renderWorkspace({
      isMobile: false,
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
            ],
            pullRequests: [],
          },
        ],
      },
    });

    const imageLink = screen.getByRole('link', {
      name: /Sidebar Alignment.*tmp\/capture-visual-proof\/sidebar-alignment\.png/,
    });
    expect(imageLink).toHaveAttribute(
      'href',
      '/task/task-1/artifacts/tmp%2Fcapture-visual-proof%2Fsidebar-alignment.png?returnTo=%2Fsessions%2Fsession-1%3Ftask%3Dtask-1',
    );
    expect(
      screen.getByRole('img', { name: 'Sidebar Alignment' }),
    ).toHaveAttribute('src', '/api/artifacts/artifact-image/raw?sig=test');
    expect(
      screen.getByRole('link', { name: /Sidebar.*plans\/sidebar\.md/ }),
    ).toHaveAttribute(
      'href',
      '/task/task-1/artifacts/plans%2Fsidebar.md?returnTo=%2Fsessions%2Fsession-1%3Ftask%3Dtask-1',
    );
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
});
