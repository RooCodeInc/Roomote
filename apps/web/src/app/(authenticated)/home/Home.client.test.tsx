import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { ALL_REPOSITORIES, FAST_EXECUTION } from '@roomote/types';
import type { PromptInputMessage } from '@/components/ai-elements';
import { AUTO_WORKSPACE_VALUE } from '@/components/tasks/constants';

let currentSearchParams = '';
let currentCloudEnabled = false;
let currentIsAdmin = true;
let currentEnvironments: Array<{ id: string; name: string }> | undefined = [
  { id: 'env-1', name: 'Primary Env' },
  { id: 'env-2', name: 'Secondary Env' },
];
let currentEnvironmentsPending = false;

const {
  mockPush,
  mockToast,
  mockToastError,
  mockToastSuccess,
  mockProcessImageFiles,
  mockUseLaunchTaskModels,
  mockPreparePromptAttachments,
  mockStartFastSession,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockToast: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockProcessImageFiles: vi.fn(),
  mockUseLaunchTaskModels: vi.fn(),
  mockPreparePromptAttachments: vi.fn(),
  mockStartFastSession: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(currentSearchParams),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(mockToast, {
    error: mockToastError,
    success: mockToastSuccess,
  }),
}));

vi.mock('@/hooks/useUser', () => ({
  useUser: () => ({
    authStatus: 'signed-in',
    isSignedIn: true,
    user: { isAdmin: currentIsAdmin },
  }),
  useAuthorizedUser: () => ({
    userId: 'user-1',
    isAdmin: currentIsAdmin,
    name: 'Test User',
    primaryEmail: 'test@example.com',
    cloudEnabled: currentCloudEnabled,
    resource: {
      username: 'tester',
      fullName: 'Test User',
      firstName: 'Test',
      lastName: 'User',
      primaryEmailAddress: null,
      emailAddresses: [],
      imageUrl: '',
      createdAt: null,
    },
  }),
}));

vi.mock('@/hooks/environments', () => ({
  useEnvironments: () => ({
    data: currentEnvironments,
    isPending: currentEnvironmentsPending,
    isSuccess: !currentEnvironmentsPending,
  }),
}));

vi.mock('@/hooks/task-runs', () => ({
  useStartFastSession: () => ({
    isPending: false,
    mutateAsync: mockStartFastSession,
  }),
}));

vi.mock('@/lib/prompt-attachments', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/prompt-attachments')
  >('@/lib/prompt-attachments');

  return {
    ...actual,
    preparePromptAttachments: mockPreparePromptAttachments,
  };
});

vi.mock('@/hooks/task-models/useLaunchTaskModels', () => ({
  useLaunchTaskModels: mockUseLaunchTaskModels,
}));

vi.mock('@/lib', () => ({
  processImageFiles: mockProcessImageFiles,
}));

vi.mock('@/lib/utils', () => ({
  cn: (...classNames: Array<string | false | null | undefined>) =>
    classNames.filter(Boolean).join(' '),
}));

vi.mock('./OnboardingCard', () => ({
  OnboardingCard: () => <div>Onboarding</div>,
}));

vi.mock('./BottomSheetTabs', () => ({
  BottomSheetTabs: () => <div>Tabs</div>,
}));

import { NewTaskForm } from '@/components/tasks/NewTaskForm';
import { Home } from './Home';

