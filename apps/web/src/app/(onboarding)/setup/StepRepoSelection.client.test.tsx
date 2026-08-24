import type {
  ButtonHTMLAttributes,
  ComponentProps,
  HTMLAttributes,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  ReactNode,
  SVGProps,
} from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ENVIRONMENT_DEFINITION_SETUP_GUIDANCE_MAX_LENGTH,
  type SetupNewState,
} from '@roomote/types';

const {
  mockSaveSelection,
  mockPrefetchRecommendationSignals,
  mockStartOnboardingTask,
  mockCreateGitHubInstallation,
  mockToastError,
} = vi.hoisted(() => ({
  mockSaveSelection: vi.fn().mockResolvedValue({
    setupNewState: {
      version: 1,
      authProvider: null,
      selectedRepositoryIds: ['repo-1'],
      setupGuidance: 'Run the API first.',
      onboardingTaskId: null,
      onboardingTaskStartedAt: null,
      slackChannel: null,
      slackThreadTs: null,
      lastInteractedByUserId: 'user-1',
    },
  }),
  mockPrefetchRecommendationSignals: vi.fn().mockResolvedValue({
    repositoryIds: ['repo-1', 'repo-2'],
  }),
  mockStartOnboardingTask: vi.fn().mockResolvedValue({
    taskId: 'task-onboarding-1',
    startedAt: '2026-07-10T10:00:00.000Z',
    recommendationBatch: {
      version: 1,
      inputFingerprint: 'fingerprint-1',
      catalogVersion: 1,
      status: 'pending' as const,
      startedAt: '2026-07-10T10:00:00.000Z',
      completedAt: null,
      partial: false,
      errorCode: null,
      dismissed: false,
      recommendations: [],
    },
    setupNewState: {} as SetupNewState,
    nextStep: 'invoke' as const,
  }),
  mockCreateGitHubInstallation: vi.fn(),
  mockToastError: vi.fn(),
}));

const { mockRefetchRepositories } = vi.hoisted(() => ({
  mockRefetchRepositories: vi.fn().mockResolvedValue(undefined),
}));

const { mockUseRepositories } = vi.hoisted(() => ({
  mockUseRepositories: vi.fn(),
}));

const mockRepositories = vi.hoisted(
  (): Array<{
    id: string;
    fullName: string;
    private: boolean;
    defaultBranch: string;
    isEmpty?: boolean;
  }> => [
    {
      id: 'repo-1',
      fullName: 'acme/api',
      private: false,
      defaultBranch: 'main',
    },
    {
      id: 'repo-2',
      fullName: 'acme/web',
      private: true,
      defaultBranch: 'develop',
    },
  ],
);

vi.mock('next/navigation', () => ({
  usePathname: () => '/setup',
}));

vi.mock('sonner', () => ({
  toast: {
    error: mockToastError,
  },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setupNew: {
      saveSelection: {
        mutationOptions: (options = {}) => ({
          mutationFn: mockSaveSelection,
          ...options,
        }),
      },
      prefetchRecommendationSignals: {
        mutationOptions: (options = {}) => ({
          mutationFn: mockPrefetchRecommendationSignals,
          ...options,
        }),
      },
      startOnboardingTask: {
        mutationOptions: (options = {}) => ({
          mutationFn: mockStartOnboardingTask,
          ...options,
        }),
      },
      status: {
        queryKey: () => ['setupNew', 'status'],
      },
    },
  }),
}));

vi.mock('@/hooks/github', () => ({
  useCreateGitHubInstallation: () => ({
    mutate: mockCreateGitHubInstallation,
    isPending: false,
  }),
}));

vi.mock('@/hooks/source-control', () => ({
  useRepositories: mockUseRepositories,
}));

vi.mock('@/components/github/CreateGitHubRepoDialog', () => ({
  CreateGitHubRepoDialog: ({
    open,
    onRepositoryDetected,
  }: {
    open: boolean;
    onRepositoryDetected?: (repository: {
      id: string;
      fullName: string;
      isEmpty?: boolean;
    }) => void;
  }) =>
    open ? (
      <button
        type="button"
        onClick={() =>
          onRepositoryDetected?.({
            id: 'repo-created',
            fullName: 'acme/created',
            isEmpty: true,
          })
        }
      >
        Detect created repository
      </button>
    ) : null,
}));

