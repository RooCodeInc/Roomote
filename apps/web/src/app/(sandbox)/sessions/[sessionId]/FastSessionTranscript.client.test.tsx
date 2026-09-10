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
import {
  clearPendingFastSessionLaunch,
  stagePendingFastSessionLaunch,
} from '@/lib/pending-fast-session-launch';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/sessions/session-1',
}));

const {
  replyMutate,
  reviewActionMutate,
  updateModelSelectionMutate,
  preparePromptAttachments,
  openTaskPanel,
  openTasksPanel,
  narrationState,
  composerSuggestionState,
  voiceStatusQuery,
  recordVoiceTurnMutate,
  recordVoiceCallEventMutate,
  liveVoiceState,
} = vi.hoisted(() => ({
  replyMutate: vi.fn(),
  reviewActionMutate: vi.fn(),
  updateModelSelectionMutate: vi.fn(),
  preparePromptAttachments: vi.fn(),
  openTaskPanel: vi.fn(),
  openTasksPanel: vi.fn(),
  narrationState: { enabled: false },
  composerSuggestionState: {
    data: undefined as { suggestion: string; messageCount: number } | undefined,
  },
  voiceStatusQuery: vi.fn(),
  recordVoiceTurnMutate: vi.fn(),
  recordVoiceCallEventMutate: vi.fn(),
  liveVoiceState: {
    active: false,
    status: 'idle' as
      | 'idle'
      | 'connecting'
      | 'listening'
      | 'speaking'
      | 'error',
    start: vi.fn(),
    stop: vi.fn(),
    speak: vi.fn(),
    setMicMuted: vi.fn(),
    setOutputMuted: vi.fn(),
    startedAt: null as number | null,
    deliveringUtterances: 0,
    onUtterance: undefined as
      | ((text: string, delegationId: string | null) => void)
      | undefined,
    onSpokenTurn: undefined as ((text: string) => void) | undefined,
    onHeardTurnDelta: undefined as ((text: string) => void) | undefined,
    onSpokenTurnDelta: undefined as ((text: string) => void) | undefined,
  },
}));

vi.mock('@/hooks/useLiveVoice', () => ({
  useLiveVoice: ({
    onUtterance,
    onSpokenTurn,
    onHeardTurnDelta,
    onSpokenTurnDelta,
  }: {
    onUtterance: (text: string, delegationId: string | null) => void;
    onSpokenTurn?: (text: string) => void;
    onHeardTurnDelta?: (text: string) => void;
    onSpokenTurnDelta?: (text: string) => void;
  }) => {
    liveVoiceState.onUtterance = onUtterance;
    liveVoiceState.onSpokenTurn = onSpokenTurn;
    liveVoiceState.onHeardTurnDelta = onHeardTurnDelta;
    liveVoiceState.onSpokenTurnDelta = onSpokenTurnDelta;
    return {
      active: liveVoiceState.active,
      status: liveVoiceState.status,
      start: liveVoiceState.start,
      stop: liveVoiceState.stop,
      speak: liveVoiceState.speak,
      micMuted: false,
      setMicMuted: liveVoiceState.setMicMuted,
      outputMuted: false,
      setOutputMuted: liveVoiceState.setOutputMuted,
      startedAt: liveVoiceState.startedAt,
      deliveringUtterances: liveVoiceState.deliveringUtterances,
    };
  },
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
    voice: {
      status: { query: voiceStatusQuery },
      recordTurn: { mutate: recordVoiceTurnMutate },
      recordCallEvent: { mutate: recordVoiceCallEventMutate },
    },
  }),
  useTRPC: () => ({
    slack: {
      resolveUsers: {
        queryOptions: (input: unknown) => ({
          queryKey: ['slack.resolveUsers', input],
        }),
      },
    },
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
  useQuery: () => ({ data: composerSuggestionState.data }),
}));

// Wakeup polling has dedicated provider-backed tests. Keep this suite's query
// mocks scoped to composer suggestions rather than mounting the live poller.
vi.mock('./SessionWakeups', () => ({
  SessionWakeups: () => null,
}));

vi.mock('../../task/[taskId]/messages/acp/AcpDataVisualizations', () => ({
  AcpDataVisualizations: ({ charts }: { charts: Array<{ title: string }> }) => (
    <div data-testid="session-chart">{charts[0]?.title}</div>
  ),
}));

