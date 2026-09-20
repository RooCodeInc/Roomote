import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import type { PromptInputMessage } from '@/components/ai-elements';
import {
  clearPendingFastSessionLaunch,
  getPendingFastSessionLaunch,
} from '@/lib/pending-fast-session-launch';

let currentSearchParams = '';
let currentIsAdmin = true;
let currentEnvironments: Array<{ id: string; name: string }> | undefined = [
  { id: 'env-1', name: 'Primary Env' },
  { id: 'env-2', name: 'Secondary Env' },
];
let currentEnvironmentsPending = false;
let currentBrainConfigured = false;
let currentPrivateSessionsExperimentEnabled = false;
let currentHomeSuggestions: string[] = [];
let currentHomeSuggestionsHasData = true;
let currentHomeSuggestionsPending = false;
let currentHomeSuggestionsFetching = false;
let currentHomeSuggestionsError = false;
let capturedSubmitWithMetaKey: boolean | undefined;
let capturedAutoFocus: boolean | undefined;
let capturedHomeSuggestionsQueryEnabled: boolean | undefined;
let capturedDefaultReasoningEffort: string | null | undefined;
let submittedPromptText = 'Test prompt';

const {
  voiceState,
  mockPush,
  mockToast,
  mockToastError,
  mockToastSuccess,
  mockProcessImageFiles,
  mockUseLaunchTaskModels,
  mockPreparePromptAttachments,
  mockStartFastSession,
} = vi.hoisted(() => ({
  voiceState: {
    enabled: false,
    active: false,
    start: vi.fn(),
    stop: vi.fn(),
    onUtterance: undefined as ((text: string) => void) | undefined,
  },
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

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: currentHomeSuggestionsHasData
      ? { suggestions: currentHomeSuggestions }
      : undefined,
    isPending: currentHomeSuggestionsPending,
    isFetching: currentHomeSuggestionsFetching,
    isError: currentHomeSuggestionsError,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    home: {
      composerSuggestions: {
        queryOptions: vi.fn(
          (_input, options: { enabled?: boolean } | undefined) => {
            capturedHomeSuggestionsQueryEnabled = options?.enabled;
            return {};
          },
        ),
      },
    },
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
    brainConfigured: currentBrainConfigured,
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

vi.mock('@/hooks/task-runs/useStartFastSession', () => ({
  useStartFastSession: () => ({
    isPending: false,
    mutateAsync: mockStartFastSession,
  }),
}));

vi.mock('@/hooks/useVoiceEnabled', () => ({
  useVoiceEnabled: () => voiceState.enabled,
}));

vi.mock('@/hooks/usePrivateSessionsExperiment', () => ({
  usePrivateSessionsExperiment: () => ({
    enabled: currentPrivateSessionsExperimentEnabled,
  }),
}));

vi.mock('@/hooks/useLiveVoice', () => ({
  useLiveVoice: ({ onUtterance }: { onUtterance: (text: string) => void }) => {
    voiceState.onUtterance = onUtterance;
    return {
      active: voiceState.active,
      status: voiceState.active ? 'listening' : 'idle',
      start: voiceState.start,
      stop: voiceState.stop,
      speak: vi.fn(),
      addContext: vi.fn(),
    };
  },
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
  return {
    ...actual,
    TaskPromptInput: ({
      onSubmit,
      onPromptTextChange,
      promptText,
      placeholder,
      promptSuggestion,
      onPromptFocusChange,
      autoFocus,
      submitDisabledReason,
      submitWithMetaKey,
      tools,
      submitLeadingAction,
      voice,
    }: {
      onSubmit: (message: PromptInputMessage) => Promise<void> | void;
      onPromptTextChange?: (value: string) => void;
      promptText?: string;
      placeholder?: string;
      promptSuggestion?: string;
      onPromptFocusChange?: (focused: boolean) => void;
      autoFocus?: boolean;
      submitDisabledReason?: string;
      submitWithMetaKey?: boolean;
      tools?: import('react').ReactNode;
      submitLeadingAction?: import('react').ReactNode;
      voice?: { active: boolean; onToggle: () => void };
    }) => {
      capturedSubmitWithMetaKey = submitWithMetaKey;
      capturedAutoFocus = autoFocus;

      return (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (submitDisabledReason) {
              return;
            }
            onPromptTextChange?.(submittedPromptText);
            const result = onSubmit({ text: submittedPromptText, files: [] });

            if (result instanceof Promise) {
              void result.catch(() => {});
            }
          }}
        >
          <button type="button" aria-label="Add attachments">
            +
          </button>
          {tools}
          {voice ? (
            <button
              type="button"
              aria-label="Voice conversation"
              onClick={voice.onToggle}
            >
              Voice
            </button>
          ) : null}
          <div data-testid="prompt-placeholder">
            {promptText ? placeholder : (promptSuggestion ?? placeholder)}
          </div>
          <textarea
            aria-label="Task prompt"
            placeholder={
              promptText ? placeholder : (promptSuggestion ?? placeholder)
            }
            value={promptText ?? ''}
            onChange={(event) => onPromptTextChange?.(event.target.value)}
            onFocus={() => onPromptFocusChange?.(true)}
            onBlur={() => onPromptFocusChange?.(false)}
          />
          {submitLeadingAction}
          <button type="submit" disabled={Boolean(submitDisabledReason)}>
            Submit prompt
          </button>
        </form>
      );
    },
    SessionModelSwitcher: ({
      model,
      onModelChange,
      onReasoningEffortChange,
      defaultModelId,
      defaultReasoningEffort,
    }: {
      model: string;
      onModelChange: (value: string) => void;
      onReasoningEffortChange: (value: 'high') => void;
      defaultModelId?: string;
      defaultReasoningEffort?: string | null;
    }) => {
      capturedDefaultReasoningEffort = defaultReasoningEffort;

      return (
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
          <button type="button" onClick={() => onModelChange('')}>
            Use default model
          </button>
          <button type="button" onClick={() => onReasoningEffortChange('high')}>
            Use high reasoning
          </button>
        </div>
      );
    },
  };
});

describe('Home', () => {
  beforeEach(() => {
    voiceState.enabled = false;
    voiceState.active = false;
    voiceState.start.mockReset();
    voiceState.stop.mockReset();
    voiceState.onUtterance = undefined;
    currentSearchParams = '';
    currentIsAdmin = true;
    currentEnvironments = [
      { id: 'env-1', name: 'Primary Env' },
      { id: 'env-2', name: 'Secondary Env' },
    ];
    currentEnvironmentsPending = false;
    currentBrainConfigured = false;
    currentPrivateSessionsExperimentEnabled = false;
    currentHomeSuggestions = [];
    currentHomeSuggestionsHasData = true;
    currentHomeSuggestionsPending = false;
    currentHomeSuggestionsFetching = false;
    currentHomeSuggestionsError = false;
    capturedSubmitWithMetaKey = undefined;
    capturedAutoFocus = undefined;
    capturedHomeSuggestionsQueryEnabled = undefined;
    capturedDefaultReasoningEffort = undefined;
    submittedPromptText = 'Test prompt';
    localStorage.clear();
    vi.clearAllMocks();

    mockProcessImageFiles.mockResolvedValue([]);
    mockPreparePromptAttachments.mockImplementation(
      ({ text }: { text: string }) => Promise.resolve({ text }),
    );
    mockStartFastSession.mockResolvedValue({
      sessionId: '11111111-1111-4111-8111-111111111111',
      fastConversationId: '22222222-2222-4222-8222-222222222222',
      taskId: 'task-4',
    });
    clearPendingFastSessionLaunch('11111111-1111-4111-8111-111111111111');
    mockUseLaunchTaskModels.mockReturnValue({
      data: {
        defaultModelId: 'openrouter/openai/gpt-5.4',
        defaultReasoningEffort: 'medium',
        defaultFastModelId: 'openrouter/anthropic/claude-haiku-4.5',
        defaultFastReasoningEffort: 'low',
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
    render(<Home initialHeading="Let's cook!" initialPlaceholderIndex={0} />);

    expect(screen.getByRole('heading', { name: "Let's cook!" })).toHaveClass(
      'animate-[enter-down_1s_1]',
    );
    expect(
      screen.getByRole('textbox', { name: 'Task prompt' }).closest('form')
        ?.parentElement,
    ).toHaveClass('animate-[enter-down_1s_1_100ms_backwards]');
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
    expect(
      screen.queryByRole('switch', { name: 'Start a private Session' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Model for this session' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith({
        text: 'Test prompt',
        images: undefined,
        attachmentTexts: undefined,
        model: undefined,
        conversationId: expect.any(String),
      });
    });

    expect(mockStartFastSession).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(
      '/sessions/11111111-1111-4111-8111-111111111111',
    );
    expect(
      getPendingFastSessionLaunch('11111111-1111-4111-8111-111111111111'),
    ).toEqual(
      expect.objectContaining({
        fastConversationId: '22222222-2222-4222-8222-222222222222',
        text: 'Test prompt',
      }),
    );
  });

  it('retains the private Session selection and sends it with creation', async () => {
    currentPrivateSessionsExperimentEnabled = true;
    const { rerender } = render(<NewTaskForm initialPrompt="First prompt" />);

    const toggle = screen.getByRole('button', {
      name: 'Private session',
    });
    expect(toggle.querySelector('.lucide-hat-glasses')).toBeInTheDocument();
    expect(
      toggle.compareDocumentPosition(
        screen.getByRole('button', { name: 'Submit prompt' }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);

    rerender(<NewTaskForm initialPrompt="Reset prompt" />);
    expect(
      screen.getByRole('button', { name: 'Private session' }),
    ).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith(
        expect.objectContaining({ privacy: 'private' }),
      );
    });
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
        conversationId: expect.any(String),
      });
    });
  });

  it('starts a new Fast session on the default after resetting the model', async () => {
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Model for this session' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use default model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith({
        text: 'Test prompt',
        images: undefined,
        attachmentTexts: undefined,
        model: undefined,
        conversationId: expect.any(String),
      });
    });
  });

  it('uses the shared plain-Enter submission mode', () => {
    render(<Home initialPlaceholderIndex={0} />);

    expect(capturedSubmitWithMetaKey).toBe(false);
  });

  it('shows the deployment Fast reasoning default', () => {
    render(<Home initialPlaceholderIndex={0} />);

    expect(capturedDefaultReasoningEffort).toBe('low');
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
        conversationId: expect.any(String),
      });
    });
    expect(mockPush).toHaveBeenCalledWith(
      '/sessions/11111111-1111-4111-8111-111111111111',
    );
  });

  it('hands off seeded presence for an attachment-only Fast session', async () => {
    mockPreparePromptAttachments.mockResolvedValueOnce({
      text: '',
      attachmentTexts: ['Attachment contents'],
    });
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => expect(mockStartFastSession).toHaveBeenCalledOnce());
    const conversationId =
      mockStartFastSession.mock.calls[0]![0].conversationId;
    expect(
      getPendingFastSessionLaunch('11111111-1111-4111-8111-111111111111'),
    ).toEqual(
      expect.objectContaining({
        presenceClientId: conversationId,
      }),
    );
  });

  it('cycles prompt placeholders every 10 seconds from a random starting point', async () => {
    vi.useFakeTimers();

    try {
      render(<Home initialPlaceholderIndex={3} />);

      expect(screen.getByTestId('prompt-placeholder')).toHaveTextContent(
        'Review this pull request and address the feedback',
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_999);
      });

      expect(screen.getByTestId('prompt-placeholder')).toHaveTextContent(
        'Review this pull request and address the feedback',
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(screen.getByTestId('prompt-placeholder')).toHaveTextContent(
        'Investigate why this test is flaky and fix it',
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });

      expect(screen.getByTestId('prompt-placeholder')).toHaveTextContent(
        'Find a TODO in the code and fix it',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses fallback placeholders while personalized suggestions are unavailable', async () => {
    vi.useFakeTimers();
    currentBrainConfigured = true;

    try {
      render(<Home initialPlaceholderIndex={0} />);
      const textarea = screen.getByRole('textbox', { name: 'Task prompt' });

      expect(capturedHomeSuggestionsQueryEnabled).toBe(true);
      expect(screen.getByTestId('prompt-placeholder')).toHaveTextContent(
        'Find a TODO in the code and fix it',
      );
      fireEvent.focus(textarea);
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

  it('requests personalized suggestions when Brain is enabled', () => {
    currentBrainConfigured = true;

    render(<Home initialPlaceholderIndex={0} />);

    expect(capturedHomeSuggestionsQueryEnabled).toBe(true);
  });

  it('does not autofocus Home', () => {
    render(<Home initialPlaceholderIndex={0} />);

    expect(
      screen.getByRole('textbox', { name: 'Task prompt' }),
    ).not.toHaveFocus();
    expect(capturedAutoFocus).toBe(false);
  });

  it('cycles generated memory suggestions using the existing timing', async () => {
    vi.useFakeTimers();
    currentBrainConfigured = true;
    currentHomeSuggestions = [
      'Add regression coverage for recent authentication fixes',
      'Review the latest deployment reliability follow-ups',
      'Document the new session handoff behavior clearly',
      'Investigate recent flaky integration test failures',
      'Ship the pending accessibility improvements safely',
    ];

    try {
      render(<Home initialPlaceholderIndex={0} />);

      expect(screen.getByTestId('prompt-placeholder')).toHaveTextContent(
        currentHomeSuggestions[0]!,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(screen.getByTestId('prompt-placeholder')).toHaveTextContent(
        currentHomeSuggestions[1]!,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(screen.getByTestId('prompt-placeholder')).toHaveTextContent(
        currentHomeSuggestions[4]!,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the suggestion area empty during the initial request', () => {
    currentBrainConfigured = true;
    currentHomeSuggestionsHasData = false;
    currentHomeSuggestionsPending = true;

    render(<Home initialPlaceholderIndex={0} />);

    expect(screen.getByTestId('prompt-placeholder')).toBeEmptyDOMElement();
    expect(
      screen.getByRole('textbox', { name: 'Task prompt' }),
    ).toHaveAttribute('placeholder', '');
  });

  it('shows generated suggestions after the initial request succeeds', () => {
    currentBrainConfigured = true;
    currentHomeSuggestions = [
      'Add focused regression tests for authentication callback validation across supported login flows',
      'Resolve deployment health check gaps before the next production release begins',
      'Document session handoff behavior for developers troubleshooting interrupted task execution',
      'Investigate flaky integration failures affecting automated pull request delivery checks',
      'Improve accessibility guidance for keyboard users accepting Home composer suggestions',
    ];

    render(<Home initialPlaceholderIndex={0} />);

    expect(screen.getByTestId('prompt-placeholder')).toHaveTextContent(
      currentHomeSuggestions[0]!,
    );
  });

  it.each([
    { state: 'empty', hasData: true, isError: false },
    { state: 'error', hasData: false, isError: true },
  ])(
    'shows fallback placeholders after a settled $state result',
    ({ hasData, isError }) => {
      currentBrainConfigured = true;
      currentHomeSuggestionsHasData = hasData;
      currentHomeSuggestionsError = isError;

      render(<Home initialPlaceholderIndex={0} />);

      expect(screen.getByTestId('prompt-placeholder')).toHaveTextContent(
        'Find a TODO in the code and fix it',
      );
    },
  );

  it('keeps cached suggestions visible during a background refresh', () => {
    currentBrainConfigured = true;
    currentHomeSuggestionsFetching = true;
    currentHomeSuggestions = [
      'Add focused regression tests for authentication callback validation across supported login flows',
      'Resolve deployment health check gaps before the next production release begins',
      'Document session handoff behavior for developers troubleshooting interrupted task execution',
      'Investigate flaky integration failures affecting automated pull request delivery checks',
      'Improve accessibility guidance for keyboard users accepting Home composer suggestions',
    ];

    render(<Home initialPlaceholderIndex={0} />);

    expect(screen.getByTestId('prompt-placeholder')).toHaveTextContent(
      currentHomeSuggestions[0]!,
    );
  });

  it('pauses suggestion rotation while focused and resumes after blur', async () => {
    vi.useFakeTimers();
    currentBrainConfigured = true;
    currentHomeSuggestions = [
      'Add focused regression tests for authentication callback validation across supported login flows',
      'Resolve deployment health check gaps before the next production release begins',
      'Document session handoff behavior for developers troubleshooting interrupted task execution',
      'Investigate flaky integration failures affecting automated pull request delivery checks',
      'Improve accessibility guidance for keyboard users accepting Home composer suggestions',
    ];

    try {
      render(<Home initialPlaceholderIndex={0} />);
      const textarea = screen.getByRole('textbox', { name: 'Task prompt' });

      fireEvent.focus(textarea);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(screen.getByTestId('prompt-placeholder')).toHaveTextContent(
        currentHomeSuggestions[0]!,
      );

      fireEvent.blur(textarea);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(screen.getByTestId('prompt-placeholder')).toHaveTextContent(
        currentHomeSuggestions[1]!,
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
        conversationId: expect.any(String),
      });
    });
    expect(mockStartFastSession).toHaveBeenCalledTimes(1);
  });

  it('reuses the client conversation identity after an ambiguous start failure', async () => {
    mockStartFastSession
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValueOnce({
        sessionId: '11111111-1111-4111-8111-111111111111',
        fastConversationId: '22222222-2222-4222-8222-222222222222',
      });
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Connection lost',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mockStartFastSession).toHaveBeenCalledTimes(2));

    expect(mockStartFastSession.mock.calls[0]?.[0].conversationId).toBe(
      mockStartFastSession.mock.calls[1]?.[0].conversationId,
    );
  });

  it('uses a new conversation identity when an ambiguous retry changes', async () => {
    mockStartFastSession
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValueOnce({
        sessionId: '11111111-1111-4111-8111-111111111111',
        fastConversationId: '22222222-2222-4222-8222-222222222222',
      });
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Connection lost',
    );
    submittedPromptText = 'Corrected prompt';
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));
    await waitFor(() => expect(mockStartFastSession).toHaveBeenCalledTimes(2));

    expect(mockStartFastSession.mock.calls[0]?.[0].conversationId).not.toBe(
      mockStartFastSession.mock.calls[1]?.[0].conversationId,
    );
    expect(mockStartFastSession.mock.calls[1]?.[0].text).toBe(
      'Corrected prompt',
    );
  });

  it('renders onboarding guidance on Home', () => {
    render(<Home initialPlaceholderIndex={0} />);

    expect(screen.getByText('Onboarding')).toBeInTheDocument();
  });

  it('treats a legacy environment URL as an ordinary Session launch', async () => {
    currentSearchParams = 'environmentId=env-created';
    render(<Home initialPlaceholderIndex={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use high reasoning' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => expect(mockStartFastSession).toHaveBeenCalled());
    expect(mockStartFastSession.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ text: 'Test prompt', reasoningEffort: 'high' }),
    );
    expect(mockStartFastSession.mock.calls[0]?.[0]).not.toHaveProperty(
      'pinnedLaunch',
    );
    expect(mockPush).not.toHaveBeenCalledWith('/task/task-4');
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

  it('hides the voice conversation button when voice is not configured', async () => {
    render(<Home initialPlaceholderIndex={0} />);
    await screen.findByRole('button', { name: 'Submit prompt' });
    expect(
      screen.queryByRole('button', { name: 'Voice conversation' }),
    ).not.toBeInTheDocument();
  });

  it('opens a Session for the call, sending anything already typed, and starts voice there', async () => {
    voiceState.enabled = true;
    mockStartFastSession.mockResolvedValue({ sessionId: 'fast-session-1' });
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Voice conversation' }),
    );

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '',
          voiceCall: true,
          conversationId: expect.any(String),
        }),
      );
    });
    // No call is opened on the home page itself; the Session page owns it.
    expect(voiceState.start).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/sessions/fast-session-1?voice=1');
  });

  it('opens an owner-only private Session for a private voice call', async () => {
    currentPrivateSessionsExperimentEnabled = true;
    voiceState.enabled = true;
    mockStartFastSession.mockResolvedValue({ sessionId: 'private-session-1' });
    render(<Home initialPlaceholderIndex={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Private session' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Voice conversation' }),
    );

    await waitFor(() => {
      expect(mockStartFastSession).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '',
          privacy: 'private',
          voiceCall: true,
          conversationId: expect.any(String),
        }),
      );
    });
    expect(mockPush).toHaveBeenCalledWith(
      '/sessions/private-session-1?voice=1',
    );
  });
});
