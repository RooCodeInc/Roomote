import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  SETUP_RECEIPT_INPUT_KIND,
} from '@roomote/types';

import {
  FastSessionTranscript,
  pendingResponseReducer,
} from './FastSessionTranscript';
import { SessionRunningTaskCountContext } from './session-task-panel-context';

const {
  replyMutate,
  reviewActionMutate,
  updateModelSelectionMutate,
  preparePromptAttachments,
  openTaskPanel,
  openTasksPanel,
  narrationState,
} = vi.hoisted(() => ({
  replyMutate: vi.fn(),
  reviewActionMutate: vi.fn(),
  updateModelSelectionMutate: vi.fn(),
  preparePromptAttachments: vi.fn(),
  openTaskPanel: vi.fn(),
  openTasksPanel: vi.fn(),
  narrationState: { enabled: false },
}));

vi.mock('@/hooks/useNarrationMode', () => ({
  useNarrationMode: () => ({ enabled: narrationState.enabled }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPCClient: () => ({
    fastSessions: {
      reply: { mutate: replyMutate },
      reviewAction: { mutate: reviewActionMutate },
      updateModelSelection: { mutate: updateModelSelectionMutate },
    },
  }),
  useTRPC: () => ({
    fastSessions: {
      composerSuggestion: {
        queryOptions: (input: unknown, options?: Record<string, unknown>) => ({
          ...options,
          queryKey: ['fastSessions.composerSuggestion', input],
          queryFn: async () => ({ suggestion: null, messageCount: 0 }),
        }),
      },
    },
  }),
}));

// The session composer's suggestion query needs no QueryClientProvider here;
// these tests exercise the transcript, not suggestions.
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: () => ({ data: undefined }),
}));

vi.mock('./SessionModelSwitcher', () => ({
  SessionModelSwitcher: ({
    model,
    onModelChange,
    reasoningEffort,
    onReasoningEffortChange,
    disabled,
  }: {
    model: string;
    onModelChange: (model: string) => void;
    reasoningEffort: string | null;
    onReasoningEffortChange: (effort: 'high') => void;
    disabled?: boolean;
  }) => (
    <div>
      <span data-testid="session-model">{model}</span>
      <span data-testid="session-reasoning">{reasoningEffort}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onModelChange('openrouter/z-ai/glm-5.2')}
      >
        Use GLM 5.2
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onReasoningEffortChange('high')}
      >
        Use high reasoning
      </button>
    </div>
  ),
}));

vi.mock('@/lib/prompt-attachments', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/prompt-attachments')
  >('@/lib/prompt-attachments');

  return {
    ...actual,
    preparePromptAttachments,
  };
});

vi.mock('@/hooks/task-models/useLaunchTaskModels', () => ({
  useLaunchTaskModels: () => ({
    data: { models: [], defaultModelId: undefined },
    isPending: false,
  }),
}));

vi.mock('./session-task-panel-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-task-panel-context')>()),
  useOpenSessionTaskPanel: () => openTaskPanel,
  useOpenSessionTasksPanel: () => openTasksPanel,
}));

vi.mock('../../task/[taskId]/messages/acp/DelegatedTaskCard', () => ({
  DelegatedTaskCard: ({
    taskId,
    onOpen,
  }: {
    taskId: string;
    onOpen: (taskId: string) => void;
  }) => (
    <button type="button" onClick={() => onOpen(taskId)}>
      Delegated task {taskId}
    </button>
  ),
}));

vi.mock('./SessionUserInputCard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./SessionUserInputCard')>()),
  SessionUserInputCard: () => <div>Structured input request</div>,
}));

