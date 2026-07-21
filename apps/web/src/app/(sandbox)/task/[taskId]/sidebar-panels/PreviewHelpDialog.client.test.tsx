import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PreviewHelpDialog } from './PreviewHelpDialog';

const { authState, statusState, startSetupMock } = vi.hoisted(() => ({
  authState: { isAdmin: false },
  statusState: {
    data: {
      runtimeReady: true,
      environment: {
        id: 'env-1',
        name: 'Web App',
        hasConfiguredPorts: true,
        portNames: ['WEB'],
      },
      runHasPreviewDomains: true,
      setupTask: null as {
        taskId: string | null;
        status: string;
        kind: 'preview';
      } | null,
    },
  },
  startSetupMock: vi.fn(
    async (_variables: { taskId: string; mode?: string }) => ({
      taskId: 'fix-task-1',
      alreadyRunning: false,
    }),
  ),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({
    isAdmin: authState.isAdmin,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    previewSettings: {
      taskStatus: {
        queryOptions: (
          input: { taskId: string },
          options?: Record<string, unknown>,
        ) => ({
          queryKey: ['previewTaskStatus', input.taskId],
          queryFn: () => statusState.data,
          ...options,
        }),
        queryKey: (input: { taskId: string }) => [
          'previewTaskStatus',
          input.taskId,
        ],
      },
      startSetupTask: {
        mutationOptions: (options?: Record<string, unknown>) => ({
          mutationFn: startSetupMock,
          ...options,
        }),
      },
    },
  }),
}));

function renderDialog(taskId: string | null = 'task-1') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <PreviewHelpDialog taskId={taskId} open={true} onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('PreviewHelpDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.isAdmin = false;
    statusState.data = {
      runtimeReady: true,
      environment: {
        id: 'env-1',
        name: 'Web App',
        hasConfiguredPorts: true,
        portNames: ['WEB'],
      },
      runHasPreviewDomains: true,
      setupTask: null,
    };
  });

  it('lets admins launch a repair agent', async () => {
    authState.isAdmin = true;

    renderDialog();

    const button = await screen.findByRole('button', {
      name: /fix previews with an agent/i,
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(startSetupMock).toHaveBeenCalledTimes(1);
    });
    expect(startSetupMock.mock.calls[0]?.[0]).toEqual({
      taskId: 'task-1',
      mode: 'repair',
    });
  });

  it('tells non-admins to ask an administrator', async () => {
    renderDialog();

    expect(
      await screen.findByText(
        'Ask an administrator to fix live previews for this environment.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /fix previews with an agent/i }),
    ).not.toBeInTheDocument();
  });

  it('links to an in-flight agent task instead of offering a new launch', async () => {
    authState.isAdmin = true;
    statusState.data = {
      ...statusState.data,
      setupTask: { taskId: 'fix-task-9', status: 'running', kind: 'preview' },
    };

    renderDialog();

    expect(
      await screen.findByRole('link', { name: /view agent task/i }),
    ).toHaveAttribute('href', '/task/fix-task-9');
    expect(
      screen.queryByRole('button', { name: /fix previews with an agent/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the in-flight message without a task link when the id is withheld', async () => {
    statusState.data = {
      ...statusState.data,
      setupTask: { taskId: null, status: 'running', kind: 'preview' },
    };

    renderDialog();

    expect(
      await screen.findByText(
        'An agent is already working on live previews for Web App.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /view agent task/i }),
    ).not.toBeInTheDocument();
  });
});
