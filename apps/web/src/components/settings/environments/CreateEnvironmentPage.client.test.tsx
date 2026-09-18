import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SVGProps,
  TextareaHTMLAttributes,
} from 'react';
import { forwardRef, useImperativeHandle } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const {
  mockStartDefinitionTask,
  mockCreateEnvironment,
  mockRouterPush,
  mockValidateEnvironmentConfig,
  mockYamlEditorState,
} = vi.hoisted(() => {
  const initialConfig = {
    name: 'Warned Project',
    repositories: [{ repository: 'acme/api' }],
  };
  const editedConfig = {
    name: 'Edited Project',
    repositories: [{ repository: 'acme/web' }],
  };

  return {
    mockStartDefinitionTask: vi.fn().mockResolvedValue({
      taskId: 'task-1',
      startedAt: '2026-03-24T00:00:00.000Z',
    }),
    mockCreateEnvironment: vi.fn().mockResolvedValue({
      success: true,
      data: { id: 'env-1' },
    }),
    mockRouterPush: vi.fn(),
    mockValidateEnvironmentConfig: vi.fn(),
    mockYamlEditorState: {
      initialConfig,
      editedConfig,
      currentConfig: initialConfig,
      reset() {
        this.currentConfig = this.initialConfig;
      },
    },
  };
});

const { mockNavigationState, mockRepositoriesState, mockCreateRepoDialog } =
  vi.hoisted(() => ({
    mockNavigationState: { search: '' as string },
    mockRepositoriesState: {
      data: [
        { id: 'repo-1', fullName: 'acme/api' },
        { id: 'repo-2', fullName: 'acme/web' },
      ] as
        | Array<{ id: string; fullName: string; isEmpty?: boolean }>
        | undefined,
      isError: false,
      isFetching: false,
      isPending: false,
      refetch: vi.fn(),
    },
    mockCreateRepoDialog: vi.fn(),
  }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
  }),
  useSearchParams: () => new URLSearchParams(mockNavigationState.search),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock('@/hooks/environments', () => ({
  useCreateEnvironment: () => ({
    mutateAsync: mockCreateEnvironment,
    isPending: false,
  }),
  useValidateEnvironmentConfig: () => ({
    mutateAsync: mockValidateEnvironmentConfig,
    isPending: false,
  }),
}));

vi.mock('@/hooks/source-control', () => ({
  useRepositories: () => ({
    data: mockRepositoriesState.data,
    isError: mockRepositoriesState.isError,
    isFetching: mockRepositoriesState.isFetching,
    isPending: mockRepositoriesState.isPending,
    refetch: mockRepositoriesState.refetch,
  }),
}));

vi.mock('@/hooks/task-models/useLaunchTaskModels', () => ({
  useLaunchTaskModels: () => ({
    data: { defaultModelId: 'openrouter/openai/gpt-5.4' },
  }),
}));

vi.mock('@/components/tasks', () => ({
  ModelSelect: ({
    value,
    onValueChange,
    ariaLabel,
  }: {
    value?: string;
    onValueChange: (value: string) => void;
    ariaLabel?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value ?? ''}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    >
      <option value="">Model</option>
      <option value="openrouter/z-ai/glm-5.2">GLM 5.2</option>
    </select>
  ),
}));

vi.mock('@/components/github/CreateGitHubRepoDialog', () => ({
  CreateGitHubRepoDialog: (props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onRepositoryDetected?: (repository: {
      id: string;
      fullName: string;
      isEmpty?: boolean;
    }) => void;
  }) => {
    mockCreateRepoDialog(props);
    return props.open ? <div data-testid="create-repo-dialog" /> : null;
  },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    environments: {
      startDefinitionTask: {
        mutationOptions: (options = {}) => ({
          mutationFn: mockStartDefinitionTask,
          ...options,
        }),
      },
    },
  }),
}));

vi.mock('./UpdateGitHubReposHint', () => ({
  UpdateGitHubReposHint: () => <div data-testid="update-github-repos-hint" />,
}));