vi.mock('./setup/SetupStarterTasksCard', () => ({
  SetupStarterTasksCard: () => <div>Setup starter tasks</div>,
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {}

  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  replyMutate.mockReset();
  reviewActionMutate.mockReset();
  updateModelSelectionMutate.mockReset();
  preparePromptAttachments.mockImplementation(({ text }: { text: string }) =>
    Promise.resolve({ text }),
  );
  narrationState.enabled = false;
  openTaskPanel.mockReset();
  openTasksPanel.mockReset();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FastSessionTranscript', () => {
  const textMessage = ({
    id,
    role,
    text,
    ts,
    visible = true,
    turnSeq = role === 'user' ? 0 : 1,
    inputKind,
  }: {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    ts: number;
    visible?: boolean;
    turnSeq?: number;
    inputKind?: string;
  }) => ({
    id,
    eventId: `${id}:event`,
    turnId: `${id}:turn`,
    turnSeq,
    ts,
    eventType:
      role === 'user'
        ? ACP_ENVELOPE_EVENT_TYPES.UserPrompt
        : ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
    role,
    contentBlocks: [{ type: 'text' as const, text }],
    metadata: {
      visibleInTranscript: visible,
      ...(inputKind ? { inputKind } : {}),
    },
    payload: {},
    source: 'web',
    nativeSessionId: role === 'assistant' ? 'opencode-1' : null,
    nativeMessageId: null,
    createdAt: new Date(ts),
  });

  describe('pendingResponseReducer', () => {
    const emptyState = {
      pendingAfter: null,
      latestVisibleResponse: null,
      optimisticRollback: null,
    };

    it('does not treat transcript-only setup receipts as pending model input', () => {
      const receipt = textMessage({
        id: 'setup-receipt',
        role: 'user',
        text: 'Sandbox configured with Modal.',
        ts: 2,
        inputKind: SETUP_RECEIPT_INPUT_KIND,
      });

      const next = pendingResponseReducer(emptyState, {
        type: 'messages',
        newEventIds: new Set([receipt.eventId]),
        messages: [receipt],
      });

      expect(next.pendingAfter).toBeNull();
    });

    it('uses the same ordering and visibility rules for hydration and streamed messages', () => {
      const hydrated = pendingResponseReducer(emptyState, {
        type: 'hydrate',
        messages: [
          textMessage({
            id: 'user-1',
            role: 'user',
            text: 'Question',
            ts: 2,
          }),
          textMessage({
            id: 'hidden-1',
            role: 'assistant',
            text: 'Internal activity',
            ts: 3,
            visible: false,
          }),
        ],
      });

      const afterStaleOutput = pendingResponseReducer(hydrated, {
        type: 'messages',
        newEventIds: new Set(),
        messages: [
          textMessage({
            id: 'stale-assistant',
            role: 'assistant',
            text: 'Earlier output',
            ts: 2,
            turnSeq: -1,
          }),
        ],
      });
      expect(afterStaleOutput.pendingAfter?.id).toBe('user-1');

      const afterVisibleOutput = pendingResponseReducer(afterStaleOutput, {
        type: 'messages',
        newEventIds: new Set(['assistant-1:event']),
        messages: [
          textMessage({
            id: 'assistant-1',
            role: 'assistant',
            text: 'Answer',
            ts: 3,
          }),
        ],
      });
      expect(afterVisibleOutput.pendingAfter).toBeNull();

      const afterStaleUserReplay = pendingResponseReducer(afterVisibleOutput, {
        type: 'messages',
        newEventIds: new Set(),
        messages: [
          textMessage({
            id: 'stale-user',
            role: 'user',
            text: 'Replayed question',
            ts: 2,
          }),
        ],
      });
      expect(afterStaleUserReplay.pendingAfter).toBeNull();
    });

    it('keeps a tied new user pending when the same batch replays the latest response', () => {
      const latestResponse = textMessage({
        id: 'assistant-1',
        role: 'assistant',
        text: 'Answer',
        ts: 2,
      });
      const hydrated = pendingResponseReducer(emptyState, {
        type: 'hydrate',
        messages: [latestResponse],
      });
      const nextUser = textMessage({
        id: 'user-2',
        role: 'user',
        text: 'Follow up',
        ts: latestResponse.ts,
      });

      const next = pendingResponseReducer(hydrated, {
        type: 'messages',
        messages: [nextUser, latestResponse],
        newEventIds: new Set([nextUser.eventId]),
      });

      expect(next.pendingAfter?.id).toBe(nextUser.id);
    });

    it('restores an optimistic fallback only while that message owns pending state', () => {
      const earlierPending = pendingResponseReducer(emptyState, {
        type: 'hydrate',
        messages: [
          textMessage({
            id: 'user-1',
            role: 'user',
            text: 'Earlier question',
            ts: 1,
          }),
        ],
      });
      const optimistic = textMessage({
        id: 'optimistic-1',
        role: 'user',
        text: 'Later question',
        ts: 2,
      });
      const optimisticPending = pendingResponseReducer(earlierPending, {
        type: 'optimistic',
        message: optimistic,
      });

      expect(
        pendingResponseReducer(optimisticPending, {
          type: 'rollbackOptimistic',
          optimisticId: optimistic.id,
        }).pendingAfter?.id,
      ).toBe('user-1');

      const resolved = pendingResponseReducer(optimisticPending, {
        type: 'messages',
        newEventIds: new Set(['assistant-1:event']),
        messages: [
          textMessage({
            id: 'assistant-1',
            role: 'assistant',
            text: 'Answer',
            ts: 3,
          }),
        ],
      });
      expect(
        pendingResponseReducer(resolved, {
          type: 'rollbackOptimistic',
          optimisticId: optimistic.id,
        }).pendingAfter,
      ).toBeNull();
    });
  });

  it('removes a structured-input card when its response control event arrives', () => {
    const requestId = 'rui:setup-starters';
    const request = {
      ...textMessage({
        id: 'starter-request',
        role: 'assistant',
        text: 'Choose starter tasks',
        ts: 1,
      }),
      eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
      payload: {
        requestId,
        status: 'pending',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        preset: 'setup_starter_tasks',
        questions: [
          {
            id: 'starters',
            question: 'What should I work on first?',
            multiple: true,
            isOther: false,
            isSecret: false,
            options: [{ label: 'Speed up CI', description: 'Improve CI.' }],
          },
        ],
      },
    };
    const response = {
      ...textMessage({
        id: 'starter-response',
        role: 'user',
        text: 'Structured response',
        ts: 2,
      }),
      eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
      payload: {
        requestId,
        answers: { starters: { answers: ['Speed up CI'] } },
        resolution: 'submitted',
      },
    };

    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[request, response]}
      />,
    );

    expect(screen.queryByText('Structured input request')).toBeNull();
    expect(screen.queryByText('Structured response')).toBeNull();
  });

  it.each([
    [1, '1 task running'],
    [2, '2 tasks running'],
  ])('shows the running task count as %s', (runningTaskCount, label) => {
    render(
      <SessionRunningTaskCountContext.Provider value={runningTaskCount}>
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[
            textMessage({
              id: 'user-1',
              role: 'user',
              text: 'Start tasks',
              ts: 1,
            }),
            textMessage({
              id: 'assistant-1',
              role: 'assistant',
              text: 'Tasks launched',
              ts: 2,
            }),
          ]}
          canReply
        />
      </SessionRunningTaskCountContext.Provider>,
    );

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(label);
    expect(status.closest('.chat-reasoning-message')).toHaveClass(
      'is-assistant',
    );
  });

  it('removes the running task indicator when the count returns to zero', () => {
    const { rerender } = render(
      <SessionRunningTaskCountContext.Provider value={1}>
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[
            textMessage({
              id: 'user-1',
              role: 'user',
              text: 'Start tasks',
              ts: 1,
            }),
            textMessage({
              id: 'assistant-1',
              role: 'assistant',
              text: 'Tasks launched',
              ts: 2,
            }),
          ]}
          canReply
        />
      </SessionRunningTaskCountContext.Provider>,
    );
    expect(screen.getByText('1 task running')).toBeInTheDocument();

    rerender(
      <SessionRunningTaskCountContext.Provider value={0}>
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[
            textMessage({
              id: 'user-1',
              role: 'user',
              text: 'Start tasks',
              ts: 1,
            }),
            textMessage({
              id: 'assistant-1',
              role: 'assistant',
              text: 'Tasks launched',
              ts: 2,
            }),
          ]}
          canReply
        />
      </SessionRunningTaskCountContext.Provider>,
    );

    expect(screen.queryByText('1 task running')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('opens the tasks panel from a keyboard-focusable activity button', () => {
    render(
      <SessionRunningTaskCountContext.Provider value={1}>
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[
            textMessage({
              id: 'user-1',
              role: 'user',
              text: 'Start tasks',
              ts: 1,
            }),
            textMessage({
              id: 'assistant-1',
              role: 'assistant',
              text: 'Tasks launched',
              ts: 2,
            }),
          ]}
          canReply
        />
      </SessionRunningTaskCountContext.Provider>,
    );

    const button = screen.getByRole('button', {
      name: '1 task running. Open task',
    });
    button.focus();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('type', 'button');
    fireEvent.click(button);

    expect(openTasksPanel).toHaveBeenCalledOnce();
  });

  it('shows the task indicator only after the session response finishes', () => {
    render(
      <SessionRunningTaskCountContext.Provider value={1}>
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[
            textMessage({
              id: 'user-1',
              role: 'user',
              text: 'Start tasks',
              ts: 1,
            }),
          ]}
          canReply
        />
      </SessionRunningTaskCountContext.Provider>,
    );

    expect(screen.queryByText('1 task running')).not.toBeInTheDocument();
    act(() => {
      FakeEventSource.instances[0]!.emit('messages', {
        messages: [
          textMessage({
            id: 'assistant-1',
            role: 'assistant',
            text: 'Tasks launched',
            ts: 2,
          }),
        ],
      });
    });

    expect(screen.getByText('1 task running')).toBeInTheDocument();
  });

  it('keeps running task activity visible when a Session is loaded directly', () => {
    render(
      <SessionRunningTaskCountContext.Provider value={1}>
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[
            textMessage({
              id: 'user-1',
              role: 'user',
              text: 'Start tasks',
              ts: 1,
            }),
            textMessage({
              id: 'assistant-1',
              role: 'assistant',
              text: 'Tasks launched',
              ts: 2,
            }),
          ]}
          canReply
        />
      </SessionRunningTaskCountContext.Provider>,
    );

    expect(screen.getByText('1 task running')).toBeInTheDocument();

    act(() => {
      FakeEventSource.instances[0]!.emit('messages', {
        conversationResponding: true,
        messages: [
          textMessage({
            id: 'assistant-1',
            role: 'assistant',
            text: 'Tasks launched',
            ts: 2,
          }),
        ],
      });
    });
    expect(screen.getByText('1 task running')).toBeInTheDocument();

    act(() => {
      FakeEventSource.instances[0]!.emit('session', {
        conversationResponding: true,
      });
    });
    expect(screen.getByText('1 task running')).toBeInTheDocument();

    act(() => {
      FakeEventSource.instances[0]!.emit('open', null);
      FakeEventSource.instances[0]!.emit('session', {
        conversationResponding: true,
      });
    });
    expect(screen.getByText('1 task running')).toBeInTheDocument();

    act(() => {
      FakeEventSource.instances[0]!.emit('session', {
        conversationResponding: false,
      });
    });
    expect(screen.getByText('1 task running')).toBeInTheDocument();

    act(() => {
      FakeEventSource.instances[0]!.emit('session', {
        conversationResponding: true,
      });
    });
    expect(screen.queryByText('1 task running')).not.toBeInTheDocument();

    act(() => {
      FakeEventSource.instances[0]!.emit('session', {
        conversationResponding: false,
      });
    });
    expect(screen.getByText('1 task running')).toBeInTheDocument();
  });

  it('applies streamed parent activity with visible output atomically', () => {
    render(
      <SessionRunningTaskCountContext.Provider value={1}>
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[
            textMessage({
              id: 'user-1',
              role: 'user',
              text: 'Start tasks',
              ts: 1,
            }),
            textMessage({
              id: 'assistant-1',
              role: 'assistant',
              text: 'Tasks launched',
              ts: 2,
            }),
          ]}
          canReply
        />
      </SessionRunningTaskCountContext.Provider>,
    );
    expect(screen.getByText('1 task running')).toBeInTheDocument();

    act(() => {
      FakeEventSource.instances[0]!.emit('messages', {
        conversationResponding: true,
        messages: [
          textMessage({
            id: 'assistant-2',
            role: 'assistant',
            text: 'Parent output is streaming',
            ts: 3,
          }),
        ],
      });
    });

    expect(screen.getByText('Parent output is streaming')).toBeInTheDocument();
    expect(screen.queryByText('1 task running')).not.toBeInTheDocument();
  });

  it('shows Thinking while the initial Fast turn is awaiting output', () => {
    render(
      <FastSessionTranscript sessionId="session-1" initialMessages={[]} />,
    );

    expect(screen.getByText('Thinking')).toBeInTheDocument();
  });

  it('shows Thinking after a follow-up until streamed output arrives', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2);
    replyMutate.mockResolvedValue({ success: true });
    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[
          textMessage({
            id: 'user-1',
            role: 'user',
            text: 'First question',
            ts: 1,
          }),
          textMessage({
            id: 'assistant-1',
            role: 'assistant',
            text: 'First answer',
            ts: 2,
          }),
        ]}
        canReply
      />,
    );

    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
    const input = screen.getByPlaceholderText('Message agent');
    fireEvent.change(input, { target: { value: 'Follow up' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });

    expect(await screen.findByText('Thinking')).toBeInTheDocument();
    act(() => {
      FakeEventSource.instances[0]!.emit('messages', {
        messages: [
          textMessage({
            id: 'stale-assistant',
            role: 'assistant',
            text: 'Replayed earlier output',
            ts: 2,
            turnSeq: -1,
          }),
          textMessage({
            id: 'lifecycle-2',
            role: 'assistant',
            text: 'Internal lifecycle update',
            ts: Date.now(),
            visible: false,
          }),
        ],
      });
    });
    expect(screen.getByText('Thinking')).toBeInTheDocument();

    act(() => {
      FakeEventSource.instances[0]!.emit('messages', {
        messages: [
          textMessage({
            id: 'assistant-2',
            role: 'assistant',
            text: 'Follow-up answer',
            ts: Date.now() + 1,
          }),
        ],
      });
    });

    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
    expect(screen.getByText('Follow-up answer')).toBeInTheDocument();
  });

  it('clears Thinking when a follow-up send fails', async () => {
    replyMutate.mockRejectedValue(new Error('turn is busy'));
    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[
          textMessage({
            id: 'user-1',
            role: 'user',
            text: 'First question',
            ts: 1,
          }),
          textMessage({
            id: 'assistant-1',
            role: 'assistant',
            text: 'First answer',
            ts: 2,
          }),
        ]}
        canReply
      />,
    );

    const input = screen.getByPlaceholderText('Message agent');
    fireEvent.change(input, { target: { value: 'Retry this' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });

    expect(await screen.findByText('turn is busy')).toBeInTheDocument();
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
  });

  it('keeps Thinking for an earlier pending response when a later send fails', async () => {
    replyMutate.mockRejectedValue(new Error('turn is busy'));
    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[
          textMessage({
            id: 'user-1',
            role: 'user',
            text: 'Earlier pending follow-up',
            ts: 1,
          }),
        ]}
        canReply
      />,
    );

    const input = screen.getByPlaceholderText('Message agent');
    fireEvent.change(input, { target: { value: 'Rejected follow-up' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });

    expect(await screen.findByText('turn is busy')).toBeInTheDocument();
    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.getByText('Earlier pending follow-up')).toBeInTheDocument();
    expect(screen.getByRole('log')).not.toHaveTextContent('Rejected follow-up');
  });

  it('does not restore an earlier pending response that resolves during attachment preparation', async () => {
    let finishPreparing: ((value: { text: string }) => void) | undefined;
    preparePromptAttachments.mockReturnValueOnce(
      new Promise((resolve) => {
        finishPreparing = resolve;
      }),
    );
    replyMutate.mockRejectedValue(new Error('turn is busy'));
    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[
          textMessage({
            id: 'user-1',
            role: 'user',
            text: 'Earlier pending follow-up',
            ts: 1,
          }),
        ]}
        canReply
      />,
    );

    const input = screen.getByPlaceholderText('Message agent');
    fireEvent.change(input, { target: { value: 'Later follow-up' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });
    await waitFor(() => expect(preparePromptAttachments).toHaveBeenCalled());

    act(() => {
      FakeEventSource.instances[0]!.emit('messages', {
        messages: [
          textMessage({
            id: 'assistant-1',
            role: 'assistant',
            text: 'Earlier response',
            ts: 2,
          }),
        ],
      });
    });
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();

    await act(async () => {
      finishPreparing?.({ text: 'Later follow-up' });
    });

    expect(await screen.findByText('turn is busy')).toBeInTheDocument();
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
    expect(screen.getByText('Earlier response')).toBeInTheDocument();
  });

  const reviewOfferMessage = (status = 'pending') => ({
    id: 'offer-1',
    eventId: 'turn-offer:assistant:0',
    turnId: 'turn-offer',
    turnSeq: 1,
    ts: 2,
    eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
    role: 'assistant' as const,
    contentBlocks: [
      { type: 'text' as const, text: 'Review feedback remains.' },
    ],
    metadata: { visibleInTranscript: true },
    payload: {
      prReviewAction: {
        deliveryId: '11111111-1111-4111-8111-111111111111',
        question: 'Would you like me to resolve these issues?',
        status,
      },
    },
    source: 'web',
    nativeSessionId: 'opencode-1',
    nativeMessageId: null,
    createdAt: new Date('2026-01-01T00:00:01.000Z'),
  });

  it('renders and dispatches a persisted review action offer', async () => {
    reviewActionMutate.mockResolvedValue({ status: 'resolved' });
    render(
      <FastSessionTranscript
        sessionId="22222222-2222-4222-8222-222222222222"
        initialMessages={[reviewOfferMessage()]}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Resolve these issues' }),
    );
    await waitFor(() =>
      expect(reviewActionMutate).toHaveBeenCalledWith({
        sessionId: '22222222-2222-4222-8222-222222222222',
        deliveryId: '11111111-1111-4111-8111-111111111111',
        choice: 'yes',
      }),
    );
    expect(
      await screen.findByText('Resolving the current review issues.'),
    ).toBeInTheDocument();
  });

  it('hides dismissed offers and renders late-click states without controls', async () => {
    const { rerender } = render(
      <FastSessionTranscript
        sessionId="22222222-2222-4222-8222-222222222222"
        initialMessages={[reviewOfferMessage('dismissed')]}
      />,
    );
    expect(
      screen.queryByText('Would you like me to resolve these issues?'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('pr-review-action-offer'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Resolve these issues' }),
    ).not.toBeInTheDocument();

    rerender(
      <FastSessionTranscript
        sessionId="22222222-2222-4222-8222-222222222222"
        initialMessages={[reviewOfferMessage()]}
      />,
    );
    act(() => {
      FakeEventSource.instances.at(-1)?.emit('messages', {
        messages: [reviewOfferMessage('stale')],
      });
    });
    expect(
      await screen.findByText('This offer was already handled or has expired.'),
    ).toBeInTheDocument();
  });
  it('renders persisted user and assistant text with task transcript primitives', () => {
    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[
          {
            id: 'tool-call-1',
            eventId: 'turn-1:tool-call:0',
            turnId: 'turn-1',
            turnSeq: 1,
            ts: 2,
            eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
            role: 'tool',
            contentBlocks: [],
            metadata: { visibleInTranscript: true },
            payload: {
              toolCallId: 'turn-1:tool:0',
              title: 'launch_task',
              kind: 'tool',
              status: 'in_progress',
              isExecute: false,
              isRead: false,
              isMcp: false,
              mcpServerName: null,
              mcpToolName: null,
              toolName: 'launch_task',
              command: null,
              rawInput: { arguments: { prompt: 'Fix checkout' } },
            },
            source: 'slack',
            nativeSessionId: 'opencode-1',
            nativeMessageId: null,
            createdAt: new Date('2026-01-01T00:00:01.000Z'),
          },
          {
            id: 'user-1',
            eventId: 'turn-1:user',
            turnId: 'turn-1',
            turnSeq: 0,
            ts: 1,
            eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
            role: 'user',
            contentBlocks: [{ type: 'text', text: 'What changed?' }],
            metadata: { visibleInTranscript: true },
            payload: {},
            source: 'slack',
            nativeSessionId: null,
            nativeMessageId: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          },
          {
            id: 'assistant-1',
            eventId: 'turn-1:assistant:0',
            turnId: 'turn-1',
            turnSeq: 1,
            ts: 2,
            eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
            role: 'assistant',
            contentBlocks: [{ type: 'text', text: '**Two files**' }],
            metadata: { visibleInTranscript: true },
            payload: {},
            source: 'slack',
            nativeSessionId: 'opencode-1',
            nativeMessageId: null,
            createdAt: new Date('2026-01-01T00:00:01.000Z'),
          },
        ]}
      />,
    );

    expect(screen.getByRole('log')).toBeInTheDocument();
    expect(screen.getByText('What changed?')).toBeInTheDocument();
    expect(screen.getByText('Two files')).toBeInTheDocument();
  });

  it('updates one canonical tool row from in-progress to completed via the stream', () => {
    const baseMessage = {
      id: 'tool-1',
      eventId: 'turn-1:tool:0',
      turnId: 'turn-1',
      turnSeq: 1,
      ts: 2,
      role: 'tool' as const,
      metadata: { visibleInTranscript: true },
      source: 'slack',
      nativeSessionId: 'opencode-1',
      nativeMessageId: null,
      createdAt: new Date('2026-01-01T00:00:01.000Z'),
    };
    const toolCall = {
      ...baseMessage,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
      contentBlocks: [],
      payload: {
        toolCallId: 'turn-1:tool:0',
        title: 'launch_task',
        kind: 'tool',
        status: 'in_progress',
        isExecute: false,
        isRead: false,
        isMcp: false,
        mcpServerName: null,
        mcpToolName: null,
        toolName: 'launch_task',
        command: null,
        rawInput: { arguments: { prompt: 'Fix checkout' } },
      },
    };
    const toolResult = {
      ...baseMessage,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      contentBlocks: [{ type: 'text', text: '{"success":true}' }],
      payload: {
        ...toolCall.payload,
        status: 'completed',
        exitCode: null,
        output: '{"success":true}',
      },
      createdAt: '2026-01-01T00:00:01.000Z',
    };

    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[toolCall]}
      />,
    );

    expect(screen.getByText('Starting')).toBeInTheDocument();
    expect(screen.getByText('Coding Task')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe(
      '/api/sessions/session-1/stream',
    );

    act(() => {
      FakeEventSource.instances[0]!.emit('messages', {
        messages: [toolResult],
      });
    });

    expect(screen.getByText('Started')).toBeInTheDocument();
    expect(screen.queryByText('Running')).not.toBeInTheDocument();
  });

  it('renders trusted Fast show_widget results with the shared sandboxed preview', () => {
    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[
          {
            id: 'widget-1',
            eventId: 'turn-1:tool:0',
            turnId: 'turn-1',
            turnSeq: 1,
            ts: 2,
            eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
            role: 'tool',
            contentBlocks: [],
            metadata: { visibleInTranscript: true },
            payload: {
              toolCallId: 'turn-1:tool:0',
              title: 'show_widget',
              kind: 'tool',
              status: 'completed',
              isExecute: false,
              isMcp: false,
              isRoomoteNativeTool: true,
              mcpServerName: null,
              mcpToolName: null,
              toolName: 'show_widget',
              command: null,
              exitCode: null,
              output: JSON.stringify({
                success: true,
                shown: true,
                title: 'Fast status',
                html: '<p>Ready</p>',
                css: null,
                height: 240,
                textFallback: null,
              }),
              rawInput: { arguments: { html: '<p>Ready</p>' } },
            },
            source: 'web',
            nativeSessionId: 'opencode-1',
            nativeMessageId: null,
            createdAt: new Date('2026-01-01T00:00:01.000Z'),
          },
        ]}
      />,
    );

    const iframe = screen.getByTitle('Fast status');
    expect(iframe).toHaveAttribute('sandbox', '');
    expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(iframe).toHaveAttribute(
      'srcdoc',
      expect.stringContaining("default-src 'none'"),
    );
  });

  it('keeps a launched child task visible in narration mode and opens its panel', () => {
    narrationState.enabled = true;
    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[
          {
            id: 'tool-1',
            eventId: 'turn-1:tool:0',
            turnId: 'turn-1',
            turnSeq: 1,
            ts: 2,
            eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
            role: 'tool',
            contentBlocks: [],
            metadata: { visibleInTranscript: true },
            payload: {
              toolCallId: 'turn-1:tool:0',
              title: 'launch_task',
              kind: 'task',
              status: 'completed',
              isExecute: false,
              isMcp: false,
              mcpServerName: null,
              mcpToolName: null,
              toolName: 'launch_task',
              command: null,
              exitCode: null,
              output: JSON.stringify({ success: true, taskId: 'child-1' }),
              rawInput: { arguments: { prompt: 'Fix checkout' } },
            },
            source: 'web',
            nativeSessionId: 'opencode-1',
            nativeMessageId: null,
            createdAt: new Date('2026-01-01T00:00:01.000Z'),
          },
          {
            id: 'kickoff-child-1',
            eventId: 'turn-1:assistant:child-kickoff',
            turnId: 'turn-1',
            turnSeq: 2,
            ts: 3,
            eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
            role: 'assistant',
            contentBlocks: [
              { type: 'text', text: 'I started the delegated task.' },
            ],
            metadata: { visibleInTranscript: true },
            payload: { purpose: 'progress', kickoff: true },
            source: 'web',
            nativeSessionId: 'opencode-1',
            nativeMessageId: null,
            createdAt: new Date('2026-01-01T00:00:02.000Z'),
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Delegated task/ }));

    expect(openTaskPanel).toHaveBeenCalledWith('child-1');
  });

  it('cold-loads one completed tool row before an intervening kickoff', () => {
    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[
          {
            id: 'tool-1',
            eventId: 'turn-1:tool:0',
            turnId: 'turn-1',
            turnSeq: 1,
            ts: 2,
            eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
            role: 'tool',
            contentBlocks: [{ type: 'text', text: '{"success":true}' }],
            metadata: { visibleInTranscript: true },
            payload: {
              toolCallId: 'turn-1:tool:0',
              title: 'launch_task',
              kind: 'tool',
              status: 'completed',
              isExecute: false,
              isMcp: false,
              mcpServerName: null,
              mcpToolName: null,
              toolName: 'launch_task',
              command: null,
              exitCode: null,
              output: '{"success":true}',
              rawInput: { arguments: { prompt: 'Fix checkout' } },
            },
            source: 'slack',
            nativeSessionId: 'opencode-1',
            nativeMessageId: null,
            createdAt: new Date('2026-01-01T00:00:01.000Z'),
          },
          {
            id: 'kickoff-1',
            eventId: 'turn-1:assistant:0',
            turnId: 'turn-1',
            turnSeq: 2,
            ts: 3,
            eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
            role: 'assistant',
            contentBlocks: [
              {
                type: 'text',
                text: 'I started the checkout fix.\n\n[Open in Roomote](https://roomote.example/sessions/session-1?task=child-1)',
              },
            ],
            metadata: { visibleInTranscript: true },
            payload: { purpose: 'progress', kickoff: true },
            source: 'slack',
            nativeSessionId: 'opencode-1',
            nativeMessageId: null,
            createdAt: new Date('2026-01-01T00:00:02.000Z'),
          },
        ]}
      />,
    );

    expect(
      screen.getByRole('button', { name: /Started Coding Task Completed/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('I started the checkout fix.')).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Open in Roomote' }),
    ).not.toBeInTheDocument();
  });

  it('shows a reply composer for web sessions and sends replies optimistically', async () => {
    replyMutate.mockResolvedValue({ success: true });

    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[]}
        canReply
      />,
    );

    const input = screen.getByPlaceholderText('Message agent');
    fireEvent.change(input, { target: { value: 'Follow up question' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });

    // Attachment preparation is async before the mutation fires.
    await waitFor(() => expect(replyMutate).toHaveBeenCalled());
    expect(await screen.findByText('Follow up question')).toBeInTheDocument();
    expect(replyMutate).toHaveBeenCalledWith({
      sessionId: 'session-1',
      text: 'Follow up question',
      model: null,
      reasoningEffort: null,
    });
  });

  it('persists model selections immediately and uses them for the next reply', async () => {
    updateModelSelectionMutate.mockResolvedValue({ success: true });
    replyMutate.mockResolvedValue({ success: true });

    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[]}
        canReply
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Use GLM 5.2' }));
    expect(screen.getByTestId('session-model')).toHaveTextContent(
      'openrouter/z-ai/glm-5.2',
    );
    await waitFor(() => {
      expect(updateModelSelectionMutate).toHaveBeenCalledWith({
        sessionId: 'session-1',
        model: 'openrouter/z-ai/glm-5.2',
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Use high reasoning' }));
    expect(screen.getByTestId('session-reasoning')).toHaveTextContent('high');
    await waitFor(() => {
      expect(updateModelSelectionMutate).toHaveBeenLastCalledWith({
        sessionId: 'session-1',
        reasoningEffort: 'high',
      });
    });

    const input = screen.getByPlaceholderText('Message agent');
    fireEvent.change(input, { target: { value: 'Use these settings' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });

    await waitFor(() => {
      expect(replyMutate).toHaveBeenCalledWith({
        sessionId: 'session-1',
        text: 'Use these settings',
        model: 'openrouter/z-ai/glm-5.2',
        reasoningEffort: 'high',
      });
    });
  });

  it('does not submit with Enter while a model selection is still saving', async () => {
    let resolveModelUpdate: ((value: { success: true }) => void) | undefined;
    updateModelSelectionMutate.mockReturnValue(
      new Promise((resolve) => {
        resolveModelUpdate = resolve;
      }),
    );
    replyMutate.mockResolvedValue({ success: true });

    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[]}
        canReply
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Use GLM 5.2' }));
    const input = screen.getByPlaceholderText('Message agent');
    fireEvent.change(input, { target: { value: 'Wait for the model save' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });

    expect(replyMutate).not.toHaveBeenCalled();

    await act(async () => {
      resolveModelUpdate?.({ success: true });
    });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });

    await waitFor(() => {
      expect(replyMutate).toHaveBeenCalledWith({
        sessionId: 'session-1',
        text: 'Wait for the model save',
        model: 'openrouter/z-ai/glm-5.2',
        reasoningEffort: null,
      });
    });
  });

  it('sends an image-only reply', async () => {
    preparePromptAttachments.mockResolvedValueOnce({
      text: '',
      images: ['data:image/png;base64,image-1'],
    });
    replyMutate.mockResolvedValue({ success: true });

    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[]}
        canReply
      />,
    );

    const input = screen.getByPlaceholderText('Message agent');
    fireEvent.change(input, { target: { value: 'Image attachment' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });

    await waitFor(() => {
      expect(replyMutate).toHaveBeenCalledWith({
        sessionId: 'session-1',
        text: '',
        images: ['data:image/png;base64,image-1'],
        model: null,
        reasoningEffort: null,
      });
    });

    expect(
      await screen.findAllByRole('button', {
        name: 'Open conversation image attachment 1',
      }),
    ).toHaveLength(1);

    act(() => {
      FakeEventSource.instances[0]!.emit('messages', {
        messages: [
          {
            id: 'user-image-1',
            eventId: 'turn-image-1:user',
            turnId: 'turn-image-1',
            turnSeq: 0,
            ts: Date.now(),
            eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
            role: 'user',
            contentBlocks: [
              { type: 'text', text: '' },
              { type: 'image', mimeType: 'image/png', data: 'image-1' },
            ],
            metadata: { visibleInTranscript: true },
            payload: {},
            source: 'web',
            nativeSessionId: null,
            nativeMessageId: null,
            createdAt: new Date(),
          },
        ],
      });
    });

    expect(
      screen.getAllByRole('button', {
        name: 'Open conversation image attachment 1',
      }),
    ).toHaveLength(1);
  });

  it('keeps the drafted reply when the send fails', async () => {
    replyMutate.mockRejectedValue(new Error('turn is busy'));

    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[]}
        canReply
      />,
    );

    const input = screen.getByPlaceholderText(
      'Message agent',
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Do not lose me' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });

    expect(await screen.findByText('turn is busy')).toBeInTheDocument();
    expect(input.value).toBe('Do not lose me');
  });

  it('shows structured input instead of the ordinary composer while pending', () => {
    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[
          {
            id: 'request-1',
            eventId: 'request-1',
            turnId: 'turn-1',
            turnSeq: 1,
            ts: Date.now(),
            eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
            role: 'assistant',
            contentBlocks: [{ type: 'text', text: 'Choose one' }],
            metadata: { visibleInTranscript: true },
            payload: {
              requestId: 'rui:request-1',
              status: 'pending',
              sessionId: 'session-1',
              turnId: 'turn-1',
              callId: 'call-1',
              questions: [
                {
                  id: 'choice',
                  header: 'Choice',
                  question: 'Choose one',
                  isOther: false,
                  isSecret: false,
                  options: [{ label: 'One', description: 'First choice' }],
                },
              ],
            },
            source: 'web',
            nativeSessionId: null,
            nativeMessageId: null,
            createdAt: new Date(),
          },
        ]}
        canReply
      />,
    );

    expect(screen.getByText('Structured input request')).toBeVisible();
    expect(screen.queryByPlaceholderText('Message agent')).toBeNull();
  });

  it('updates the header title from the session stream event', () => {
    document.title = 'Roomote';
    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[]}
        fallbackTitle="New session"
      />,
    );

    expect(screen.getByText('New session')).toBeInTheDocument();

    act(() => {
      FakeEventSource.instances[0]!.emit('session', {
        title:
          'Rotate the API keys across every production environment without downtime',
      });
    });

    expect(
      screen.getByText(
        'Rotate the API keys across every production environment without downtime',
      ),
    ).toBeInTheDocument();
    expect(document.title).toBe(
      'Rotate the API keys across every production environment with... | Roomote',
    );
  });

  it('hides the reply composer for non-web sessions', () => {
    render(
      <FastSessionTranscript sessionId="session-1" initialMessages={[]} />,
    );

    expect(screen.queryByPlaceholderText('Message agent')).toBeNull();
  });
});