vi.mock('@/hooks/task-models/useLaunchTaskModels', () => ({
  useLaunchTaskModels: () => ({
    data: {
      defaultModelId: 'openrouter/openai/gpt-5.4',
      models: [
        {
          id: 'openrouter/openai/gpt-5.4',
          displayName: 'GPT 5.4',
          isDefault: true,
        },
        {
          id: 'openrouter/z-ai/glm-5.2',
          displayName: 'GLM 5.2',
          isDefault: false,
        },
      ],
    },
    isPending: false,
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
  AlertTriangle: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Badge: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLSpanElement>) => (
    <span {...props}>{children}</span>
  ),
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
  CardHeader: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  CardTitle: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLHeadingElement>) => (
    <h2 {...props}>{children}</h2>
  ),
  CardDescription: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props}>{children}</p>
  ),
  CardContent: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  CardFooter: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
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
  Eye: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  EyeClosed: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Github: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Info: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  ArrowRight: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Loader2: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  PackagePlus: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Plus: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  RefreshCcw: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  RotateCw: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Search: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Spinner: () => <div>Loading…</div>,
  ScrollArea: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
  X: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
}));

vi.mock('./StepTitle', () => ({
  StepTitle: ({ text }: { text: string }) => <h1>{text}</h1>,
}));

