import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const {
  useSandboxLayoutMock,
  useTRPCMock,
  updateTitleMutationMock,
  parentSessionQueryMock,
} = vi.hoisted(() => ({
  useSandboxLayoutMock: vi.fn(),
  useTRPCMock: vi.fn(),
  updateTitleMutationMock: vi.fn(async () => undefined),
  parentSessionQueryMock: vi.fn(),
}));

vi.mock('../../use-sandbox-layout', () => ({
  useSandboxLayout: useSandboxLayoutMock,
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: useTRPCMock,
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

  it('replaces breadcrumbs with a back-to-session control', async () => {
    renderHeader();

    expect(
      await screen.findByRole('link', { name: 'Back to session' }),
    ).toHaveAttribute('href', '/sessions/session-1?task=task-123');
    expect(screen.queryByText('Parent Session')).not.toBeInTheDocument();
    expect(screen.getByText('Workspace env-1')).toBeInTheDocument();
    expect(parentSessionQueryMock).toHaveBeenCalled();
  });

  it('links to the Fast session when the task has no unified session', async () => {
    parentSessionQueryMock.mockResolvedValue(null);

    renderHeader({
      taskRun: {
        payload: {
          environmentId: 'env-1',
          fastAgentSessionId: '00000000-0000-4000-8000-000000000001',
        },
        harness: 'opencode-server',
      } as never,
    });

    expect(
      await screen.findByRole('link', { name: 'Back to session' }),
    ).toHaveAttribute('href', '/sessions/00000000-0000-4000-8000-000000000001');
  });

  it('renders environment and pull request badges together', async () => {
    renderHeader({
      taskRun: {
        payload: { environmentId: 'env-1' },
        pullRequests: [
          {
            repository: 'RooCodeInc/Roomote',
            prNumber: 42,
            prUrl: 'https://github.com/RooCodeInc/Roomote/pull/42',
          },
        ],
      } as never,
    });

    expect(
      await screen.findByText('RooCodeInc/Roomote#42'),
    ).toBeInTheDocument();
    expect(screen.getByText('Workspace env-1')).toBeInTheDocument();
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