vi.mock('./YamlEnvironmentEditor', () => ({
  YamlEnvironmentEditor: forwardRef(function MockYamlEnvironmentEditor(
    props: {
      onSave: (config: unknown) => Promise<unknown>;
      onChange?: () => void;
    },
    ref,
  ) {
    useImperativeHandle(ref, () => ({
      save: async () => {
        await props.onSave(mockYamlEditorState.currentConfig);
      },
    }));

    return (
      <button
        type="button"
        onClick={() => {
          mockYamlEditorState.currentConfig = mockYamlEditorState.editedConfig;
          props.onChange?.();
        }}
      >
        Mock edit YAML
      </button>
    );
  }),
}));

vi.mock('@/components/system', () => ({
  Alert: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  AlertDescription: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  ArrowLeft: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  ArrowRight: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Bot: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Button: ({
    children,
    ...props
  }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={props.type ?? 'button'} {...props}>
      {children}
    </button>
  ),
  Card: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  CardContent: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Check: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & {
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={Boolean(checked)}
      onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
      {...props}
    />
  ),
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogDescription: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props}>{children}</p>
  ),
  DialogFooter: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogHeader: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogTitle: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLHeadingElement>) => (
    <h2 {...props}>{children}</h2>
  ),
  HandMetal: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Info: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Loader2: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Plus: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  RetryableLoadError: ({
    message,
    isRetrying,
    onRetry,
  }: {
    message: string;
    isRetrying?: boolean;
    onRetry: () => void;
  }) => (
    <div>
      <p>{message}</p>
      <button type="button" disabled={isRetrying} onClick={onRetry}>
        Retry
      </button>
    </div>
  ),
  ScrollArea: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
}));

import { CreateEnvironmentPage } from './CreateEnvironmentPage';

