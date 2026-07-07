import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { useSandboxLayoutMock, useTRPCMock, updateTitleMutationMock } =
  vi.hoisted(() => ({
    useSandboxLayoutMock: vi.fn(),
    useTRPCMock: vi.fn(),
    updateTitleMutationMock: vi.fn(async () => undefined),
  }));

vi.mock('../../use-sandbox-layout', () => ({
  useSandboxLayout: useSandboxLayoutMock,
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: useTRPCMock,
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
    cloudJob: {
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

  return render(
    <QueryClientProvider client={queryClient}>
      <Header session={session} />
    </QueryClientProvider>,
  );
}

describe('Header', () => {
  beforeEach(() => {
    vi.clearAllMocks();

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
      tasks: {
        updateTitle: {
          mutationOptions: () => ({
            mutationFn: updateTitleMutationMock,
          }),
        },
        list: {
          queryKey: () => ['tasks.list'],
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
      cloudJob: {
        payload: {
          environmentId: 'env-1',
        },
        harness: 'opencode-server',
      } as never,
      harness: 'opencode-server',
    });

    expect(screen.queryByText('OpenCode')).not.toBeInTheDocument();
  });

  it('still hides the runtime indicator when the cloud job does not expose a harness', () => {
    renderHeader({
      cloudJob: {
        payload: {
          environmentId: 'env-1',
        },
      } as never,
      harness: 'opencode-server',
    });

    expect(screen.queryByText('OpenCode')).not.toBeInTheDocument();
  });
});
