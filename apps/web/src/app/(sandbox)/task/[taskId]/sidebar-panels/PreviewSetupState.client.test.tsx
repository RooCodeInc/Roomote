import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { TaskRun } from '@roomote/db';

import { PreviewSetupState } from './PreviewSetupState';

const { authState, statusState, startSetupMock } = vi.hoisted(() => ({
  authState: { isAdmin: false },
  statusState: {
    data: null as {
      runtimeReady: boolean;
      environment: {
        id: string;
        name: string;
        hasConfiguredPorts: boolean;
        portNames: string[];
      } | null;
      runHasPreviewDomains: boolean;
      setupTask: {
        taskId: string | null;
        status: string;
        kind: 'preview' | 'environment';
      } | null;
    } | null,
  },
  startSetupMock: vi.fn(async (_variables: { taskId: string }) => ({
    taskId: 'setup-task-1',
    alreadyRunning: false,
  })),
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
          refetchInterval: false,
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

vi.mock('@/components/previews/PreviewRuntimeSetup', () => ({
  PreviewRuntimeSetup: () => <div>runtime-setup-blocks</div>,
}));

const taskRun = { id: 1, taskId: 'task-1' } as TaskRun;

function renderSetupState(run?: TaskRun) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <PreviewSetupState taskRun={run} />
    </QueryClientProvider>,
  );
}

function buildStatus(
  overrides: Partial<NonNullable<typeof statusState.data>> = {},
) {
  return {
    runtimeReady: true,
    environment: {
      id: 'env-1',
      name: 'Web App',
      hasConfiguredPorts: false,
      portNames: [],
    },
    runHasPreviewDomains: false,
    setupTask: null,
    ...overrides,
  };
}

describe('PreviewSetupState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.isAdmin = false;
    statusState.data = buildStatus();
  });

  it('shows the generic unavailable message without a task run', () => {
    renderSetupState(undefined);

    expect(
      screen.getByText('Live Preview is not available for this task.'),
    ).toBeInTheDocument();
  });

  it('explains repo-only tasks have no environment to preview', async () => {
    statusState.data = buildStatus({ environment: null });

    renderSetupState(taskRun);

    expect(
      await screen.findByText(
        'Live previews are available for tasks that run in an environment',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Create an environment')).not.toBeInTheDocument();
  });

  it('shows no environment-creation CTA for repo-only tasks, even for admins', async () => {
    authState.isAdmin = true;
    statusState.data = buildStatus({ environment: null });

    renderSetupState(taskRun);

    expect(
      await screen.findByText(
        'Live previews are available for tasks that run in an environment',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Create an environment')).not.toBeInTheDocument();
  });

  it('links to an in-flight setup task', async () => {
    statusState.data = buildStatus({
      setupTask: { taskId: 'setup-task-9', status: 'running', kind: 'preview' },
    });

    renderSetupState(taskRun);

    expect(
      await screen.findByText(
        'An agent is setting up live previews for Web App',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /view setup task/i }),
    ).toHaveAttribute('href', '/task/setup-task-9');
  });

  it('shows setup progress without a task link when the id is withheld', async () => {
    statusState.data = buildStatus({
      setupTask: { taskId: null, status: 'running', kind: 'preview' },
    });

    renderSetupState(taskRun);

    expect(
      await screen.findByText(
        'An agent is setting up live previews for Web App',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /view setup task/i }),
    ).not.toBeInTheDocument();
  });

  it('explains ongoing environment setup without claiming a preview agent', async () => {
    statusState.data = buildStatus({
      setupTask: {
        taskId: 'env-setup-1',
        status: 'running',
        kind: 'environment',
      },
    });

    renderSetupState(taskRun);

    expect(
      await screen.findByText('Web App is still being set up'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/setting up live previews/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /view setup task/i }),
    ).toHaveAttribute('href', '/task/env-setup-1');
  });

  it('tells non-admins to ask an administrator when the runtime is not ready', async () => {
    statusState.data = buildStatus({ runtimeReady: false });

    renderSetupState(taskRun);

    expect(
      await screen.findByText(
        'Ask an administrator to configure live previews.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('runtime-setup-blocks')).not.toBeInTheDocument();
  });

  it('shows admins the runtime setup blocks when the runtime is not ready', async () => {
    authState.isAdmin = true;
    statusState.data = buildStatus({ runtimeReady: false });

    renderSetupState(taskRun);

    expect(await screen.findByText('runtime-setup-blocks')).toBeInTheDocument();
  });

  it('lets admins launch the setup agent for environments without ports', async () => {
    authState.isAdmin = true;
    statusState.data = buildStatus();

    renderSetupState(taskRun);

    const button = await screen.findByRole('button', {
      name: /set up previews with an agent/i,
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(startSetupMock).toHaveBeenCalledTimes(1);
    });
    expect(startSetupMock.mock.calls[0]?.[0]).toEqual({ taskId: 'task-1' });
  });

  it('tells non-admins to ask an administrator for environments without ports', async () => {
    statusState.data = buildStatus();

    renderSetupState(taskRun);

    expect(
      await screen.findByText(
        'Ask an administrator to set up live previews for this environment.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /set up previews with an agent/i }),
    ).not.toBeInTheDocument();
  });

  it('offers admins a manual ports link for environments without ports', async () => {
    authState.isAdmin = true;
    statusState.data = buildStatus();

    renderSetupState(taskRun);

    expect(
      await screen.findByRole('link', { name: /configure ports manually/i }),
    ).toHaveAttribute('href', '/settings/environments/env-1/edit');
  });

  it('explains sleep/wake for runs that predate configured ports', async () => {
    statusState.data = buildStatus({
      environment: {
        id: 'env-1',
        name: 'Web App',
        hasConfiguredPorts: true,
        portNames: ['WEB', 'API'],
      },
    });

    renderSetupState(taskRun);

    expect(
      await screen.findByText(
        'This task started before live previews were configured for Web App',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('WEB, API')).toBeInTheDocument();
  });
});