vi.mock('@/components/tasks/SessionModelSwitcher', () => ({
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
vi.mock('./setup/SetupIntegrationsCard', () => ({
  SetupIntegrationsCard: () => <div>Optional integration setup</div>,
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
  composerSuggestionState.data = undefined;
  openTaskPanel.mockReset();
  openTasksPanel.mockReset();
  voiceStatusQuery.mockReset();
  voiceStatusQuery.mockResolvedValue({ enabled: false });
  recordVoiceTurnMutate.mockReset();
  recordVoiceTurnMutate.mockResolvedValue({ eventId: 'voice:1' });
  recordVoiceCallEventMutate.mockReset();
  recordVoiceCallEventMutate.mockResolvedValue({ eventId: 'voice-call:1' });
  liveVoiceState.startedAt = null;
  liveVoiceState.deliveringUtterances = 0;
  liveVoiceState.onSpokenTurn = undefined;
  liveVoiceState.active = false;
  liveVoiceState.status = 'idle';
  liveVoiceState.start.mockReset();
  liveVoiceState.stop.mockReset();
  liveVoiceState.speak.mockReset();
  liveVoiceState.onUtterance = undefined;
  clearPendingFastSessionLaunch('session-1');
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
    userId,
    userName = null,
    userEmail = null,
    userImageUrl = null,
  }: {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    ts: number;
    visible?: boolean;
    turnSeq?: number;
    inputKind?: string;
    userId?: string;
    userName?: string | null;
    userEmail?: string | null;
    userImageUrl?: string | null;
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
      ...(userId ? { userId } : {}),
    },
    payload: {},
    source: 'web',
    nativeSessionId: role === 'assistant' ? 'opencode-1' : null,
    nativeMessageId: null,
    userName,
    userEmail,
    userImageUrl,
    createdAt: new Date(ts),
  });

  it('renders charts restored from persisted Session messages', () => {
    const message = textMessage({
      id: 'assistant-chart',
      role: 'assistant',
      text: 'Search accounts for most visits.',
      ts: 10,
    });

    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[
          {
            ...message,
            contentBlocks: [
              ...message.contentBlocks,
              {
                type: 'data_visualization',
                title: 'Traffic sources',
                chart: {
                  type: 'pie',
                  segments: [{ label: 'Search', value: 65 }],
                },
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByTestId('session-chart')).toHaveTextContent(
      'Traffic sources',
    );
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

  it.each(['setup_starter_tasks', 'setup_integrations'])(
    'renders and removes the %s card when its response control event arrives',
    (preset) => {
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
          preset,
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

      const { unmount } = render(
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[request]}
        />,
      );
      const cardLabel =
        preset === 'setup_integrations'
          ? 'Optional integration setup'
          : 'Setup starter tasks';
      expect(screen.getByText(cardLabel)).toBeInTheDocument();
      unmount();
      render(
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[request, response]}
          owner={{
            userId: 'user-1',
            name: 'Test User',
            email: 'test@example.com',
            imageUrl: null,
          }}
        />,
      );

      expect(screen.queryByText('Structured input request')).toBeNull();
      expect(screen.getByText('Structured response')).toBeInTheDocument();
      expect(screen.getByLabelText('Test User')).toBeInTheDocument();
      expect(screen.queryByText(cardLabel)).toBeNull();
    },
  );

  it('renders a structured response once in chronology as human-authored text', () => {
    const requestId = 'rui:chronology';
    const question = 'Which direction should I take?';
    const request = {
      ...textMessage({
        id: 'input-request',
        role: 'assistant',
        text: question,
        ts: 2,
      }),
      eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
      payload: {
        requestId,
        status: 'pending',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        questions: [
          {
            id: 'direction',
            header: 'Direction',
            question,
            isOther: true,
            isSecret: false,
          },
        ],
      },
    };
    const response = {
      ...textMessage({
        id: 'input-response',
        role: 'user',
        text: 'Legacy persisted answer',
        ts: 3,
      }),
      eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
      payload: {
        requestId,
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        answers: { direction: { answers: ['Use the narrow path'] } },
        resolution: 'submitted',
      },
    };

    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[
          textMessage({
            id: 'assistant-before',
            role: 'assistant',
            text: 'Before the question',
            ts: 1,
          }),
          request,
          response,
          textMessage({
            id: 'assistant-after',
            role: 'assistant',
            text: 'After the answer',
            ts: 4,
          }),
        ]}
        owner={{
          userId: 'user-1',
          name: 'Transcript Owner',
          email: 'owner@example.com',
          imageUrl: null,
        }}
      />,
    );

    const before = screen.getByText('Before the question');
    const answer = screen.getByText('Use the narrow path');
    const after = screen.getByText('After the answer');
    expect(before.compareDocumentPosition(answer)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(answer.compareDocumentPosition(after)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getAllByText(question)).toHaveLength(1);
    expect(screen.queryByText('Legacy persisted answer')).toBeNull();
    expect(screen.getByLabelText('Transcript Owner')).toBeInTheDocument();
  });

  it('hides request_user_input tool lifecycle rows while keeping the interaction card', () => {
    const requestId = 'rui:hidden-tools';
    const toolPayload = {
      toolCallId: 'turn-1:tool:0',
      title: 'request_user_input',
      kind: 'tool',
      status: 'completed',
      isExecute: false,
      isRead: false,
      isMcp: false,
      mcpServerName: null,
      mcpToolName: null,
      toolName: 'request_user_input',
      command: null,
      rawInput: { arguments: { question: 'Hidden tool question' } },
    };
    const toolBase = {
      id: 'request-tool',
      eventId: 'turn-1:tool:0',
      turnId: 'turn-1',
      turnSeq: 1,
      ts: 1,
      role: 'tool' as const,
      metadata: { visibleInTranscript: true },
      source: 'web',
      nativeSessionId: 'opencode-1',
      nativeMessageId: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const request = {
      ...textMessage({
        id: 'input-request',
        role: 'assistant',
        text: 'Choose a path',
        ts: 2,
      }),
      eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
      payload: {
        requestId,
        status: 'pending',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        questions: [
          {
            id: 'path',
            header: 'Path',
            question: 'Choose a path',
            isOther: true,
            isSecret: false,
          },
        ],
      },
    };

    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[
          {
            ...toolBase,
            eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
            contentBlocks: [],
            payload: toolPayload,
          },
          {
            ...toolBase,
            id: 'request-tool-result',
            eventId: 'turn-1:tool-result:0',
            eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
            contentBlocks: [
              { type: 'text' as const, text: 'Hidden tool result' },
            ],
            payload: { ...toolPayload, output: 'Hidden tool result' },
          },
          request,
        ]}
      />,
    );

    expect(screen.getByText('Structured input request')).toBeInTheDocument();
    expect(screen.queryByText('Asked for')).toBeNull();
    expect(screen.queryByText('human guidance')).toBeNull();
    expect(screen.queryByText('Hidden tool result')).toBeNull();
    expect(screen.queryByText('Choose a path')).toBeNull();
  });

  it.each([
    ['failed', 'Failed to Ask for'],
    ['completed', 'Asked for'],
  ] as const)(
    'keeps a %s request_user_input tool row when no interaction card was persisted',
    (status, actionLabel) => {
      render(
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[
            {
              id: 'request-tool-result',
              eventId: 'turn-1:tool-result:0',
              turnId: 'turn-1',
              turnSeq: 1,
              ts: 1,
              eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
              role: 'tool',
              contentBlocks: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: status === 'completed',
                    ...(status === 'failed'
                      ? { error: 'Preset unavailable' }
                      : {}),
                  }),
                },
              ],
              metadata: { visibleInTranscript: true },
              payload: {
                toolCallId: 'turn-1:tool:0',
                title: 'request_user_input',
                kind: 'tool',
                status,
                isExecute: false,
                isRead: false,
                isMcp: false,
                mcpServerName: null,
                mcpToolName: null,
                toolName: 'request_user_input',
                command: null,
                output: JSON.stringify({
                  success: status === 'completed',
                  ...(status === 'failed'
                    ? { error: 'Preset unavailable' }
                    : {}),
                }),
                rawInput: {
                  arguments: { preset: 'setup_starter_tasks' },
                },
              },
              source: 'web',
              nativeSessionId: 'opencode-1',
              nativeMessageId: null,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
            },
          ]}
        />,
      );

      expect(screen.getByText(actionLabel)).toBeInTheDocument();
      expect(screen.getByText('human guidance')).toBeInTheDocument();
      if (status === 'failed') {
        expect(screen.getByText('Failed')).toBeInTheDocument();
      } else {
        expect(screen.getByText('Completed')).toBeInTheDocument();
      }
      expect(screen.queryByText('Structured input request')).toBeNull();
    },
  );

  it('places a pending interaction at its chronological position', () => {
    const request = {
      ...textMessage({
        id: 'input-request',
        role: 'assistant',
        text: 'Choose a path',
        ts: 2,
      }),
      eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
      payload: {
        requestId: 'rui:pending-order',
        status: 'pending',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        questions: [
          {
            id: 'path',
            header: 'Path',
            question: 'Choose a path',
            isOther: true,
            isSecret: false,
          },
        ],
      },
    };
    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[
          textMessage({
            id: 'assistant-before',
            role: 'assistant',
            text: 'Before pending input',
            ts: 1,
          }),
          request,
          textMessage({
            id: 'assistant-after',
            role: 'assistant',
            text: 'Later transcript activity',
            ts: 3,
          }),
        ]}
      />,
    );

    const before = screen.getByText('Before pending input');
    const interaction = screen.getByText('Structured input request');
    const after = screen.getByText('Later transcript activity');
    expect(before.compareDocumentPosition(interaction)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(interaction.compareDocumentPosition(after)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('keeps the composer available for non-preset input requests', () => {
    const request = {
      ...textMessage({
        id: 'input-request',
        role: 'assistant',
        text: 'Choose or write another direction',
        ts: 1,
      }),
      eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
      payload: {
        requestId: 'rui:optional',
        status: 'pending',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        questions: [
          {
            id: 'direction',
            header: 'Direction',
            question: 'Choose or write another direction',
            isOther: true,
            isSecret: false,
          },
        ],
      },
    };

    const { unmount } = render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[request]}
        canReply
      />,
    );
    expect(screen.getByPlaceholderText('Message agent')).toBeInTheDocument();

    unmount();
    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[
          {
            ...request,
            payload: { ...request.payload, preset: 'setup_starter_tasks' },
          },
        ]}
        canReply
      />,
    );
    expect(screen.queryByPlaceholderText('Message agent')).toBeNull();
    expect(screen.getByText('Setup starter tasks')).toBeInTheDocument();
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

  it('resolves a setup receipt avatar from the session owner', () => {
    const receipt = textMessage({
      id: 'setup-receipt',
      role: 'user',
      text: 'GitHub connected with 17 repositories.',
      ts: 1,
      inputKind: SETUP_RECEIPT_INPUT_KIND,
      userId: 'user-1',
    });

    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[receipt]}
        owner={{
          userId: 'user-1',
          name: 'Test User',
          email: 'test@example.com',
          imageUrl: 'https://example.com/avatar.png',
        }}
      />,
    );

    const avatar = screen.getByLabelText('Test User');
    expect(avatar.querySelector('img')).toHaveAttribute(
      'src',
      'https://example.com/avatar.png',
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

  it('shows a staged initial prompt immediately and reconciles its canonical event', () => {
    stagePendingFastSessionLaunch('session-1', {
      fastConversationId: 'fast-session-1',
      text: 'Initial question',
      images: ['data:image/png;base64,aGVsbG8='],
    });
    render(
      <FastSessionTranscript sessionId="session-1" initialMessages={[]} />,
    );

    expect(screen.getByText('Initial question')).toBeInTheDocument();
    expect(screen.getByText('Thinking')).toBeInTheDocument();

    act(() => {
      FakeEventSource.instances[0]!.emit('messages', {
        messages: [
          {
            ...textMessage({
              id: 'canonical-user',
              role: 'user',
              text: 'Initial question',
              ts: Date.now(),
            }),
            eventId: 'web-kickoff:fast-session-1:user',
            contentBlocks: [
              { type: 'text', text: 'Initial question' },
              { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
            ],
          },
        ],
      });
    });

    expect(screen.getAllByText('Initial question')).toHaveLength(1);
  });

  it('does not duplicate a staged prompt already present in initial messages', () => {
    stagePendingFastSessionLaunch('session-1', {
      fastConversationId: 'fast-session-1',
      text: 'Already persisted',
    });
    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[
          {
            ...textMessage({
              id: 'canonical-user',
              role: 'user',
              text: 'Already persisted',
              ts: Date.now(),
            }),
            eventId: 'web-kickoff:fast-session-1:user',
          },
        ]}
      />,
    );

    expect(screen.getAllByText('Already persisted')).toHaveLength(1);
  });

  it('waits for the first visible assistant message before showing timeline extras', () => {
    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[]}
        timelineExtras={<div>Connect source control</div>}
      />,
    );

    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.queryByText('Connect source control')).toBeNull();

    act(() => {
      FakeEventSource.instances[0]!.emit('messages', {
        messages: [
          textMessage({
            id: 'hidden-assistant-activity',
            role: 'assistant',
            text: 'Internal setup activity',
            ts: 1,
            visible: false,
          }),
        ],
      });
    });

    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.queryByText('Connect source control')).toBeNull();

    act(() => {
      FakeEventSource.instances[0]!.emit('messages', {
        messages: [
          textMessage({
            id: 'assistant-introduction',
            role: 'assistant',
            text: 'First, let’s connect your source code.',
            ts: 2,
          }),
        ],
      });
    });

    expect(
      screen.getByText('First, let’s connect your source code.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Connect source control')).toBeInTheDocument();
    expect(screen.queryByText('Thinking')).toBeNull();
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

    expect(
      screen.queryByText('Would you like me to resolve these issues?'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Review feedback remains.')).toBeInTheDocument();
    expect(reviewActionMutate).not.toHaveBeenCalled();
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
            userName: 'Slack Sender',
            userEmail: 'sender@example.com',
            userImageUrl: null,
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
    expect(screen.getByLabelText('Slack Sender')).toHaveTextContent('SS');
  });

  it('hides voice delivery while updating an ordinary tool row via the stream', () => {
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

    const voiceCommentary = {
      ...textMessage({
        id: 'voice-result-1',
        role: 'assistant' as const,
        text: 'Internal voice result',
        ts: 1,
      }),
      metadata: { visibleInTranscript: true, voiceCommentary: true },
    };

    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[voiceCommentary, toolCall]}
      />,
    );

    expect(screen.queryByText(/result to voice/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Internal voice result')).not.toBeInTheDocument();
    expect(screen.getByText('Starting')).toBeInTheDocument();
    expect(screen.getByText('coding task')).toBeInTheDocument();
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

  it.each([false, true])(
    'keeps the task card while hiding runtime navigation (standalone: %s)',
    (standalone) => {
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
                  text: `${standalone ? '' : 'I started the checkout fix.\n\n'}[Open in Roomote](https://roomote.example/sessions/session-1?task=child-1)`,
                },
              ],
              metadata: { visibleInTranscript: true },
              payload: {
                purpose: 'progress',
                ...(standalone ? { taskNavigation: true } : { kickoff: true }),
              },
              source: 'slack',
              nativeSessionId: 'opencode-1',
              nativeMessageId: null,
              createdAt: new Date('2026-01-01T00:00:02.000Z'),
            },
          ]}
        />,
      );

      expect(
        screen.getByRole('button', { name: /Started coding task Completed/ }),
      ).toBeInTheDocument();
      if (!standalone) {
        expect(
          screen.getByText('I started the checkout fix.'),
        ).toBeInTheDocument();
      }
      expect(
        screen.queryByRole('link', { name: 'Open in Roomote' }),
      ).not.toBeInTheDocument();
    },
  );

  it.each(['', 'You can follow the work here.\n\n'])(
    'preserves ordinary assistant links with prefix %j',
    (prefix) => {
      render(
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[
            {
              id: 'ordinary-link',
              eventId: 'turn-1:assistant:0',
              turnId: 'turn-1',
              turnSeq: 1,
              ts: 1,
              eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
              role: 'assistant',
              contentBlocks: [
                {
                  type: 'text',
                  text: `${prefix}[Open in Roomote](https://roomote.example/sessions/session-1?task=child-1)`,
                },
              ],
              metadata: { visibleInTranscript: true },
              payload: { purpose: 'progress' },
              source: 'slack',
              nativeSessionId: 'opencode-1',
              nativeMessageId: null,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
            },
          ]}
        />,
      );
      expect(
        screen.getByRole('link', { name: 'Open in Roomote' }),
      ).toHaveAttribute(
        'href',
        'https://roomote.example/sessions/session-1?task=child-1',
      );
    },
  );

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
    expect(input).toHaveFocus();
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

  it.each(['Tab', 'Escape', 'mouse', 'touch'])(
    'preserves focus-only hints and %s interaction for a long suggestion',
    (action) => {
      const suggestion =
        'Implement the marker fix and add regression coverage.';
      composerSuggestionState.data = { suggestion, messageCount: 2 };
      render(
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[
            textMessage({
              id: 'user-1',
              role: 'user',
              text: 'Question',
              ts: 1,
            }),
            textMessage({
              id: 'assistant-1',
              role: 'assistant',
              text: 'Answer',
              ts: 2,
            }),
          ]}
          canReply
        />,
      );
      const input = screen.getByPlaceholderText(suggestion);
      act(() => input.blur());
      expect(
        screen.queryByRole('button', { name: 'Insert suggested message' }),
      ).not.toBeInTheDocument();
      act(() => input.focus());
      const hint = screen.getByRole('button', {
        name: 'Insert suggested message',
      });
      expect(hint).toHaveTextContent('Tab to accept');
      expect(input).toHaveAccessibleDescription(
        `Suggested message: ${suggestion}. Press Tab to accept or Escape to dismiss.`,
      );
      act(() => input.blur());
      expect(hint).not.toBeInTheDocument();
      act(() => input.focus());

      if (action === 'mouse' || action === 'touch') {
        const focusedHint = screen.getByRole('button', {
          name: 'Insert suggested message',
        });
        expect(
          fireEvent.pointerDown(focusedHint, {
            pointerType: action,
            cancelable: true,
          }),
        ).toBe(false);
        expect(input).toHaveFocus();
        fireEvent.click(focusedHint);
      } else {
        fireEvent.keyDown(input, { key: action, code: action });
      }

      expect(input).toHaveValue(action === 'Escape' ? '' : suggestion);
      expect(input).toHaveFocus();
      expect(
        screen.queryByRole('button', { name: 'Insert suggested message' }),
      ).not.toBeInTheDocument();
    },
  );

  it('keeps a later suggestion hint hidden after a successful send remounts the composer', async () => {
    composerSuggestionState.data = {
      suggestion: 'Accept the first suggestion',
      messageCount: 2,
    };
    replyMutate.mockResolvedValue({ success: true });
    const initialMessages = [
      textMessage({ id: 'user-1', role: 'user', text: 'Question', ts: 1 }),
      textMessage({
        id: 'assistant-1',
        role: 'assistant',
        text: 'Answer',
        ts: 2,
      }),
    ];
    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={initialMessages}
        canReply
      />,
    );

    const input = screen.getByPlaceholderText('Accept the first suggestion');
    fireEvent.focus(input);
    expect(
      screen.getByRole('button', { name: 'Insert suggested message' }),
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'My own reply' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });
    await waitFor(() => expect(replyMutate).toHaveBeenCalled());
    await screen.findByPlaceholderText('Message agent');

    composerSuggestionState.data = {
      suggestion: 'Accept the next suggestion',
      messageCount: 3,
    };
    act(() => {
      FakeEventSource.instances[0]!.emit('messages', {
        messages: [
          textMessage({
            id: 'assistant-2',
            role: 'assistant',
            text: 'Next answer',
            ts: Date.now() + 1,
          }),
        ],
      });
    });

    expect(
      screen.getByPlaceholderText('Accept the next suggestion'),
    ).not.toHaveFocus();
    expect(
      screen.queryByRole('button', { name: 'Insert suggested message' }),
    ).not.toBeInTheDocument();
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

  it('shows structured input with the ordinary composer while non-preset input is pending', () => {
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
    expect(screen.getByPlaceholderText('Message agent')).toBeInTheDocument();
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

    expect(
      screen.getByRole('heading', { name: 'New session' }),
    ).toHaveAttribute('title', 'New session');

    act(() => {
      FakeEventSource.instances[0]!.emit('session', {
        title:
          'Rotate the API keys across every production environment without downtime',
      });
    });

    expect(
      screen.getByRole('heading', {
        name: 'Rotate the API keys across every production environment without downtime',
      }),
    ).toHaveAttribute(
      'title',
      'Rotate the API keys across every production environment without downtime',
    );
    expect(document.title).toBe(
      'Rotate the API keys across every production environment with... | Roomote',
    );
  });

  it('renders header extras and actions while preserving the Fast stream ID', () => {
    render(
      <FastSessionTranscript
        sessionId="fast-conversation-1"
        initialMessages={[]}
        initialTitle="Short session title"
        headerExtras={
          <a href="https://github.com/acme/widgets/pull/42">widgets#42</a>
        }
        headerActions={<button type="button">Session viewers</button>}
      />,
    );

    const heading = screen.getByRole('heading', {
      name: 'Short session title',
    });
    expect(heading.closest('header')).toContainElement(
      screen.getByRole('link', { name: 'widgets#42' }),
    );
    expect(heading.closest('header')).toContainElement(
      screen.getByRole('button', { name: 'Session viewers' }),
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe(
      '/api/sessions/fast-conversation-1/stream',
    );
  });

  it('hides the reply composer for non-web sessions', () => {
    render(
      <FastSessionTranscript sessionId="session-1" initialMessages={[]} />,
    );

    expect(screen.queryByPlaceholderText('Message agent')).toBeNull();
  });
  const chunkEvent = (
    eventId: string,
    text: string,
    ts = 2,
    fastTurnId?: string,
  ) => ({
    event: {
      id: eventId,
      kind: 'text',
      ts,
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk,
      role: 'assistant',
      contentBlocks: [{ type: 'text', text }],
      metadata: {
        sessionId: 'opencode-1',
        turnId: 'msg-1',
        ...(fastTurnId ? { fastTurnId } : {}),
      },
      payload: { sessionId: 'opencode-1', turnId: 'msg-1', text },
      text,
    },
  });

  it('streams reply chunks live and lets the persisted row replace them', () => {
    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[
          textMessage({ id: 'user-1', role: 'user', text: 'Hi', ts: 1 }),
        ]}
        canReply
      />,
    );
    expect(screen.getByText('Thinking')).toBeInTheDocument();

    act(() => {
      FakeEventSource.instances[0]!.emit(
        'chunk',
        chunkEvent('assistant-1:event', 'Looking'),
      );
    });
    expect(screen.getByText('Looking')).toBeInTheDocument();
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();

    act(() => {
      FakeEventSource.instances[0]!.emit(
        'chunk',
        chunkEvent('assistant-1:event', ' into it'),
      );
    });
    expect(screen.getByText('Looking into it')).toBeInTheDocument();
    const streamedNode = screen.getByText('Looking into it');

    // The persisted row lands under the same eventId and takes over in
    // place: the same element is updated rather than remounted.
    act(() => {
      FakeEventSource.instances[0]!.emit('messages', {
        messages: [
          textMessage({
            id: 'assistant-1',
            role: 'assistant',
            text: 'Looking into it now.',
            ts: 3,
          }),
        ],
      });
    });
    expect(screen.getByText('Looking into it now.')).toBe(streamedNode);
    expect(screen.queryByText('Looking into it')).not.toBeInTheDocument();

    // A later reply streams as its own message.
    act(() => {
      FakeEventSource.instances[0]!.emit(
        'chunk',
        chunkEvent('assistant-2:event', 'Done.', 4),
      );
    });
    expect(screen.getByText('Looking into it now.')).toBeInTheDocument();
    expect(screen.getByText('Done.')).toBeInTheDocument();
  });

  it('withdraws streamed text that no reply delivered once the turn settles', () => {
    render(
      <FastSessionTranscript
        sessionId="session-1"
        initialMessages={[
          textMessage({ id: 'user-1', role: 'user', text: 'Hi', ts: 1 }),
          textMessage({
            id: 'assistant-0',
            role: 'assistant',
            text: 'Earlier answer',
            ts: 2,
          }),
        ]}
        canReply
      />,
    );

    act(() => {
      FakeEventSource.instances[0]!.emit(
        'chunk',
        chunkEvent('assistant-1:event', 'Draft text', 3),
      );
    });
    expect(screen.getByText('Draft text')).toBeInTheDocument();

    act(() => {
      FakeEventSource.instances[0]!.emit('session', {
        conversationResponding: false,
      });
    });
    expect(screen.queryByText('Draft text')).not.toBeInTheDocument();
    expect(screen.getByText('Earlier answer')).toBeInTheDocument();
  });

  describe('live voice', () => {
    it('hides the voice toggle until the deployment reports voice enabled', async () => {
      voiceStatusQuery.mockResolvedValue({ enabled: false });
      render(
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[]}
          canReply
        />,
      );

      await waitFor(() => expect(voiceStatusQuery).toHaveBeenCalled());
      expect(
        screen.queryByRole('button', { name: /^voice conversation$/i }),
      ).not.toBeInTheDocument();
    });

    it('starts a conversation from the voice toggle when voice is enabled', async () => {
      voiceStatusQuery.mockResolvedValue({ enabled: true });
      render(
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[]}
          canReply
        />,
      );

      const toggle = await screen.findByRole('button', {
        name: /^voice conversation$/i,
      });
      fireEvent.click(toggle);
      expect(liveVoiceState.start).toHaveBeenCalledTimes(1);
      expect(liveVoiceState.stop).not.toHaveBeenCalled();
    });

    it('cancels a connecting handshake from the toggle', async () => {
      voiceStatusQuery.mockResolvedValue({ enabled: true });
      liveVoiceState.status = 'connecting';
      render(
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[]}
          canReply
        />,
      );

      // The button lights up as soon as the handshake starts; there is no
      // separate status strip, so it is the only voice control on screen.
      const toggle = await screen.findByRole('button', {
        name: /^end voice conversation$/i,
      });
      fireEvent.click(toggle);
      expect(liveVoiceState.stop).toHaveBeenCalledTimes(1);
      expect(liveVoiceState.start).not.toHaveBeenCalled();
    });

    it('reads the answer to a spoken request to Live as it streams, and leaves typed replies on screen', async () => {
      voiceStatusQuery.mockResolvedValue({ enabled: true });
      liveVoiceState.active = true;
      liveVoiceState.status = 'listening';
      render(
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[]}
          canReply
        />,
      );
      await screen.findAllByRole('button', { name: /end voice conversation/i });
      replyMutate.mockResolvedValue({ success: true });

      act(() => {
        liveVoiceState.onUtterance?.('Check the build', 'item_1');
      });
      await waitFor(() =>
        expect(replyMutate).toHaveBeenCalledWith(
          expect.objectContaining({ text: 'Check the build', voiceMode: true }),
        ),
      );
      const turnId = replyMutate.mock.calls[0]?.[0].clientMessageId;

      // A completed sentence is read while the reply is still streaming; the
      // growing tail waits. The chunk names its Fast turn, so it is attributed
      // to the delegation that asked for it.
      act(() => {
        FakeEventSource.instances[0]!.emit(
          'chunk',
          chunkEvent('assistant-1:event', 'First sentence. Second', 11, turnId),
        );
      });
      expect(liveVoiceState.speak).toHaveBeenCalledTimes(1);
      expect(liveVoiceState.speak).toHaveBeenLastCalledWith(
        'First sentence.',
        'item_1',
      );

      // The persisted row shares the stream's id, so only the unread tail is
      // spoken; nothing is read twice. Its internal delivery row stays hidden.
      act(() => {
        FakeEventSource.instances[0]!.emit('messages', {
          messages: [
            {
              ...textMessage({
                id: 'assistant-1',
                role: 'assistant',
                text: 'First sentence. Second part is here.',
                ts: 11,
              }),
              turnId,
              metadata: { visibleInTranscript: true, voiceCommentary: true },
            },
          ],
        });
      });
      expect(liveVoiceState.speak).toHaveBeenCalledTimes(2);
      expect(liveVoiceState.speak).toHaveBeenLastCalledWith(
        'Second part is here.',
        'item_1',
      );
      expect(screen.queryByText(/result to voice/i)).not.toBeInTheDocument();

      // A typed message's written reply stays on screen and is not spoken,
      // streamed or persisted.
      act(() => {
        FakeEventSource.instances[0]!.emit(
          'chunk',
          chunkEvent(
            'assistant-2:event',
            'Typed answer stays written.',
            12,
            'typed-turn',
          ),
        );
        FakeEventSource.instances[0]!.emit('messages', {
          messages: [
            textMessage({
              id: 'assistant-2',
              role: 'assistant',
              text: 'Typed answer stays written.',
              ts: 12,
            }),
          ],
        });
      });
      expect(liveVoiceState.speak).toHaveBeenCalledTimes(2);
      expect(
        screen.getByText('Typed answer stays written.'),
      ).toBeInTheDocument();
    });

    it('shows what is being said on the call as it is spoken, then hands over to the persisted row', async () => {
      voiceStatusQuery.mockResolvedValue({ enabled: true });
      liveVoiceState.active = true;
      liveVoiceState.status = 'listening';
      recordVoiceTurnMutate.mockResolvedValue({ eventId: 'voice:spoken-1' });
      render(
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[]}
          canReply
        />,
      );
      await screen.findAllByRole('button', { name: /end voice conversation/i });

      act(() => {
        liveVoiceState.onSpokenTurnDelta?.('Roo-Code has about');
      });
      expect(screen.getByText('Roo-Code has about')).toBeInTheDocument();
      act(() => {
        liveVoiceState.onSpokenTurnDelta?.('Roo-Code has about 452,000 lines.');
      });
      expect(
        screen.getByText('Roo-Code has about 452,000 lines.'),
      ).toBeInTheDocument();

      // The finished turn stays on screen while its row is written, then the
      // persisted row replaces it without a flash.
      act(() => {
        liveVoiceState.onSpokenTurn?.('Roo-Code has about 452,000 lines.');
      });
      await waitFor(() =>
        expect(recordVoiceTurnMutate).toHaveBeenCalledWith({
          sessionId: 'session-1',
          role: 'assistant',
          text: 'Roo-Code has about 452,000 lines.',
        }),
      );
      expect(
        screen.getByText('Roo-Code has about 452,000 lines.'),
      ).toBeInTheDocument();
      act(() => {
        FakeEventSource.instances[0]!.emit('messages', {
          messages: [
            {
              ...textMessage({
                id: 'spoken-1',
                role: 'assistant',
                text: 'Roo-Code has about 452,000 lines.',
                ts: 9,
              }),
              eventId: 'voice:spoken-1',
              metadata: { visibleInTranscript: true, voiceTurn: 'spoken' },
            },
          ],
        });
      });
      await waitFor(() =>
        expect(
          screen.getAllByText('Roo-Code has about 452,000 lines.'),
        ).toHaveLength(1),
      );
    });

    it('records a spoken acknowledgement only after the request it answers is sent', async () => {
      voiceStatusQuery.mockResolvedValue({ enabled: true });
      liveVoiceState.active = true;
      liveVoiceState.status = 'listening';
      // The person has finished speaking; the utterance is still being
      // cleaned up when GPT-Live says its acknowledgement.
      liveVoiceState.deliveringUtterances = 1;
      const transcript = () => (
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[]}
          canReply
        />
      );
      const { rerender } = render(transcript());
      await screen.findAllByRole('button', { name: /end voice conversation/i });

      act(() => {
        liveVoiceState.onSpokenTurn?.('Sure, checking what it would take.');
      });
      expect(recordVoiceTurnMutate).not.toHaveBeenCalled();

      // The cleaned request reaches the Session first...
      replyMutate.mockResolvedValue({ success: true });
      liveVoiceState.deliveringUtterances = 0;
      act(() => {
        liveVoiceState.onUtterance?.(
          'Can you add a dinosaur to the Sunny Acres game?',
          'item_1',
        );
      });
      rerender(transcript());
      await waitFor(() => expect(replyMutate).toHaveBeenCalledTimes(1));

      // ...and the acknowledgement is recorded after it.
      await waitFor(() =>
        expect(recordVoiceTurnMutate).toHaveBeenCalledWith({
          sessionId: 'session-1',
          role: 'assistant',
          text: 'Sure, checking what it would take.',
        }),
      );
    });

    it('drops a held spoken acknowledgement when the call ends before cleanup finishes', async () => {
      voiceStatusQuery.mockResolvedValue({ enabled: true });
      liveVoiceState.active = true;
      liveVoiceState.status = 'listening';
      liveVoiceState.startedAt = 1_000;
      liveVoiceState.deliveringUtterances = 1;
      const transcript = () => (
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[]}
          canReply
        />
      );
      const { rerender } = render(transcript());
      await screen.findAllByRole('button', { name: /end voice conversation/i });

      act(() => {
        liveVoiceState.onHeardTurnDelta?.('check the build');
        liveVoiceState.onSpokenTurnDelta?.('Sure, checking.');
        liveVoiceState.onSpokenTurn?.('Sure, checking.');
      });
      expect(screen.getByText('check the build')).toBeInTheDocument();
      expect(screen.getByText('Sure, checking.')).toBeInTheDocument();
      expect(recordVoiceTurnMutate).not.toHaveBeenCalled();

      liveVoiceState.active = false;
      liveVoiceState.status = 'idle';
      liveVoiceState.startedAt = null;
      rerender(transcript());
      expect(screen.queryByText('check the build')).not.toBeInTheDocument();
      expect(screen.queryByText('Sure, checking.')).not.toBeInTheDocument();
      await waitFor(() =>
        expect(recordVoiceCallEventMutate).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'session-1', phase: 'ended' }),
        ),
      );

      liveVoiceState.deliveringUtterances = 0;
      rerender(transcript());
      expect(recordVoiceTurnMutate).not.toHaveBeenCalled();
      expect(replyMutate).not.toHaveBeenCalled();
    });

    it('transcribes the call into the Session: markers and spoken turns', async () => {
      voiceStatusQuery.mockResolvedValue({ enabled: true });
      const transcript = () => (
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[]}
          canReply
        />
      );
      const { rerender } = render(transcript());
      fireEvent.click(
        await screen.findByRole('button', { name: /^voice conversation$/i }),
      );
      liveVoiceState.active = true;
      liveVoiceState.status = 'listening';
      liveVoiceState.startedAt = 1_000;
      rerender(transcript());
      await waitFor(() =>
        expect(recordVoiceCallEventMutate).toHaveBeenCalledWith({
          sessionId: 'session-1',
          phase: 'started',
        }),
      );

      act(() => {
        liveVoiceState.onSpokenTurn?.('Good, thanks. What can I do for you?');
      });
      expect(recordVoiceTurnMutate).toHaveBeenCalledWith({
        sessionId: 'session-1',
        role: 'assistant',
        text: 'Good, thanks. What can I do for you?',
      });

      // Persisted markers render as dividers.
      act(() => {
        FakeEventSource.instances[0]!.emit('messages', {
          messages: [
            {
              ...textMessage({
                id: 'call-1',
                role: 'assistant',
                text: 'Call started',
                ts: 5,
              }),
              eventType: ACP_ENVELOPE_EVENT_TYPES.VoiceCall,
              role: 'system',
              payload: { phase: 'started' },
            },
          ],
        });
      });
      expect(screen.getByTestId('voice-call-marker')).toHaveTextContent(
        'Call started',
      );

      liveVoiceState.active = false;
      liveVoiceState.status = 'idle';
      liveVoiceState.startedAt = null;
      rerender(transcript());
      await waitFor(() =>
        expect(recordVoiceCallEventMutate).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'session-1', phase: 'ended' }),
        ),
      );

      act(() => {
        FakeEventSource.instances[0]!.emit('messages', {
          messages: [
            {
              ...textMessage({
                id: 'call-2',
                role: 'assistant',
                text: 'Call ended',
                ts: 10,
              }),
              eventType: ACP_ENVELOPE_EVENT_TYPES.VoiceCall,
              role: 'system',
              payload: { phase: 'ended', durationMs: 9_000 },
            },
          ],
        });
      });
      expect(screen.getByText('Call ended · 9s')).toBeInTheDocument();
    });

    it('attributes a streamed first reply to its own delegation even after a second request', async () => {
      voiceStatusQuery.mockResolvedValue({ enabled: true });
      liveVoiceState.active = true;
      liveVoiceState.status = 'listening';
      render(
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[]}
          canReply
        />,
      );
      await screen.findAllByRole('button', { name: /end voice conversation/i });
      replyMutate.mockResolvedValue({ success: true });

      act(() => {
        liveVoiceState.onUtterance?.('Check the first build', 'item_first');
      });
      await waitFor(() => expect(replyMutate).toHaveBeenCalledTimes(1));
      const firstTurnId = replyMutate.mock.calls[0]?.[0].clientMessageId;
      act(() => {
        liveVoiceState.onUtterance?.(
          'Actually check the second',
          'item_second',
        );
      });
      await waitFor(() => expect(replyMutate).toHaveBeenCalledTimes(2));

      // The first reply starts streaming only now, after the second request.
      act(() => {
        FakeEventSource.instances[0]!.emit(
          'chunk',
          chunkEvent(
            'assistant-first:event',
            'First build passed. More',
            5,
            firstTurnId,
          ),
        );
      });
      expect(liveVoiceState.speak).toHaveBeenCalledWith(
        'First build passed.',
        'item_first',
      );
    });

    it('returns overlapping Fast results to their originating Live delegations', async () => {
      voiceStatusQuery.mockResolvedValue({ enabled: true });
      liveVoiceState.active = true;
      liveVoiceState.status = 'listening';
      render(
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[]}
          canReply
        />,
      );
      await screen.findAllByRole('button', { name: /end voice conversation/i });

      act(() => {
        liveVoiceState.onUtterance?.('Check the first build', 'item_first');
      });
      await waitFor(() => expect(replyMutate).toHaveBeenCalledTimes(1));
      const firstTurnId = replyMutate.mock.calls[0]?.[0].clientMessageId;

      act(() => {
        liveVoiceState.onUtterance?.(
          'Actually check the second',
          'item_second',
        );
      });
      await waitFor(() => expect(replyMutate).toHaveBeenCalledTimes(2));
      const secondTurnId = replyMutate.mock.calls[1]?.[0].clientMessageId;

      act(() => {
        FakeEventSource.instances[0]!.emit('messages', {
          messages: [
            {
              ...textMessage({
                id: 'assistant-first',
                role: 'assistant',
                text: 'First build result',
                ts: 5,
              }),
              turnId: firstTurnId,
              metadata: { visibleInTranscript: true, voiceCommentary: true },
            },
            {
              ...textMessage({
                id: 'assistant-second',
                role: 'assistant',
                text: 'Second build result',
                ts: 6,
              }),
              turnId: secondTurnId,
              metadata: { visibleInTranscript: true, voiceCommentary: true },
            },
          ],
        });
      });

      expect(liveVoiceState.speak).toHaveBeenNthCalledWith(
        1,
        'First build result',
        'item_first',
      );
      expect(liveVoiceState.speak).toHaveBeenNthCalledWith(
        2,
        'Second build result',
        'item_second',
      );
    });

    it('sets the spoken cutoff from server timestamps, not the browser clock', async () => {
      // Browser clock far ahead of the server-assigned message timestamps.
      vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      voiceStatusQuery.mockResolvedValue({ enabled: true });
      const transcript = () => (
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[
            textMessage({
              id: 'assistant-0',
              role: 'assistant',
              text: 'Earlier answer',
              ts: 1,
            }),
          ]}
          canReply
        />
      );
      const { rerender } = render(transcript());
      replyMutate.mockResolvedValue({ success: true });
      const input = screen.getByPlaceholderText('Message agent');
      fireEvent.change(input, { target: { value: 'Optimistic message' } });
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });
      await waitFor(() => expect(replyMutate).toHaveBeenCalled());

      // Start voice while the browser-timestamped optimistic row is waiting
      // for its persisted SSE echo.
      fireEvent.click(
        await screen.findByRole('button', { name: /^voice conversation$/i }),
      );
      liveVoiceState.active = true;
      liveVoiceState.status = 'listening';
      rerender(transcript());

      act(() => {
        FakeEventSource.instances[0]!.emit('session', {
          conversationResponding: true,
        });
      });
      act(() => {
        FakeEventSource.instances[0]!.emit('messages', {
          messages: [
            {
              ...textMessage({
                id: 'assistant-1',
                role: 'assistant',
                text: 'Server-timed reply',
                ts: 2,
              }),
              metadata: { visibleInTranscript: true, voiceCommentary: true },
            },
          ],
        });
      });
      act(() => {
        FakeEventSource.instances[0]!.emit('session', {
          conversationResponding: false,
        });
      });

      expect(liveVoiceState.speak).toHaveBeenCalledTimes(1);
      expect(liveVoiceState.speak).toHaveBeenCalledWith(
        'Server-timed reply',
        null,
      );
    });

    it('stops the voice conversation when a structured input request arrives', async () => {
      voiceStatusQuery.mockResolvedValue({ enabled: true });
      liveVoiceState.active = true;
      liveVoiceState.status = 'listening';
      render(
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[]}
          canReply
        />,
      );
      await screen.findAllByRole('button', { name: /end voice conversation/i });
      expect(liveVoiceState.stop).not.toHaveBeenCalled();

      act(() => {
        FakeEventSource.instances[0]!.emit('messages', {
          messages: [
            {
              ...textMessage({
                id: 'request-1',
                role: 'assistant',
                text: 'Choose one',
                ts: 5,
              }),
              eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
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
            },
          ],
        });
      });

      expect(screen.getByText('Structured input request')).toBeVisible();
      expect(liveVoiceState.stop).toHaveBeenCalledTimes(1);
    });

    it('auto-starts voice for a session opened from a spoken prompt and speaks the first reply', async () => {
      voiceStatusQuery.mockResolvedValue({ enabled: true });
      window.history.replaceState(null, '', '/sessions/session-1?voice=1');
      const transcript = () => (
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[
            textMessage({
              id: 'user-1',
              role: 'user',
              text: 'Hey there',
              ts: 1,
            }),
          ]}
          canReply
          autoStartVoice
        />
      );
      const { rerender } = render(transcript());

      await waitFor(() =>
        expect(liveVoiceState.start).toHaveBeenCalledTimes(1),
      );
      // The flag is one-shot: a reload must not restart the conversation.
      expect(window.location.search).toBe('');

      liveVoiceState.active = true;
      liveVoiceState.status = 'listening';
      rerender(transcript());

      act(() => {
        FakeEventSource.instances[0]!.emit('messages', {
          messages: [
            {
              ...textMessage({
                id: 'assistant-1',
                role: 'assistant',
                text: 'Hi! What can I do?',
                ts: 2,
              }),
              metadata: { visibleInTranscript: true, voiceCommentary: true },
            },
          ],
        });
      });
      expect(liveVoiceState.speak).toHaveBeenCalledWith(
        'Hi! What can I do?',
        null,
      );
    });

    it('does not auto-start voice when the deployment has it disabled', async () => {
      voiceStatusQuery.mockResolvedValue({ enabled: false });
      render(
        <FastSessionTranscript
          sessionId="session-1"
          initialMessages={[]}
          canReply
          autoStartVoice
        />,
      );
      await waitFor(() => expect(voiceStatusQuery).toHaveBeenCalled());
      expect(liveVoiceState.start).not.toHaveBeenCalled();
    });
  });
});