vi.mock('@/components/tasks', () => ({
  ModelSelect: ({
    value,
    onValueChange,
    disabled,
  }: {
    value?: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label="Model"
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    >
      <option value="">Model</option>
      <option value="openrouter/openai/gpt-5.4">GPT 5.4</option>
      <option value="openrouter/z-ai/glm-5.2">GLM 5.2</option>
    </select>
  ),
}));

import { StepRepoSelection } from './StepRepoSelection';

async function renderStepRepoSelection(
  props: Partial<ComponentProps<typeof StepRepoSelection>> = {},
) {
  const queryClient = new QueryClient();
  const renderResult = render(
    <QueryClientProvider client={queryClient}>
      <StepRepoSelection
        {...props}
        onContinue={props.onContinue ?? vi.fn()}
        onSkip={props.onSkip ?? vi.fn()}
      />
    </QueryClientProvider>,
  );

  await waitFor(() => {
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  return {
    queryClient,
    ...renderResult,
  };
}

function showMissingRepositoryOptions() {
  fireEvent.click(screen.getByRole('button', { name: 'Missing a repo?' }));
}

describe('StepRepoSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveSelection.mockResolvedValue({
      setupNewState: {
        onboardingTaskId: null,
      },
    });
    mockPrefetchRecommendationSignals.mockResolvedValue({
      repositoryIds: ['repo-1', 'repo-2'],
    });
    mockStartOnboardingTask.mockResolvedValue({
      taskId: 'task-onboarding-1',
      startedAt: '2026-07-10T10:00:00.000Z',
      recommendationBatch: {
        version: 1,
        inputFingerprint: 'fingerprint-1',
        catalogVersion: 1,
        status: 'pending' as const,
        startedAt: '2026-07-10T10:00:00.000Z',
        completedAt: null,
        partial: false,
        errorCode: null,
        dismissed: false,
        recommendations: [],
      },
      setupNewState: {} as SetupNewState,
      nextStep: 'invoke' as const,
    });
    mockUseRepositories.mockImplementation(() => ({
      data: [...mockRepositories],
      isPending: false,
      isFetching: false,
      refetch: mockRefetchRepositories,
    }));
    mockRepositories.splice(0, mockRepositories.length);
    mockRepositories.push(
      {
        id: 'repo-1',
        fullName: 'acme/api',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-2',
        fullName: 'acme/web',
        private: true,
        defaultBranch: 'develop',
      },
    );
  });

  it('restarts GitHub access management from the edit access action', async () => {
    await renderStepRepoSelection();

    showMissingRepositoryOptions();

    fireEvent.click(
      screen.getByRole('button', { name: /^edit github access$/i }),
    );

    expect(mockCreateGitHubInstallation).toHaveBeenCalledWith(
      '/setup?step=repo-selection',
    );
  });

  it('requests repository empty-state data for onboarding', async () => {
    await renderStepRepoSelection();

    expect(mockUseRepositories).toHaveBeenCalledWith({
      includeEmptyState: true,
    });
  });

  it('prefetches recommendation signals when repositories load', async () => {
    await renderStepRepoSelection();

    await waitFor(() => {
      expect(mockPrefetchRecommendationSignals).toHaveBeenCalledWith(
        {
          repositoryIds: ['repo-1', 'repo-2'],
        },
        expect.anything(),
      );
    });
  });

  it('keeps the repository filter hidden when there are seven repositories or fewer', async () => {
    mockRepositories.splice(
      0,
      mockRepositories.length,
      {
        id: 'repo-1',
        fullName: 'acme/api',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-2',
        fullName: 'acme/web',
        private: true,
        defaultBranch: 'develop',
      },
      {
        id: 'repo-3',
        fullName: 'acme/docs',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-4',
        fullName: 'acme/ops',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-5',
        fullName: 'acme/mobile',
        private: false,
        defaultBranch: 'main',
      },
    );
    await renderStepRepoSelection();

    expect(
      screen.queryByRole('textbox', { name: /filter repositories/i }),
    ).not.toBeInTheDocument();
  });

  it('shows a repository filter once more than seven repositories are available', async () => {
    mockRepositories.splice(
      0,
      mockRepositories.length,
      {
        id: 'repo-1',
        fullName: 'acme/api',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-2',
        fullName: 'acme/web',
        private: true,
        defaultBranch: 'develop',
      },
      {
        id: 'repo-3',
        fullName: 'acme/docs',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-4',
        fullName: 'acme/ops',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-5',
        fullName: 'acme/mobile',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-6',
        fullName: 'acme/admin',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-7',
        fullName: 'acme/platform',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-8',
        fullName: 'acme/worker',
        private: false,
        defaultBranch: 'main',
      },
    );
    await renderStepRepoSelection();

    fireEvent.change(
      screen.getByRole('textbox', { name: /filter repositories/i }),
      {
        target: { value: 'admin' },
      },
    );

    expect(screen.getByLabelText(/acme\/admin/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/acme\/api/i)).not.toBeInTheDocument();

    fireEvent.change(
      screen.getByRole('textbox', { name: /filter repositories/i }),
      {
        target: { value: 'missing' },
      },
    );

    expect(
      screen.getByText(/no repositories match that filter/i),
    ).toBeInTheDocument();
  });

  it('clears the repository filter with the clear button', async () => {
    mockRepositories.splice(
      0,
      mockRepositories.length,
      {
        id: 'repo-1',
        fullName: 'acme/api',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-2',
        fullName: 'acme/web',
        private: true,
        defaultBranch: 'develop',
      },
      {
        id: 'repo-3',
        fullName: 'acme/docs',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-4',
        fullName: 'acme/ops',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-5',
        fullName: 'acme/mobile',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-6',
        fullName: 'acme/admin',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-7',
        fullName: 'acme/platform',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-8',
        fullName: 'acme/worker',
        private: false,
        defaultBranch: 'main',
      },
    );
    await renderStepRepoSelection();

    const filterInput = screen.getByRole('textbox', {
      name: /filter repositories/i,
    });

    fireEvent.change(filterInput, {
      target: { value: 'admin' },
    });

    expect(screen.getByDisplayValue('admin')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /clear repository filter/i }),
    );

    expect(screen.queryByDisplayValue('admin')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/acme\/api/i)).toBeInTheDocument();
  });

  it('clears and ignores the repository filter when the repo list shrinks below the filter threshold', async () => {
    mockRepositories.splice(
      0,
      mockRepositories.length,
      {
        id: 'repo-1',
        fullName: 'acme/api',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-2',
        fullName: 'acme/web',
        private: true,
        defaultBranch: 'develop',
      },
      {
        id: 'repo-3',
        fullName: 'acme/docs',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-4',
        fullName: 'acme/ops',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-5',
        fullName: 'acme/mobile',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-6',
        fullName: 'acme/admin',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-7',
        fullName: 'acme/platform',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-8',
        fullName: 'acme/worker',
        private: false,
        defaultBranch: 'main',
      },
    );
    const { queryClient, rerender } = await renderStepRepoSelection();

    fireEvent.change(
      screen.getByRole('textbox', { name: /filter repositories/i }),
      {
        target: { value: 'admin' },
      },
    );

    expect(screen.getByDisplayValue('admin')).toBeInTheDocument();
    expect(screen.queryByLabelText(/acme\/api/i)).not.toBeInTheDocument();

    mockRepositories.splice(
      0,
      mockRepositories.length,
      {
        id: 'repo-1',
        fullName: 'acme/api',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-2',
        fullName: 'acme/web',
        private: true,
        defaultBranch: 'develop',
      },
      {
        id: 'repo-3',
        fullName: 'acme/docs',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-4',
        fullName: 'acme/ops',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'repo-5',
        fullName: 'acme/mobile',
        private: false,
        defaultBranch: 'main',
      },
    );

    rerender(
      <QueryClientProvider client={queryClient}>
        <StepRepoSelection onContinue={vi.fn()} onSkip={vi.fn()} />
      </QueryClientProvider>,
    );

    expect(
      screen.queryByRole('textbox', { name: /filter repositories/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText(/acme\/api/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/acme\/mobile/i)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('admin')).not.toBeInTheDocument();
  });

  it('shows a retry explanation when setup previously failed', async () => {
    const onReviewComputeProvider = vi.fn();

    await renderStepRepoSelection({
      retryReason: 'task-failed',
      onReviewComputeProvider,
    });

    expect(screen.queryByText('Setup attempt failed')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /could not finish creating your first environment from the previous setup run/i,
      ),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /review your sandbox provider/i }),
    );
    expect(onReviewComputeProvider).toHaveBeenCalled();
  });

  it('explains the bootstrap and keeps Continue enabled when all selected repositories are empty', async () => {
    mockRepositories.splice(
      0,
      mockRepositories.length,
      {
        id: 'repo-1',
        fullName: 'acme/empty',
        private: false,
        defaultBranch: 'main',
        isEmpty: true,
      },
      {
        id: 'repo-2',
        fullName: 'acme/empty-web',
        private: true,
        defaultBranch: 'main',
        isEmpty: true,
      },
    );
    await renderStepRepoSelection();

    fireEvent.click(screen.getByLabelText('acme/empty'));
    fireEvent.click(screen.getByLabelText('acme/empty-web'));

    expect(
      screen.getByText(/all selected repositories have no commits yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /will push an initial commit and set up a basic environment/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('keeps Continue enabled and hides the warning for mixed empty and non-empty selections', async () => {
    mockRepositories.splice(
      0,
      mockRepositories.length,
      {
        id: 'repo-1',
        fullName: 'acme/api',
        private: false,
        defaultBranch: 'main',
        isEmpty: false,
      },
      {
        id: 'repo-2',
        fullName: 'acme/empty',
        private: true,
        defaultBranch: 'main',
        isEmpty: true,
      },
    );

    await renderStepRepoSelection();

    fireEvent.click(screen.getByLabelText(/acme\/api/i));
    fireEvent.click(screen.getByLabelText(/acme\/empty/i));

    expect(
      screen.queryByText(
        /will push an initial commit and set up a basic environment/i,
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('offers the create-repo affordance and selects the repository it detects', async () => {
    mockRepositories.splice(0, mockRepositories.length, {
      id: 'repo-created',
      fullName: 'acme/created',
      private: true,
      defaultBranch: 'main',
      isEmpty: true,
    });

    await renderStepRepoSelection();

    fireEvent.click(
      screen.getByRole('button', { name: 'Create a new repository' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Detect created repository' }),
    );

    expect(screen.getByLabelText('acme/created')).toBeChecked();
  });

  it('keeps the create-repository item visible when the list is filtered to no matches', async () => {
    mockRepositories.push(
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `repo-extra-${index}`,
        fullName: `acme/extra-${index}`,
        private: true,
        defaultBranch: 'main',
      })),
    );

    await renderStepRepoSelection();

    fireEvent.change(screen.getByLabelText('Filter repositories'), {
      target: { value: 'does-not-exist' },
    });

    expect(
      screen.getByRole('button', { name: 'Create a new repository' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No repositories match that filter.'),
    ).toBeInTheDocument();
  });

  it('renders the empty-repository warning below the repository list', async () => {
    mockRepositories.splice(
      0,
      mockRepositories.length,
      {
        id: 'repo-1',
        fullName: 'acme/empty',
        private: false,
        defaultBranch: 'main',
        isEmpty: true,
      },
      {
        id: 'repo-2',
        fullName: 'acme/empty-web',
        private: true,
        defaultBranch: 'main',
        isEmpty: true,
      },
    );

    await renderStepRepoSelection();

    fireEvent.click(screen.getByLabelText('acme/empty'));
    fireEvent.click(screen.getByLabelText('acme/empty-web'));

    const repositoryRow = screen.getByLabelText('acme/empty-web');
    const warningText = screen.getByText(
      /all selected repositories have no commits yet/i,
    );

    expect(
      repositoryRow.compareDocumentPosition(warningText) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('refreshes the repository list from the existing refresh action', async () => {
    await renderStepRepoSelection();
    mockRefetchRepositories.mockClear();

    expect(
      screen.queryByRole('button', { name: /refresh list/i }),
    ).not.toBeInTheDocument();

    showMissingRepositoryOptions();

    fireEvent.click(screen.getByRole('button', { name: /refresh list/i }));

    await waitFor(() => {
      expect(mockRefetchRepositories).toHaveBeenCalledTimes(1);
    });
  });

  it('ignores rapid repeat clicks on the empty-state refresh button', async () => {
    mockRepositories.splice(0, mockRepositories.length);
    mockRefetchRepositories.mockImplementationOnce(
      () => new Promise(() => undefined),
    );

    await renderStepRepoSelection();

    const refreshButton = screen.getByRole('button', { name: /^refresh$/i });
    mockRefetchRepositories.mockClear();

    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(refreshButton).toBeDisabled();
    });

    fireEvent.click(refreshButton);
    fireEvent.click(refreshButton);

    expect(mockRefetchRepositories).toHaveBeenCalledTimes(1);
  });

  it('keeps a refresh action visible when all selected repositories are empty', async () => {
    mockRepositories.splice(
      0,
      mockRepositories.length,
      {
        id: 'repo-1',
        fullName: 'acme/empty',
        private: true,
        defaultBranch: 'main',
        isEmpty: true,
      },
      {
        id: 'repo-2',
        fullName: 'acme/empty-web',
        private: false,
        defaultBranch: 'main',
        isEmpty: true,
      },
    );

    await renderStepRepoSelection();

    fireEvent.click(screen.getByLabelText('acme/empty'));
    fireEvent.click(screen.getByLabelText('acme/empty-web'));

    const warningRefreshButton = screen.getAllByRole('button', {
      name: /refresh list/i,
    })[0];

    expect(warningRefreshButton).toBeDefined();
    mockRefetchRepositories.mockClear();

    fireEvent.click(warningRefreshButton!);

    await waitFor(() => {
      expect(mockRefetchRepositories).toHaveBeenCalledTimes(1);
    });
  });

  it('leaves the only available repository unselected by default', async () => {
    mockRepositories.splice(0, mockRepositories.length, {
      id: 'repo-1',
      fullName: 'acme/api',
      private: false,
      defaultBranch: 'main',
    });

    await renderStepRepoSelection();

    expect(screen.getByLabelText(/acme\/api/i)).not.toBeChecked();
    expect(
      screen.queryByRole('button', { name: 'Continue' }),
    ).not.toBeInTheDocument();
    expect(mockSaveSelection).not.toHaveBeenCalled();
  });

  it('requires at least one repository before Continue persists selection', async () => {
    const onContinue = vi.fn();

    await renderStepRepoSelection({ onContinue });

    expect(
      screen.queryByRole('button', {
        name: 'Continue',
      }),
    ).not.toBeInTheDocument();
    expect(mockSaveSelection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText(/acme\/api/i));

    const continueButton = screen.getByRole('button', {
      name: 'Continue',
    });
    expect(continueButton).toBeEnabled();

    fireEvent.change(screen.getByPlaceholderText(/Optional agent guidance/i), {
      target: { value: 'Run the API first.' },
    });

    fireEvent.click(continueButton);

    await waitFor(() => {
      expect(mockSaveSelection).toHaveBeenCalled();
    });
    expect(mockSaveSelection.mock.calls[0]![0]).toEqual({
      repositoryIds: ['repo-1'],
      setupGuidance: 'Run the API first.',
      selectedModelId: 'openrouter/openai/gpt-5.4',
    });
    expect(mockStartOnboardingTask).toHaveBeenCalledTimes(1);
    expect(mockSaveSelection.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartOnboardingTask.mock.invocationCallOrder[0]!,
    );
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-onboarding-1',
        nextStep: 'invoke',
        recommendationBatch: expect.objectContaining({
          status: 'pending',
        }),
      }),
    );
  });

  it('keeps Continue busy while saving and launching', async () => {
    let resolveSave!: (value: unknown) => void;
    let resolveLaunch!: (value: {
      taskId: string;
      startedAt: string;
      recommendationBatch: {
        version: 1;
        inputFingerprint: string;
        catalogVersion: number;
        status: 'pending';
        startedAt: string;
        completedAt: null;
        partial: boolean;
        errorCode: null;
        dismissed: boolean;
        recommendations: [];
      };
      setupNewState: SetupNewState;
      nextStep: 'invoke';
    }) => void;
    mockSaveSelection.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSave = resolve)),
    );
    mockStartOnboardingTask.mockImplementationOnce(
      () => new Promise((resolve) => (resolveLaunch = resolve)),
    );

    await renderStepRepoSelection();
    fireEvent.click(screen.getByLabelText(/acme\/api/i));
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    fireEvent.click(continueButton);

    await waitFor(() => expect(continueButton).toBeDisabled());
    resolveSave({ setupNewState: { onboardingTaskId: null } });
    await waitFor(() => expect(mockStartOnboardingTask).toHaveBeenCalled());
    expect(continueButton).toBeDisabled();

    resolveLaunch({
      taskId: 'task-onboarding-1',
      startedAt: '2026-07-10T10:00:00.000Z',
      recommendationBatch: {
        version: 1,
        inputFingerprint: 'fingerprint-1',
        catalogVersion: 1,
        status: 'pending' as const,
        startedAt: '2026-07-10T10:00:00.000Z',
        completedAt: null,
        partial: false,
        errorCode: null,
        dismissed: false,
        recommendations: [],
      },
      setupNewState: {} as SetupNewState,
      nextStep: 'invoke' as const,
    });
    await waitFor(() => expect(continueButton).toBeEnabled());
  });

  it('stays on selection after launch failure and retries without resaving unchanged values', async () => {
    const onContinue = vi.fn();
    mockStartOnboardingTask
      .mockRejectedValueOnce(new Error('Failed to start setup'))
      .mockResolvedValueOnce({
        taskId: 'task-onboarding-retry',
        startedAt: '2026-07-10T10:01:00.000Z',
        recommendationBatch: {
          version: 1,
          inputFingerprint: 'fingerprint-1',
          catalogVersion: 1,
          status: 'pending' as const,
          startedAt: '2026-07-10T10:01:00.000Z',
          completedAt: null,
          partial: false,
          errorCode: null,
          dismissed: false,
          recommendations: [],
        },
        setupNewState: {} as SetupNewState,
        nextStep: 'invoke' as const,
      });

    await renderStepRepoSelection({ onContinue });
    fireEvent.click(screen.getByLabelText(/acme\/api/i));
    fireEvent.change(screen.getByPlaceholderText(/Optional agent guidance/i), {
      target: { value: 'Keep this guidance.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Failed to start setup');
    });
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/Optional agent guidance/i)).toHaveValue(
      'Keep this guidance.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(onContinue).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-onboarding-retry',
          nextStep: 'invoke',
        }),
      );
    });
    expect(mockSaveSelection).toHaveBeenCalledTimes(1);
    expect(mockStartOnboardingTask).toHaveBeenCalledTimes(2);
  });

  it('selects the default model before the user changes it', async () => {
    await renderStepRepoSelection();

    fireEvent.click(screen.getByLabelText(/acme\/api/i));

    expect(screen.getByRole('combobox', { name: /model/i })).toHaveValue(
      'openrouter/openai/gpt-5.4',
    );
  });

  it('persists the selected model with the repository selection', async () => {
    await renderStepRepoSelection();

    fireEvent.click(screen.getByLabelText(/acme\/api/i));
    fireEvent.change(screen.getByRole('combobox', { name: /model/i }), {
      target: { value: 'openrouter/z-ai/glm-5.2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(mockSaveSelection).toHaveBeenCalled();
    });
    expect(mockSaveSelection.mock.calls[0]![0]).toEqual({
      repositoryIds: ['repo-1'],
      setupGuidance: undefined,
      selectedModelId: 'openrouter/z-ai/glm-5.2',
    });
  });

  it('shows a skip action and calls onSkip', async () => {
    const onSkip = vi.fn();

    await renderStepRepoSelection({ onSkip });

    expect(
      screen.queryByRole('button', {
        name: 'Continue',
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));

    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('shows a skip action when no repositories are available', async () => {
    const onSkip = vi.fn();
    mockRepositories.splice(0, mockRepositories.length);

    await renderStepRepoSelection({ onSkip });

    expect(
      screen.getByText(/no repositories available yet/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));

    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('rehydrates saved guidance and selection on replay visits', async () => {
    const onContinue = vi.fn();

    await renderStepRepoSelection({
      onContinue,
      initialSelectedRepositoryIds: ['repo-1'],
      initialSetupGuidance: 'Use the API service from this repo.',
    });

    expect(screen.getByLabelText(/acme\/api/i)).toBeChecked();
    expect(screen.getByPlaceholderText(/Optional agent guidance/i)).toHaveValue(
      'Use the API service from this repo.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(mockSaveSelection).toHaveBeenCalled();
    });
    expect(mockSaveSelection.mock.calls.at(-1)?.[0]).toEqual({
      repositoryIds: ['repo-1'],
      setupGuidance: 'Use the API service from this repo.',
      selectedModelId: 'openrouter/openai/gpt-5.4',
    });
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('shows the setup guidance character count and enforces the max length', async () => {
    await renderStepRepoSelection({
      initialSelectedRepositoryIds: ['repo-1'],
    });

    const textarea = screen.getByPlaceholderText(/Optional agent guidance/i);
    expect(textarea).toHaveAttribute(
      'maxLength',
      ENVIRONMENT_DEFINITION_SETUP_GUIDANCE_MAX_LENGTH.toString(),
    );
    expect(
      screen.queryByText(
        `0/${ENVIRONMENT_DEFINITION_SETUP_GUIDANCE_MAX_LENGTH.toLocaleString()}`,
      ),
    ).not.toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: 'Run the API first.' } });

    expect(
      screen.queryByText(
        `${'Run the API first.'.length.toLocaleString()}/${ENVIRONMENT_DEFINITION_SETUP_GUIDANCE_MAX_LENGTH.toLocaleString()}`,
      ),
    ).not.toBeInTheDocument();
  });

  it('switches the counter to a warning tone near the limit', async () => {
    await renderStepRepoSelection({
      initialSelectedRepositoryIds: ['repo-1'],
    });

    fireEvent.change(screen.getByPlaceholderText(/Optional agent guidance/i), {
      target: { value: 'x'.repeat(7_501) },
    });

    expect(
      screen.getByText(
        `7,501/${ENVIRONMENT_DEFINITION_SETUP_GUIDANCE_MAX_LENGTH.toLocaleString()}`,
      ),
    ).toHaveClass('text-warning-foreground');
  });
});