vi.mock('@/components/tasks', async () => {
  const actual =
    await vi.importActual<typeof import('@/components/tasks')>(
      '@/components/tasks',
    );
  const { useEffect } = await vi.importActual<typeof import('react')>('react');
  const { useFormContext } =
    await vi.importActual<typeof import('react-hook-form')>('react-hook-form');
  const { useWorkspaceStorage } = await vi.importActual<
    typeof import('@/hooks/useWorkspaceStorage')
  >('@/hooks/useWorkspaceStorage');

  return {
    ...actual,
    SelectWorkspace: ({
      allowAuto,
      autoSelectDefaultWorkspace,
      onInvalidWorkspaceReset,
      allowBranchSelection,
    }: {
      allowAuto?: boolean;
      autoSelectDefaultWorkspace?: boolean;
      onInvalidWorkspaceReset?: () => void;
      allowBranchSelection?: boolean;
    }) => {
      const { watch, setValue } = useFormContext();
      const { setWorkspace } = useWorkspaceStorage();
      const repository = watch('repository');
      const environmentId = watch('environmentId');

      useEffect(() => {
        if (!allowAuto || environmentId !== 'env-stale') {
          return;
        }

        setValue('repository', AUTO_WORKSPACE_VALUE);
        setValue('environmentId', undefined);
        setValue('branch', '');
        setWorkspace({ workspace: { type: 'auto' } });
        onInvalidWorkspaceReset?.();
      }, [
        allowAuto,
        environmentId,
        onInvalidWorkspaceReset,
        setValue,
        setWorkspace,
      ]);

      return (
        <div>
          <span data-testid="repository">{repository ?? ''}</span>
          <span data-testid="environment">{environmentId ?? ''}</span>
          <span data-testid="allow-auto">{String(Boolean(allowAuto))}</span>
          <span data-testid="auto-select-default-workspace">
            {String(Boolean(autoSelectDefaultWorkspace))}
          </span>
          <span data-testid="allow-branch-selection">
            {String(Boolean(allowBranchSelection))}
          </span>
          <button
            type="button"
            onClick={() => {
              setValue('repository', AUTO_WORKSPACE_VALUE);
              setValue('environmentId', undefined);
              setValue('branch', '');
            }}
          >
            Use auto workspace
          </button>
          <button
            type="button"
            onClick={() => {
              setValue('repository', FAST_EXECUTION);
              setValue('environmentId', undefined);
              setValue('branch', '');
            }}
          >
            Use Fast workspace
          </button>
          <button
            type="button"
            onClick={() => {
              setValue('repository', ALL_REPOSITORIES);
              setValue('environmentId', undefined);
              setValue('branch', '');
            }}
          >
            Use all repositories workspace
          </button>
          <button
            type="button"
            onClick={() => {
              setValue('repository', 'env-single');
              setValue('environmentId', 'env-single');
              setValue('branch', 'feature/current');
            }}
          >
            Use single-repo environment
          </button>
          <button
            type="button"
            onClick={() => {
              setValue('repository', 'env-multi');
              setValue('environmentId', 'env-multi');
              setValue('branch', 'feature/multi');
            }}
          >
            Use multi-repo environment
          </button>
        </div>
      );
    },
    TaskPromptInput: ({
      onSubmit,
      onPromptTextChange,
      promptText,
      placeholder,
      submitDisabledReason,
    }: {
      onSubmit: (message: PromptInputMessage) => Promise<void> | void;
      onPromptTextChange?: (value: string) => void;
      promptText?: string;
      placeholder?: string;
      submitDisabledReason?: string;
    }) => (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (submitDisabledReason) {
            return;
          }
          onPromptTextChange?.('Test prompt');
          const result = onSubmit({ text: 'Test prompt', files: [] });

          if (result instanceof Promise) {
            void result.catch(() => {});
          }
        }}
      >
        <div data-testid="prompt-placeholder">{placeholder}</div>
        <textarea
          aria-label="Task prompt"
          value={promptText ?? ''}
          onChange={(event) => onPromptTextChange?.(event.target.value)}
        />
        <button type="submit" disabled={Boolean(submitDisabledReason)}>
          Submit prompt
        </button>
      </form>
    ),
    ModelSelect: ({
      value,
      onValueChange,
      ariaLabel = 'Model',
    }: {
      value?: string;
      onValueChange: (value: string) => void;
      ariaLabel?: string;
    }) => (
      <div>
        <span data-testid="selected-model-id">{value ?? ''}</span>
        <button
          type="button"
          aria-label={ariaLabel}
          onClick={() => onValueChange('openrouter/z-ai/glm-5.2')}
        >
          Use GLM 5.2 model
        </button>
      </div>
    ),
  };
});