describe('CreateEnvironmentPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockYamlEditorState.reset();
    mockNavigationState.search = '';
    mockRepositoriesState.data = [
      { id: 'repo-1', fullName: 'acme/api' },
      { id: 'repo-2', fullName: 'acme/web' },
    ];
    mockRepositoriesState.isError = false;
    mockRepositoriesState.isFetching = false;
    mockRepositoriesState.isPending = false;
    mockRepositoriesState.refetch.mockReset();
  });

  it('keeps cached repositories visible after a background failure', () => {
    mockRepositoriesState.isError = true;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CreateEnvironmentPage />
      </QueryClientProvider>,
    );
    expect(screen.getByText('acme/api')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start Agent' })).toBeEnabled();
  });

  it('renders the create-repo affordance and opens the dialog', () => {
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <CreateEnvironmentPage />
      </QueryClientProvider>,
    );

    expect(screen.queryByTestId('create-repo-dialog')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /Create a new repository/i }),
    );

    expect(screen.getByTestId('create-repo-dialog')).toBeInTheDocument();
  });

  it('opens the create-repo dialog from the create-repo search param', () => {
    mockNavigationState.search = 'create-repo=1';
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <CreateEnvironmentPage />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('create-repo-dialog')).toBeInTheDocument();
  });

  it('selects a detected repository and explains the empty-repo bootstrap', async () => {
    mockRepositoriesState.data = [
      { id: 'repo-1', fullName: 'acme/api' },
      { id: 'repo-new', fullName: 'acme/new-repo', isEmpty: true },
    ];
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <CreateEnvironmentPage />
      </QueryClientProvider>,
    );

    const dialogProps = mockCreateRepoDialog.mock.calls.at(-1)?.[0] as {
      onRepositoryDetected?: (repository: {
        id: string;
        fullName: string;
        isEmpty?: boolean;
      }) => void;
    };

    dialogProps.onRepositoryDetected?.({
      id: 'repo-new',
      fullName: 'acme/new-repo',
      isEmpty: true,
    });

    await waitFor(() => {
      expect(screen.getByLabelText(/acme\/new-repo/i)).toBeChecked();
    });
    expect(
      screen.getByText(/will push an initial commit and set up a basic/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Agent' })).toBeEnabled();
  });

  it('starts an environment definition task and opens it in the task view', async () => {
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <CreateEnvironmentPage />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByLabelText(/acme\/api/i));
    fireEvent.change(screen.getByPlaceholderText(/Optional agent guidance/i), {
      target: { value: 'Use the API service from the first repo set.' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start Agent' }));

    await waitFor(() => {
      expect(mockStartDefinitionTask).toHaveBeenCalled();
    });
    expect(mockStartDefinitionTask.mock.calls[0]?.[0]).toEqual({
      repositoryIds: ['repo-1'],
      changeRequest: 'Use the API service from the first repo set.',
      selectedModelId: 'openrouter/openai/gpt-5.4',
    });
    expect(mockRouterPush).toHaveBeenCalledWith('/task/task-1');
  });

  it('starts an environment definition task without rendering repository empty-state copy', async () => {
    mockRepositoriesState.data = [];
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <CreateEnvironmentPage />
      </QueryClientProvider>,
    );

    expect(screen.queryByText(/no repositories/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/repository-free/i)).not.toBeInTheDocument();
    const startButton = screen.getByRole('button', { name: 'Start Agent' });
    expect(startButton).toBeEnabled();
    fireEvent.click(startButton);

    await waitFor(() => {
      expect(mockStartDefinitionTask).toHaveBeenCalledWith(
        {
          repositoryIds: [],
          changeRequest: undefined,
          selectedModelId: 'openrouter/openai/gpt-5.4',
        },
        expect.anything(),
      );
    });
  });

  it('blocks agent start and retries when repositories fail to load', async () => {
    mockRepositoriesState.isError = true;
    mockRepositoriesState.data = undefined;
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <CreateEnvironmentPage />
      </QueryClientProvider>,
    );

    expect(
      screen.getByText('Failed to load repositories.'),
    ).toBeInTheDocument();
    const retryButton = screen.getByRole('button', { name: 'Retry' });
    expect(retryButton).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Start Agent' })).toBeDisabled();

    fireEvent.click(retryButton);

    expect(mockRepositoriesState.refetch).toHaveBeenCalledOnce();
    expect(mockStartDefinitionTask).not.toHaveBeenCalled();
  });

  it('blocks agent start while repositories are initially loading', () => {
    mockRepositoriesState.isPending = true;
    mockRepositoriesState.data = [];
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <CreateEnvironmentPage />
      </QueryClientProvider>,
    );

    expect(
      screen.queryByRole('button', { name: 'Retry' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Agent' })).toBeDisabled();
  });

  it('keeps retry disabled while the repository query is retrying', () => {
    mockRepositoriesState.isError = true;
    mockRepositoriesState.isFetching = true;
    mockRepositoriesState.data = undefined;
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <CreateEnvironmentPage />
      </QueryClientProvider>,
    );

    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start Agent' })).toBeDisabled();
  });

  it('clears stale continue-anyway state after yaml edits', async () => {
    mockValidateEnvironmentConfig
      .mockResolvedValueOnce({
        errors: [],
        warnings: ['Repository access warning'],
      })
      .mockResolvedValueOnce({
        errors: [],
        warnings: [],
      });

    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <CreateEnvironmentPage />
      </QueryClientProvider>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /Enter YAML directly/i }),
    );

    fireEvent.click(
      await screen.findByRole('button', {
        name: /Create Environment/i,
      }),
    );

    expect(
      await screen.findByRole('button', { name: /Continue anyway/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Mock edit YAML/i }));

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /Continue anyway/i }),
      ).not.toBeInTheDocument();
    });

    fireEvent.click(
      await screen.findByRole('button', {
        name: /Create Environment/i,
      }),
    );

    await waitFor(() => {
      expect(mockCreateEnvironment).toHaveBeenCalledWith({
        name: 'Edited Project',
        description: undefined,
        config: mockYamlEditorState.editedConfig,
      });
    });
  });
});
