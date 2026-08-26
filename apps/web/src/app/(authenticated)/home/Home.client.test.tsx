import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { ALL_REPOSITORIES, FAST_EXECUTION } from '@roomote/types';
import type { RoutingDecision } from '@roomote/cloud-agents/server';
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
  mockUseCreateStandardTaskRun,
  mockCreateStandardTaskRun,
  mockUseLaunchTaskModels,
  mockUseRouteHomeTask,
  mockRouteHomeTask,
  mockPreparePromptAttachments,
  mockStartFastSession,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockToast: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockProcessImageFiles: vi.fn(),
  mockUseCreateStandardTaskRun: vi.fn(),
  mockCreateStandardTaskRun: vi.fn(),
  mockUseLaunchTaskModels: vi.fn(),
  mockUseRouteHomeTask: vi.fn(),
  mockRouteHomeTask: vi.fn(),
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
  useCreateStandardTaskRun: mockUseCreateStandardTaskRun,
  useRouteHomeTask: mockUseRouteHomeTask,
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

vi.mock('@/components/system', async () => {
  const actual = await vi.importActual<typeof import('@/components/system')>(
    '@/components/system',
  );

  return {
    ...actual,
    Loader2: (props: React.ComponentProps<'svg'>) => <svg {...props} />,
  };
});

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

import { Home } from './Home';