describe('Home', () => {
  beforeEach(() => {
    currentSearchParams = '';
    currentCloudEnabled = false;
    currentIsAdmin = true;
    currentEnvironments = [
      { id: 'env-1', name: 'Primary Env' },
      { id: 'env-2', name: 'Secondary Env' },
    ];
    currentEnvironmentsPending = false;
    localStorage.clear();
    vi.clearAllMocks();

    mockProcessImageFiles.mockResolvedValue([]);
    mockPreparePromptAttachments.mockImplementation(
      ({ text }: { text: string }) => Promise.resolve({ text }),
    );
    mockStartFastSession.mockResolvedValue({
      sessionId: 'fast-session-1',
      taskId: 'task-4',
    });
    mockUseLaunchTaskModels.mockReturnValue({
      data: {
        defaultModelId: 'openrouter/openai/gpt-5.4',
        defaultFastModelId: 'openrouter/anthropic/claude-haiku-4.5',
        models: [
          {
            id: 'openrouter/openai/gpt-5.4',
            displayName: 'GPT 5.4',
            family: 'GPT',
            isDefault: true,
          },
          {
            id: 'openrouter/z-ai/glm-5.2',
            displayName: 'GLM 5.2',
            family: 'GLM',
            isDefault: false,
          },
        ],
      },
    });
  });

  it('leaves an untouched Fast session on the orchestration default', async () => {
    render(<Home initialPlaceholderIndex={0} />);

    expect(
      screen.getByRole('heading', { name: 'New Session' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/^Choose where Roomote should work/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Select agent /)).not.toBeInTheDocument();
    // Auto was retired from the picker (identical to Fast); Fast is offered.
    expect(screen.getByTestId('allow-auto')).toHaveTextContent('false');
    expect(screen.getByTestId('selected-model-id')).toHaveTextContent(
      'openrouter/anthropic/claude-haiku-4.5',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Use auto workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith({
        text: 'Test prompt',
        images: undefined,
        model: undefined,
      });
    });

    expect(mockStartFastSession).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/sessions/fast-session-1');
  });

  it('starts a new Fast session with the selected non-default model', async () => {
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use auto workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith({
        text: 'Test prompt',
        images: undefined,
        model: 'openrouter/z-ai/glm-5.2',
      });
    });
  });

  it('keeps Home-only content out of the shared launch form', async () => {
    const onTaskStarted = vi.fn();

    render(<NewTaskForm onTaskStarted={onTaskStarted} />);

    expect(
      screen.queryByRole('heading', { name: 'New Session' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Onboarding')).not.toBeInTheDocument();
    expect(screen.queryByText('Tabs')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Use Fast workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => expect(onTaskStarted).toHaveBeenCalledOnce());
  });

  it('always defaults to Fast execution', async () => {
    render(<Home initialPlaceholderIndex={0} />);

    await waitFor(() => {
      expect(screen.getByTestId('repository')).toHaveTextContent(
        FAST_EXECUTION,
      );
    });
    expect(
      screen.getByTestId('auto-select-default-workspace'),
    ).toHaveTextContent('false');
  });

  it.each([
    {
      name: 'environment',
      workspace: { type: 'environment', id: 'env-1' },
    },
    {
      name: 'repository',
      workspace: { type: 'repository', value: 'RooCodeInc/Roomote' },
    },
  ])('prefers Fast over a persisted $name workspace', async ({ workspace }) => {
    localStorage.setItem(
      'roomote-workspace:deployment',
      JSON.stringify({ workspace }),
    );

    render(<Home initialPlaceholderIndex={0} />);

    await waitFor(() => {
      expect(screen.getByTestId('repository')).toHaveTextContent(
        FAST_EXECUTION,
      );
      expect(screen.getByTestId('environment')).toHaveTextContent('');
    });
  });

  it('starts a Fast session with an image-only prompt', async () => {
    mockPreparePromptAttachments.mockResolvedValueOnce({
      text: '',
      images: ['data:image/png;base64,image-1'],
    });
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Use Fast workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith({
        text: '',
        images: ['data:image/png;base64,image-1'],
        model: undefined,
      });
    });
    expect(mockPush).toHaveBeenCalledWith('/sessions/fast-session-1');
  });

  it('renders the feedback prompt below the input and opens its dialog', async () => {
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Feedback, please!' }),
    );

    expect(
      screen.getByRole('dialog', {
        name: 'What do you think of Roomote so far?',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Schedule time with the team' }),
    ).toHaveAttribute(
      'href',
      'https://calendly.com/d/ctx9-f7q-6vr/roomote-feedback',
    );
    expect(screen.getByRole('link', { name: 'Email us' })).toHaveAttribute(
      'href',
      'mailto:help@roomote.dev?subject=My%20thoughts%20on%20Roomote%20so%20far',
    );
  });

  it('persists dismissal of the feedback prompt', async () => {
    const { unmount } = render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Feedback, please!' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss feedback prompt' }),
    );

    expect(window.localStorage.getItem('roomote-home-feedback-dismissed')).toBe(
      '1',
    );
    expect(
      screen.queryByRole('button', { name: 'Feedback, please!' }),
    ).not.toBeInTheDocument();

    unmount();
    render(<Home initialPlaceholderIndex={0} />);

    expect(
      screen.queryByRole('button', { name: 'Feedback, please!' }),
    ).not.toBeInTheDocument();
  });

  it('keeps feedback dismissal usable when storage access fails', async () => {
    const feedbackStorageKey = 'roomote-home-feedback-dismissed';
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    const getItemSpy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation((key) => {
        if (key === feedbackStorageKey) {
          throw new Error('Storage access blocked');
        }

        return originalGetItem.call(window.localStorage, key);
      });
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation((key, value) => {
        if (key === feedbackStorageKey) {
          throw new Error('Storage quota exceeded');
        }

        originalSetItem.call(window.localStorage, key, value);
      });

    try {
      render(<Home initialPlaceholderIndex={0} />);

      fireEvent.click(
        await screen.findByRole('button', { name: 'Feedback, please!' }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Dismiss feedback prompt' }),
      );

      expect(
        screen.queryByRole('button', { name: 'Feedback, please!' }),
      ).not.toBeInTheDocument();
    } finally {
      getItemSpy.mockRestore();
      setItemSpy.mockRestore();
    }
  });

  it('cycles prompt placeholders every 5 seconds from a random starting point', async () => {
    vi.useFakeTimers();

    try {
      render(<Home initialPlaceholderIndex={3} />);

      expect(screen.getByTestId('prompt-placeholder')).toHaveTextContent(
        'Review this pull request and address the feedback',
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(screen.getByTestId('prompt-placeholder')).toHaveTextContent(
        'Investigate why this test is flaky and fix it',
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(screen.getByTestId('prompt-placeholder')).toHaveTextContent(
        'Find a TODO in the code and fix it',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the picker model for explicit environment launches', async () => {
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Test prompt',
          model: 'openrouter/z-ai/glm-5.2',
          pinnedLaunch: expect.objectContaining({
            repo: ALL_REPOSITORIES,
            environmentId: 'env-single',
          }),
        }),
      );
    });
  });

  it('always pins explicit environment launches through the Session launcher', async () => {
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Test prompt',
          pinnedLaunch: expect.objectContaining({
            repo: ALL_REPOSITORIES,
            environmentId: 'env-single',
            harness: 'opencode-server',
            computeProvider: 'docker',
          }),
        }),
      );
    });
  });

  it('opens the task view for a direct environment launch', async () => {
    mockStartFastSession.mockResolvedValue({
      sessionId: 'session-1',
      taskId: 'task-4',
    });
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/task/task-4');
    });
  });

  it('uses opencode as the default harness', async () => {
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith(
        expect.objectContaining({
          pinnedLaunch: expect.objectContaining({
            harness: 'opencode-server',
          }),
        }),
      );
    });
  });

  it('does not show a model selector when debug UI is enabled', () => {
    render(<Home initialPlaceholderIndex={0} />);

    expect(screen.queryByLabelText('OpenCode model')).not.toBeInTheDocument();
  });

  it('ignores previously persisted harnesses on new launches', async () => {
    localStorage.setItem(
      'roomote-workspace:deployment',
      JSON.stringify({
        harness: 'opencode-server',
        workspace: { type: 'auto' },
      }),
    );

    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith(
        expect.objectContaining({
          pinnedLaunch: expect.objectContaining({
            harness: 'opencode-server',
          }),
        }),
      );
    });
  });

  it('does not persist the default harness after launch', async () => {
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith(
        expect.objectContaining({
          pinnedLaunch: expect.objectContaining({
            harness: 'opencode-server',
          }),
        }),
      );
    });

    expect(
      JSON.parse(localStorage.getItem('roomote-workspace:deployment') ?? '{}'),
    ).toEqual(
      expect.objectContaining({
        workspace: { type: 'environment', id: 'env-single' },
      }),
    );
    expect(
      JSON.parse(localStorage.getItem('roomote-workspace:deployment') ?? '{}'),
    ).not.toHaveProperty('harness');
    expect(
      JSON.parse(localStorage.getItem('roomote-workspace:deployment') ?? '{}'),
    ).not.toHaveProperty('harnessPreference');
  });

  it('uses the OpenCode harness on new launches', async () => {
    localStorage.setItem(
      'roomote-workspace:deployment',
      JSON.stringify({
        harness: 'opencode-server',
        harnessPreference: 'explicit',
        workspace: { type: 'auto' },
      }),
    );

    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith(
        expect.objectContaining({
          pinnedLaunch: expect.objectContaining({
            harness: 'opencode-server',
          }),
        }),
      );
    });
  });

  it('uses the provided default compute provider when selection is enabled', async () => {
    render(<Home initialPlaceholderIndex={0} defaultComputeProvider="modal" />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith(
        expect.objectContaining({
          pinnedLaunch: expect.objectContaining({
            computeProvider: 'modal',
          }),
        }),
      );
    });
  });

  it('does not source-pin selected environment launches from Home when debug UI is enabled', async () => {
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Test prompt',
          pinnedLaunch: expect.objectContaining({
            repo: ALL_REPOSITORIES,
            branch: undefined,
            environmentId: 'env-single',
            computeProvider: 'docker',
          }),
        }),
      );
    });
  });

  it('does not source-pin environment launches when debug UI is off', async () => {
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith(
        expect.objectContaining({
          pinnedLaunch: expect.objectContaining({
            repo: ALL_REPOSITORIES,
            branch: undefined,
            environmentId: 'env-single',
            computeProvider: 'docker',
          }),
        }),
      );
    });

    expect(screen.getByTestId('allow-branch-selection')).toHaveTextContent(
      'false',
    );
  });

  it('shows the compute provider selector outside cloud mode', () => {
    render(<Home initialPlaceholderIndex={0} />);

    expect(screen.getByLabelText('Sandbox provider')).toBeInTheDocument();
  });

  it('hides the compute provider selector when cloud mode is enabled', () => {
    currentCloudEnabled = true;

    render(<Home initialPlaceholderIndex={0} />);

    expect(screen.queryByLabelText('Sandbox provider')).not.toBeInTheDocument();
  });

  it('uses the default compute provider for launches when cloud mode hides selection', async () => {
    currentCloudEnabled = true;

    render(
      <Home
        initialPlaceholderIndex={0}
        defaultComputeProvider="modal"
        availableComputeProviders={['modal', 'docker']}
      />,
    );

    expect(screen.queryByLabelText('Sandbox provider')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith(
        expect.objectContaining({
          pinnedLaunch: expect.objectContaining({
            computeProvider: 'modal',
          }),
        }),
      );
    });
  });

  it('uses only configured sandbox providers for selection and launch', async () => {
    render(
      <Home
        initialPlaceholderIndex={0}
        defaultComputeProvider="e2b"
        availableComputeProviders={['modal']}
      />,
    );

    expect(screen.queryByLabelText('Sandbox provider')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith(
        expect.objectContaining({
          pinnedLaunch: expect.objectContaining({
            computeProvider: 'modal',
          }),
        }),
      );
    });
  });

  it('falls back to the last catalog-ordered available cloud provider', async () => {
    render(
      <Home
        initialPlaceholderIndex={0}
        defaultComputeProvider="daytona"
        // Server may return providers in a non-catalog order; Home should
        // still prefer configured clouds over Local Docker, using the last
        // catalog-ordered cloud when more than one is available.
        availableComputeProviders={['docker', 'e2b', 'modal']}
      />,
    );

    expect(screen.getByLabelText('Sandbox provider')).toHaveTextContent('E2B');

    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith(
        expect.objectContaining({
          pinnedLaunch: expect.objectContaining({
            computeProvider: 'e2b',
          }),
        }),
      );
    });
  });

  it('starts a Fast session for Auto submissions without an environment', async () => {
    currentEnvironments = [];

    render(<Home initialPlaceholderIndex={0} />);

    const submitButton = screen.getByRole('button', { name: 'Submit prompt' });
    expect(submitButton).toBeEnabled();
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith({
        text: 'Test prompt',
        images: undefined,
        model: undefined,
      });
    });
    expect(mockStartFastSession).toHaveBeenCalledTimes(1);
  });

  it('renders onboarding guidance on Home', () => {
    render(<Home initialPlaceholderIndex={0} />);

    expect(screen.getByText('Onboarding')).toBeInTheDocument();
  });

  it('allows all-repositories launches when no environments exist', async () => {
    currentEnvironments = [];

    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Use all repositories workspace' }),
    );

    const submitButton = screen.getByRole('button', { name: 'Submit prompt' });
    expect(submitButton).toBeEnabled();

    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Test prompt',
          pinnedLaunch: expect.objectContaining({
            repo: ALL_REPOSITORIES,
            environmentId: undefined,
          }),
        }),
      );
    });
  });

  it('launches all-repositories tasks without an environment when environments exist', async () => {
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Use all repositories workspace' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Test prompt',
          pinnedLaunch: expect.objectContaining({
            repo: ALL_REPOSITORIES,
            environmentId: undefined,
          }),
        }),
      );
    });
  });

  it('restores the Fast default after normalizing a stale persisted workspace', async () => {
    localStorage.setItem(
      'roomote-workspace:deployment',
      JSON.stringify({
        workspace: { type: 'environment', id: 'env-stale' },
      }),
    );

    render(<Home initialPlaceholderIndex={0} />);

    await waitFor(() => {
      expect(screen.getByTestId('repository')).toHaveTextContent(
        FAST_EXECUTION,
      );
      expect(screen.getByTestId('environment')).toHaveTextContent('');
    });
  });

  it('prefers environmentId from the URL over the Fast default', async () => {
    currentSearchParams = 'environmentId=env-created';

    render(<Home initialPlaceholderIndex={0} />);

    await waitFor(() => {
      expect(screen.getByTestId('repository')).toHaveTextContent('env-created');
      expect(screen.getByTestId('environment')).toHaveTextContent(
        'env-created',
      );
    });

    const persisted = JSON.parse(
      localStorage.getItem('roomote-workspace:deployment') ?? '{}',
    );

    expect(persisted).toEqual(
      expect.objectContaining({
        workspace: { type: 'environment', id: 'env-created' },
      }),
    );
    expect(persisted).not.toHaveProperty('harness');
    expect(persisted).not.toHaveProperty('harnessPreference');
  });

  it('prefills editable task details from the URL', async () => {
    currentSearchParams = new URLSearchParams({
      prompt: 'Fix the build',
      model: 'openrouter/openai/gpt-5.4',
      environmentId: 'env-created',
    }).toString();

    render(<Home initialPlaceholderIndex={0} />);

    expect(screen.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
      'Fix the build',
    );
    expect(screen.getByTestId('selected-model-id')).toHaveTextContent(
      'openrouter/openai/gpt-5.4',
    );

    await waitFor(() => {
      expect(screen.getByTestId('environment')).toHaveTextContent(
        'env-created',
      );
    });

    fireEvent.change(screen.getByRole('textbox', { name: 'Task prompt' }), {
      target: { value: 'Fix the tests instead' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );

    expect(screen.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
      'Fix the tests instead',
    );
    expect(screen.getByTestId('selected-model-id')).toHaveTextContent(
      'openrouter/z-ai/glm-5.2',
    );
    expect(screen.getByTestId('environment')).toHaveTextContent('env-single');
  });
});
