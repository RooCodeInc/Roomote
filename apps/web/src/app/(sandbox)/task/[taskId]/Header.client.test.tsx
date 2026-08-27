import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const {
  useSandboxLayoutMock,
  useTRPCMock,
  updateTitleMutationMock,
  parentSessionQueryMock,
  featureFlagState,
} = vi.hoisted(() => ({
  useSandboxLayoutMock: vi.fn(),
  useTRPCMock: vi.fn(),
  updateTitleMutationMock: vi.fn(async () => undefined),
  parentSessionQueryMock: vi.fn(),
  featureFlagState: { sessionsUiEnabled: false },
}));

vi.mock('../../use-sandbox-layout', () => ({
  useSandboxLayout: useSandboxLayoutMock,
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: useTRPCMock,
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({
    featureFlags: { sessions_ui: featureFlagState.sessionsUiEnabled },
  }),
}));

vi.mock('./TaskSessionReadTracker', () => ({
  TaskSessionReadTracker: () => null,
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

import { Header } from './Header';

function renderHeader(
  sessionOverride?: Partial<Parameters<typeof Header>[0]['session']>,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const session = {
    taskRun: {
      payload: {
        environmentId: 'env-1',
      },
      harness: 'opencode-server',
    },
    harness: 'opencode-server',
    task: {
      title: 'Task title',
    },
    taskId: 'task-123',
    ...sessionOverride,
  } as Parameters<typeof Header>[0]['session'];

  const result = render(
    <QueryClientProvider client={queryClient}>
      <Header session={session} />
    </QueryClientProvider>,
  );

  return { ...result, queryClient };
}

describe('Header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    featureFlagState.sessionsUiEnabled = false;
    parentSessionQueryMock.mockResolvedValue({
      sessionId: 'session-1',
      title: 'Parent Session',
    });

    useSandboxLayoutMock.mockReturnValue({
      isSidebarVisible: true,
      toggleSidebar: vi.fn(),
    });

    useTRPCMock.mockReturnValue({
      sandboxSession: {
        byTaskId: {
          queryKey: ({ taskId }: { taskId: string }) => [
            'sandboxSession.byTaskId',
            taskId,
          ],
        },
      },
      sessions: {
        forTask: {
          queryOptions: (
            _input: { taskId: string },
            options?: { enabled?: boolean },
          ) => ({
            queryKey: ['sessions.forTask'],
            queryFn: parentSessionQueryMock,
            enabled: options?.enabled,
          }),
        },
      },
      tasks: {
        updateTitle: {
          mutationOptions: () => ({
            mutationFn: updateTitleMutationMock,
          }),
        },
        list: {
          queryKey: () => ['tasks.list'],
        },
        search: {
          queryKey: () => ['tasks.search'],
        },
      },
    });
  });

  it('does not show the runtime indicator in the header', () => {
    renderHeader();

    expect(screen.queryByText('OpenCode')).not.toBeInTheDocument();
  });

  it('keeps the header clean when the task uses OpenCode', () => {
    renderHeader({
      taskRun: {
        payload: {
          environmentId: 'env-1',
        },
        harness: 'opencode-server',
      } as never,
      harness: 'opencode-server',
    });

    expect(screen.queryByText('OpenCode')).not.toBeInTheDocument();
  });

  it('still hides the runtime indicator when the task run does not expose a harness', () => {
    renderHeader({
      taskRun: {
        payload: {
          environmentId: 'env-1',
        },
      } as never,
      harness: 'opencode-server',
    });

    expect(screen.queryByText('OpenCode')).not.toBeInTheDocument();
  });

  it('does not query or render Session breadcrumbs while Sessions UI is disabled', () => {
    renderHeader();

    expect(parentSessionQueryMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Sessions' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Go to session/ })).toBeNull();
  });

  it('renders Session breadcrumbs while Sessions UI is enabled', async () => {
    featureFlagState.sessionsUiEnabled = true;

    renderHeader();

    expect(
      await screen.findByRole('link', { name: 'Parent Session' }),
    ).toHaveAttribute('href', '/sessions/session-1?task=task-123');
    expect(screen.getByRole('link', { name: /Go to session/ })).toHaveAttribute(
      'href',
      '/sessions/session-1?task=task-123',
    );
  });

  it('refreshes task lists after renaming a task', async () => {
    const { queryClient } = renderHeader();
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

    fireEvent.click(screen.getByRole('button', { name: 'Edit task title' }));
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Renamed task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateTitleMutationMock).toHaveBeenCalledWith(
        {
          taskId: 'task-123',
          title: 'Renamed task',
        },
        expect.any(Object),
      );
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['tasks.list'],
      });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['tasks.search'],
      });
    });
  });
});