vi.mock('@/components/tasks', async () => {
  const actual =
    await vi.importActual<typeof import('@/components/tasks')>(
      '@/components/tasks',
    );
  const { useEffect } = await vi.importActual<typeof import('react')>('react');
  const { useFormContext } =
    await vi.importActual<typeof import('react-hook-form')>('react-hook-form');

  return {
    ...actual,
    SelectWorkspace: ({
      allowAuto,
      allowFast,
      allowBranchSelection,
    }: {
      allowAuto?: boolean;
      allowFast?: boolean;
      allowBranchSelection?: boolean;
    }) => {
      const { watch, setValue } = useFormContext();
      const repository = watch('repository');
      const environmentId = watch('environmentId');

      useEffect(() => {
        if (!allowAuto || environmentId !== 'env-stale') {
          return;
        }

        setValue('repository', AUTO_WORKSPACE_VALUE);
        setValue('environmentId', undefined);
        setValue('branch', '');
      }, [allowAuto, environmentId, setValue]);

      return (
        <div>
          <span data-testid="repository">{repository ?? ''}</span>
          <span data-testid="environment">{environmentId ?? ''}</span>
          <span data-testid="allow-auto">{String(Boolean(allowAuto))}</span>
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
          {allowFast && (
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
          )}
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

const routedEnvironmentSuggestion: RoutingDecision = {
  status: 'routed',
  result: {
    workspace: {
      type: 'environment',
      id: 'env-routed',
      name: 'Routed Workspace',
    },
    reasoning: 'Best match',
  },
};

const routedEnvironmentSuggestionWithModel: RoutingDecision = {
  status: 'routed',
  result: {
    workspace: {
      type: 'environment',
      id: 'env-routed',
      name: 'Routed Workspace',
    },
    model: {
      id: 'openrouter/z-ai/glm-5.2',
      displayName: 'GLM 5.2',
      source: 'preference',
    },
    reasoning: 'Best match',
  },
};

const routedEnvironmentSuggestionWithDefaultModel: RoutingDecision = {
  status: 'routed',
  result: {
    workspace: {
      type: 'environment',
      id: 'env-routed',
      name: 'Routed Workspace',
    },
    model: {
      id: 'openrouter/openai/gpt-5.4',
      displayName: 'GPT 5.4',
      source: 'default',
    },
    reasoning: 'Best match',
  },
};

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
    mockStartFastSession.mockResolvedValue({ sessionId: 'fast-session-1' });
    mockCreateStandardTaskRun.mockResolvedValue({
      success: true,
      id: 4,
      taskId: 'task-4',
    });
    mockUseCreateStandardTaskRun.mockReturnValue({
      isPending: false,
      mutateAsync: mockCreateStandardTaskRun,
    });
    mockUseRouteHomeTask.mockReturnValue({
      isPending: false,
      mutateAsync: mockRouteHomeTask,
    });
    mockUseLaunchTaskModels.mockReturnValue({
      data: {
        defaultModelId: 'openrouter/openai/gpt-5.4',
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
    mockRouteHomeTask.mockResolvedValue({
      status: 'fallback',
      reason: 'No routing result',
    });
  });

  it('renders without an agent selector and does not launch on fallback', async () => {
    render(<Home initialPlaceholderIndex={0} />);

    expect(screen.queryByText(/Select agent /)).not.toBeInTheDocument();
    expect(screen.getByTestId('allow-auto')).toHaveTextContent('true');
    expect(screen.getByTestId('repository')).toHaveTextContent(
      AUTO_WORKSPACE_VALUE,
    );
    expect(mockUseCreateStandardTaskRun).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockRouteHomeTask).toHaveBeenCalledWith({
        description: 'Test prompt',
      });
    });

    expect(mockCreateStandardTaskRun).not.toHaveBeenCalled();
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
        model: 'openrouter/openai/gpt-5.4',
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

  it('shows a toast and does not launch a task for platform answers', async () => {
    mockRouteHomeTask.mockResolvedValue({
      status: 'platform_answer',
      result: {
        answer: 'Roomote can help from Slack, Linear, GitHub, and the web app.',
        reasoning: 'Generic product question',
      },
    } satisfies RoutingDecision);

    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        'Roomote can help from Slack, Linear, GitHub, and the web app.',
      );
    });

    expect(mockCreateStandardTaskRun).not.toHaveBeenCalled();
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

  it('launches a standard task run without an agent identity for routed workspaces', async () => {
    mockRouteHomeTask.mockResolvedValue(routedEnvironmentSuggestion);

    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockCreateStandardTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          computeProvider: 'docker',
          harness: 'opencode-server',
          payload: expect.objectContaining({
            repo: ALL_REPOSITORIES,
            environmentId: 'env-routed',
            description: 'Test prompt',
            blank: false,
          }),
        }),
      );
    });

    const persisted = JSON.parse(
      localStorage.getItem('roomote-workspace:deployment') ?? '{}',
    );

    expect(persisted).toEqual(
      expect.objectContaining({
        workspace: { type: 'auto' },
      }),
    );
  });

  it('uses the routed model for auto-routed launches', async () => {
    mockRouteHomeTask.mockResolvedValue(routedEnvironmentSuggestionWithModel);

    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockCreateStandardTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'openrouter/z-ai/glm-5.2',
          payload: expect.objectContaining({
            repo: ALL_REPOSITORIES,
            environmentId: 'env-routed',
            description: 'Test prompt',
            blank: false,
          }),
        }),
      );
    });
  });

  it('preserves the picker model for auto-routed launches when routing only returns the default model', async () => {
    mockRouteHomeTask.mockResolvedValue(
      routedEnvironmentSuggestionWithDefaultModel,
    );

    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockCreateStandardTaskRun).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          model: 'openrouter/z-ai/glm-5.2',
          payload: expect.objectContaining({
            repo: ALL_REPOSITORIES,
            environmentId: 'env-routed',
            description: 'Test prompt',
            blank: false,
          }),
        }),
      );
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockCreateStandardTaskRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          model: 'openrouter/z-ai/glm-5.2',
          payload: expect.objectContaining({
            repo: ALL_REPOSITORIES,
            environmentId: 'env-single',
            description: 'Test prompt',
            blank: false,
          }),
        }),
      );
    });
  });

  it('always uses createStandardTaskRun for explicit environment launches', async () => {
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockCreateStandardTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          computeProvider: 'docker',
          harness: 'opencode-server',
          payload: expect.objectContaining({
            repo: ALL_REPOSITORIES,
            environmentId: 'env-single',
            description: 'Test prompt',
            blank: false,
          }),
        }),
      );
    });

    expect(mockRouteHomeTask).not.toHaveBeenCalled();
  });

  it('uses opencode as the default harness', async () => {
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockCreateStandardTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          harness: 'opencode-server',
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
      expect(mockCreateStandardTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          harness: 'opencode-server',
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
      expect(mockCreateStandardTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          harness: 'opencode-server',
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
      expect(mockCreateStandardTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          harness: 'opencode-server',
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
      expect(mockCreateStandardTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          computeProvider: 'modal',
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
      expect(mockCreateStandardTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          computeProvider: 'docker',
          payload: expect.objectContaining({
            repo: ALL_REPOSITORIES,
            branch: undefined,
            environmentId: 'env-single',
            description: 'Test prompt',
            blank: false,
          }),
        }),
      );
    });

    expect(mockRouteHomeTask).not.toHaveBeenCalled();
  });

  it('does not source-pin environment launches when debug UI is off', async () => {
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Use single-repo environment' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockCreateStandardTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          computeProvider: 'docker',
          payload: expect.objectContaining({
            repo: ALL_REPOSITORIES,
            branch: undefined,
            environmentId: 'env-single',
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
      expect(mockCreateStandardTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          computeProvider: 'modal',
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
      expect(mockCreateStandardTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          computeProvider: 'modal',
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
      expect(mockCreateStandardTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          computeProvider: 'e2b',
        }),
      );
    });
  });

  it('announces routing progress while auto-routing is pending', async () => {
    let resolveRoute:
      | ((value: typeof routedEnvironmentSuggestion) => void)
      | undefined;

    mockRouteHomeTask.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRoute = resolve;
        }),
    );

    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(screen.getByText('Routing...')).toBeInTheDocument();
    });

    resolveRoute?.(routedEnvironmentSuggestion);

    await waitFor(() => {
      expect(mockCreateStandardTaskRun).toHaveBeenCalled();
    });
  });

  it('disables Auto submissions when no environments exist yet', () => {
    currentEnvironments = [];

    render(<Home initialPlaceholderIndex={0} />);

    expect(
      screen.getByRole('button', { name: 'Submit prompt' }),
    ).toBeDisabled();
  });

  it('does not show the empty-environments warning while environments are loading', () => {
    currentEnvironments = undefined;
    currentEnvironmentsPending = true;

    render(<Home initialPlaceholderIndex={0} />);

    expect(
      screen.queryByText(/You haven't created any environments yet/i),
    ).not.toBeInTheDocument();
  });

  it('shows the empty-environments warning only after load completes with none', () => {
    currentEnvironments = undefined;
    currentEnvironmentsPending = true;

    const { rerender } = render(<Home initialPlaceholderIndex={0} />);

    expect(
      screen.queryByText(/You haven't created any environments yet/i),
    ).not.toBeInTheDocument();

    currentEnvironments = [];
    currentEnvironmentsPending = false;
    rerender(<Home initialPlaceholderIndex={0} />);

    expect(
      screen.getByText(/You haven't created any environments yet/i),
    ).toBeInTheDocument();
  });

  it('does not show the empty-environments warning to members', () => {
    currentIsAdmin = false;
    currentEnvironments = [];

    render(<Home initialPlaceholderIndex={0} />);

    expect(
      screen.queryByText(/You haven't created any environments yet/i),
    ).not.toBeInTheDocument();
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
      expect(mockCreateStandardTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            repo: ALL_REPOSITORIES,
            environmentId: undefined,
            description: 'Test prompt',
            blank: false,
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
      expect(mockCreateStandardTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            repo: ALL_REPOSITORIES,
            environmentId: undefined,
            description: 'Test prompt',
            blank: false,
          }),
        }),
      );
    });
  });

  it('normalizes stale persisted workspace to Auto before submit', async () => {
    localStorage.setItem(
      'roomote-workspace:deployment',
      JSON.stringify({
        harness: 'opencode-server',
        workspace: { type: 'environment', id: 'env-stale' },
      }),
    );

    mockRouteHomeTask.mockResolvedValue({
      status: 'fallback',
      reason: 'Routing unavailable',
    });

    render(<Home initialPlaceholderIndex={0} />);

    await waitFor(() => {
      expect(screen.getByTestId('repository')).toHaveTextContent(
        AUTO_WORKSPACE_VALUE,
      );
      expect(screen.getByTestId('environment')).toHaveTextContent('');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockRouteHomeTask).toHaveBeenCalledWith({
        description: 'Test prompt',
      });
      expect(mockToastError).toHaveBeenCalledWith(
        "Couldn't auto-route this task.",
      );
    });

    expect(mockCreateStandardTaskRun).not.toHaveBeenCalled();
  });

  it('prefers environmentId from the URL when present', async () => {
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

  it('defaults to the sole environment on load when workspace storage is Auto', async () => {
    localStorage.setItem(
      'roomote-workspace:deployment',
      JSON.stringify({ workspace: { type: 'auto' } }),
    );
    currentEnvironments = [{ id: 'env-sole', name: 'Only Env' }];
    currentEnvironmentsPending = false;

    render(<Home initialPlaceholderIndex={0} />);

    await waitFor(() => {
      expect(screen.getByTestId('repository')).toHaveTextContent('env-sole');
      expect(screen.getByTestId('environment')).toHaveTextContent('env-sole');
    });

    expect(
      JSON.parse(localStorage.getItem('roomote-workspace:deployment') ?? '{}'),
    ).toEqual(
      expect.objectContaining({
        workspace: { type: 'environment', id: 'env-sole' },
      }),
    );
  });

  it('keeps Auto on load when multiple environments exist and storage is Auto', async () => {
    localStorage.setItem(
      'roomote-workspace:deployment',
      JSON.stringify({ workspace: { type: 'auto' } }),
    );
    currentEnvironments = [
      { id: 'env-a', name: 'Alpha' },
      { id: 'env-b', name: 'Beta' },
    ];
    currentEnvironmentsPending = false;

    render(<Home initialPlaceholderIndex={0} />);

    await waitFor(() => {
      expect(screen.getByTestId('repository')).toHaveTextContent(
        AUTO_WORKSPACE_VALUE,
      );
      expect(screen.getByTestId('environment')).toHaveTextContent('');
    });
  });
});
