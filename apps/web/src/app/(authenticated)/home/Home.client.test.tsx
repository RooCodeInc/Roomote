import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { ALL_REPOSITORIES } from '@roomote/types';
import type { PromptInputMessage } from '@/components/ai-elements';

let currentSearchParams = '';
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
    cloudEnabled: false,
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
import { TaskLaunchConfigProvider } from '@/components/tasks/TaskLaunchConfig';
import { Home } from './Home';

vi.mock('@/components/tasks', async () => {
  const actual =
    await vi.importActual<typeof import('@/components/tasks')>(
      '@/components/tasks',
    );
  return {
    ...actual,
    TaskPromptInput: ({
      onSubmit,
      onPromptTextChange,
      promptText,
      placeholder,
      submitDisabledReason,
      tools,
    }: {
      onSubmit: (message: PromptInputMessage) => Promise<void> | void;
      onPromptTextChange?: (value: string) => void;
      promptText?: string;
      placeholder?: string;
      submitDisabledReason?: string;
      tools?: import('react').ReactNode;
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
        <button type="button" aria-label="Add attachments">
          +
        </button>
        {tools}
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
    SessionModelSwitcher: ({
      model,
      onModelChange,
      defaultModelId,
    }: {
      model: string;
      onModelChange: (value: string) => void;
      defaultModelId?: string;
    }) => (
      <div>
        <span data-testid="selected-model-id">
          {model || defaultModelId || ''}
        </span>
        <button
          type="button"
          aria-label="Model for this session"
          onClick={() => onModelChange('openrouter/z-ai/glm-5.2')}
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
    expect(screen.queryByLabelText('Workspace')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Sandbox provider')).not.toBeInTheDocument();
    expect(screen.getByTestId('selected-model-id')).toHaveTextContent(
      'openrouter/anthropic/claude-haiku-4.5',
    );
    const toolbarButtons = screen
      .getByRole('button', { name: 'Add attachments' })
      .parentElement?.querySelectorAll('button');
    expect(toolbarButtons?.[0]).toHaveAccessibleName('Add attachments');
    expect(toolbarButtons?.[1]).toHaveAccessibleName('Model for this session');

    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith({
        text: 'Test prompt',
        images: undefined,
        attachmentTexts: undefined,
        model: undefined,
      });
    });

    expect(mockStartFastSession).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/sessions/fast-session-1');
  });

  it('starts a new Fast session with the selected non-default model', async () => {
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Model for this session' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith({
        text: 'Test prompt',
        images: undefined,
        attachmentTexts: undefined,
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

    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => expect(onTaskStarted).toHaveBeenCalledOnce());
  });

  it('starts a Fast session with an image-only prompt', async () => {
    mockPreparePromptAttachments.mockResolvedValueOnce({
      text: '',
      images: ['data:image/png;base64,image-1'],
    });
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith({
        text: '',
        images: ['data:image/png;base64,image-1'],
        attachmentTexts: undefined,
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

  it('starts a Fast session without an environment', async () => {
    currentEnvironments = [];

    render(<Home initialPlaceholderIndex={0} />);

    const submitButton = screen.getByRole('button', { name: 'Submit prompt' });
    expect(submitButton).toBeEnabled();
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith({
        text: 'Test prompt',
        images: undefined,
        attachmentTexts: undefined,
        model: undefined,
      });
    });
    expect(mockStartFastSession).toHaveBeenCalledTimes(1);
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

  it('pins environmentId URL launches with deployment defaults', async () => {
    currentSearchParams = 'environmentId=env-created';

    render(
      <TaskLaunchConfigProvider
        value={{
          defaultComputeProvider: 'modal',
          availableComputeProviders: ['modal', 'docker'],
        }}
      >
        <Home initialPlaceholderIndex={0} />
      </TaskLaunchConfigProvider>,
    );

    expect(screen.getByTestId('selected-model-id')).toHaveTextContent(
      'openrouter/openai/gpt-5.4',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith({
        text: 'Test prompt',
        images: undefined,
        attachmentTexts: undefined,
        model: 'openrouter/openai/gpt-5.4',
        pinnedLaunch: {
          launchId: expect.any(String),
          repo: ALL_REPOSITORIES,
          environmentId: 'env-created',
          harness: 'opencode-server',
          computeProvider: 'modal',
        },
      });
    });
    expect(mockPush).toHaveBeenCalledWith('/task/task-4');
  });

  it('prefills editable prompt and model details from the URL', async () => {
    currentSearchParams = new URLSearchParams({
      prompt: 'Fix the build',
      model: 'openrouter/openai/gpt-5.4',
    }).toString();

    render(<Home initialPlaceholderIndex={0} />);

    expect(screen.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
      'Fix the build',
    );
    expect(screen.getByTestId('selected-model-id')).toHaveTextContent(
      'openrouter/openai/gpt-5.4',
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Task prompt' }), {
      target: { value: 'Fix the tests instead' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Model for this session' }),
    );

    expect(screen.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
      'Fix the tests instead',
    );
    expect(screen.getByTestId('selected-model-id')).toHaveTextContent(
      'openrouter/z-ai/glm-5.2',
    );
  });
});
