import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

const { mockBuildAcpRenderBlocks } = vi.hoisted(() => ({
  mockBuildAcpRenderBlocks: vi.fn(() => []),
}));

const narrationModeState = vi.hoisted(() => ({
  enabled: false,
}));

const mindReaderModeState = vi.hoisted(() => ({
  enabled: false,
}));

const taskPhaseState = vi.hoisted(() => ({
  phase: null as string | null,
}));

const sandboxMessagesState = vi.hoisted(() => ({
  messages: [] as unknown[],
}));

const historyReadyState = vi.hoisted(() => ({
  ready: true,
}));

vi.mock('@/components/ai-elements', () => ({
  Conversation: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ConversationContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ConversationScrollButton: () => null,
  Message: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MessageActions: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  MessageContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  MessageTimestamp: ({ ts }: { ts: number }) => <time>{String(ts)}</time>,
  Shimmer: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@/components/ai-elements/message-ui-options', () => ({
  MessageUiOptionsProvider: ({
    children,
    value,
  }: {
    children: ReactNode;
    value?: { expandReasoningByDefault?: boolean };
  }) => (
    <div
      data-testid="message-ui-options"
      data-expand-reasoning={String(value?.expandReasoningByDefault)}
    >
      {children}
    </div>
  ),
}));

vi.mock('./hooks', () => ({
  useSandboxMessages: () => ({
    messages: sandboxMessagesState.messages,
  }),
  useSandboxHistoryReady: () => historyReadyState.ready,
  useSandboxTaskPhase: () => taskPhaseState.phase,
}));

vi.mock('@/hooks/useNarrationMode', () => ({
  useNarrationMode: () => ({
    enabled: narrationModeState.enabled,
    isLoading: false,
    isUpdating: false,
    setEnabled: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMindReaderMode', () => ({
  useMindReaderMode: () => ({
    enabled: mindReaderModeState.enabled,
    isLoading: false,
    isUpdating: false,
    setEnabled: vi.fn(),
  }),
}));

vi.mock('./messages/index', () => ({
  SleepWakeMessages: () => <div>Sleep rows</div>,
}));

vi.mock('./messages/acp', () => ({
  AcpMessageItem: ({
    msg,
  }: {
    msg: { id: string; data?: { goal?: unknown } };
  }) => (
    <div>
      {msg.id}
      {msg.data?.goal ? <span>Sent as goal</span> : null}
    </div>
  ),
  AcpGroupedToolMessage: () => null,
  AcpActivityGroupMessage: ({
    group,
    children,
  }: {
    group: { ts: number; endTs: number };
    children: ReactNode;
  }) => (
    <div>
      <button type="button">
        Worked for {Math.round((group.endTs - group.ts) / 1000)}s
      </button>
      <div>{children}</div>
    </div>
  ),
  AcpTextMessage: ({
    msg,
  }: {
    msg: { text?: string; data?: { goal?: unknown } };
  }) => (
    <div>
      {msg.data?.goal ? <span>Sent as goal</span> : null}
      {msg.text}
    </div>
  ),
}));

vi.mock('./messages/acp/render-blocks', () => ({
  buildAcpRenderBlocks: mockBuildAcpRenderBlocks,
}));

vi.mock('./messages/message-anchor', () => ({
  messageAnchorId: () => 'anchor-id',
}));

vi.mock('./LazyMessage', () => ({
  LazyMessage: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('./ScrollToHash', () => ({
  ScrollToHash: () => null,
}));

vi.mock('./ScrollBridge', () => ({
  ScrollBridge: () => null,
}));

vi.mock('@/components/system', () => ({
  CircleAlert: () => <svg aria-hidden="true" />,
  CircleCheck: () => <svg aria-hidden="true" />,
  Lightbulb: () => <svg aria-hidden="true" />,
  LoaderCircle: () => <svg aria-hidden="true" />,
  Skeleton: () => <div data-testid="skeleton" />,
}));

import { Messages } from './Messages';

describe('Messages', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mindReaderModeState.enabled = false;
    narrationModeState.enabled = false;
    taskPhaseState.phase = null;
    sandboxMessagesState.messages = [];
    historyReadyState.ready = true;
    mockBuildAcpRenderBlocks.mockReturnValue([]);
  });

  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
  });

  it('can hide the rendered session prompt via the renderSessionPrompt prop', () => {
    render(
      <Messages
        session={
          {
            taskId: 'task-1',
            prompt: {
              text: '$environment-setup',
              visibleInTranscript: true,
            },
            taskRun: null,
          } as never
        }
        renderSessionPrompt={false}
      />,
    );

    expect(screen.queryByText('$environment-setup')).not.toBeInTheDocument();
    expect(mockBuildAcpRenderBlocks).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        shouldHideFirstMessage: false,
      }),
    );
  });

  it('passes narration display mode into transcript rendering while keeping sleep rows visible', () => {
    narrationModeState.enabled = true;

    render(
      <Messages
        session={
          {
            taskId: 'task-1',
            prompt: null,
            taskRun: { id: 1 },
          } as never
        }
      />,
    );

    expect(mockBuildAcpRenderBlocks).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        displayMode: 'narration',
        showInternalMessages: false,
      }),
    );
    expect(screen.getByText('Sleep rows')).toBeInTheDocument();
  });

  it('passes mind reader mode into the reasoning expansion default', () => {
    mindReaderModeState.enabled = true;

    render(
      <Messages
        session={
          {
            taskId: 'task-1',
            prompt: null,
            taskRun: null,
          } as never
        }
      />,
    );

    expect(screen.getByTestId('message-ui-options')).toHaveAttribute(
      'data-expand-reasoning',
      'true',
    );
  });

  it('keeps internal transcript rows hidden when debug UI is disabled', () => {
    render(
      <Messages
        session={
          {
            taskId: 'task-1',
            prompt: null,
            taskRun: null,
          } as never
        }
      />,
    );

    expect(mockBuildAcpRenderBlocks).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        showInternalMessages: false,
      }),
    );
  });

  it('does not append a wrapper debug timestamp for the rendered session prompt', () => {
    render(
      <Messages
        session={
          {
            taskId: 'task-1',
            prompt: {
              text: '$environment-setup',
              ts: 123,
              previousTs: 100,
              role: 'user',
              visibleInTranscript: true,
            },
            taskRun: null,
          } as never
        }
      />,
    );

    expect(screen.getByText('$environment-setup')).toBeInTheDocument();
    expect(
      screen.queryByText('123', { selector: 'time' }),
    ).not.toBeInTheDocument();
  });

  it('shows a narration-mode reasoning indicator while work is running with no visible streaming output', () => {
    narrationModeState.enabled = true;
    taskPhaseState.phase = 'running';

    render(
      <Messages
        session={
          {
            taskId: 'task-1',
            prompt: null,
            taskRun: null,
          } as never
        }
      />,
    );

    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(700);
    });

    expect(screen.getByText('Thinking...')).toBeInTheDocument();
  });

  it('does not show the narration-mode reasoning indicator when visible assistant output already exists', () => {
    narrationModeState.enabled = true;
    taskPhaseState.phase = 'running';
    mockBuildAcpRenderBlocks.mockReturnValue([
      {
        kind: 'message',
        msg: {
          id: 'assistant-1',
          role: 'assistant',
          partial: false,
        },
      },
    ] as never);

    render(
      <Messages
        session={
          {
            taskId: 'task-1',
            prompt: null,
            taskRun: null,
          } as never
        }
      />,
    );

    act(() => {
      vi.advanceTimersByTime(700);
    });

    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
  });

  it('does not show the narration-mode reasoning indicator when only nested child assistant output is visible', () => {
    narrationModeState.enabled = true;
    taskPhaseState.phase = 'running';
    mockBuildAcpRenderBlocks.mockReturnValue([
      {
        kind: 'message',
        msg: {
          id: 'tool-result-1',
          role: 'tool',
          partial: false,
        },
        childBlocks: [
          {
            kind: 'message',
            msg: {
              id: 'assistant-child-1',
              role: 'assistant',
              partial: false,
            },
          },
        ],
      },
    ] as never);

    render(
      <Messages
        session={
          {
            taskId: 'task-1',
            prompt: null,
            taskRun: null,
          } as never
        }
      />,
    );

    act(() => {
      vi.advanceTimersByTime(700);
    });

    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
  });

  it('shows the narration-mode reasoning indicator when narration display mode is forced', () => {
    narrationModeState.enabled = false;
    taskPhaseState.phase = 'running';

    render(
      <Messages
        session={
          {
            taskId: 'task-1',
            prompt: null,
            taskRun: null,
          } as never
        }
        messageUiOptions={{ displayMode: 'narration' }}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(700);
    });

    expect(mockBuildAcpRenderBlocks).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        displayMode: 'narration',
      }),
    );
    expect(screen.getByText('Thinking...')).toBeInTheDocument();
  });

  it('hides session prompts flagged as hidden by the server', () => {
    render(
      <Messages
        session={
          {
            taskId: 'task-1',
            prompt: {
              text: '$review-code',
              visibleInTranscript: false,
            },
            taskRun: { id: 1 },
          } as never
        }
      />,
    );

    expect(screen.queryByText('$review-code')).not.toBeInTheDocument();
    expect(mockBuildAcpRenderBlocks).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        displayMode: 'default',
        shouldHideFirstMessage: false,
      }),
    );
  });

  it('hides the first ACP user prompt when the session prompt is rendered above', () => {
    render(
      <Messages
        session={
          {
            taskId: 'task-1',
            prompt: {
              text: 'Tell me a pirate joke.',
              images: ['pirate-map.png'],
              visibleInTranscript: true,
            },
            taskRun: null,
          } as never
        }
      />,
    );

    expect(mockBuildAcpRenderBlocks).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        displayMode: 'default',
        initialPrompt: expect.objectContaining({
          text: 'Tell me a pirate joke.',
          images: ['pirate-map.png'],
        }),
        shouldHideFirstMessage: true,
      }),
    );
  });

  it('shows the active goal objective without expanding tool traces', () => {
    render(
      <Messages
        session={
          {
            taskId: 'task-goal-active',
            prompt: null,
            task: {
              goalObjective: 'Count to ten',
              goalStatus: 'active',
              goalBlockedReason: null,
              goalGenerationIds: ['goal-generation:1'],
            },
            taskRun: null,
            refreshTaskSession: vi.fn(),
          } as never
        }
      />,
    );

    expect(screen.getByTestId('goal-status')).toHaveTextContent(
      'Pursuing goal',
    );
    expect(screen.getByTestId('goal-status')).toHaveTextContent('Count to ten');
    expect(screen.getByTestId('goal-status')).toHaveAttribute('role', 'status');
  });

  it.each([
    ['complete', 'Goal completed'],
    ['blocked', 'Goal blocked'],
  ] as const)('shows the %s terminal goal marker', (goalStatus, label) => {
    render(
      <Messages
        session={
          {
            taskId: `task-goal-${goalStatus}`,
            prompt: null,
            task: {
              goalObjective: 'Count to ten',
              goalStatus,
              goalBlockedReason:
                goalStatus === 'blocked' ? 'Waiting for a number' : null,
              goalGenerationIds: ['goal-generation:1'],
            },
            taskRun: null,
            refreshTaskSession: vi.fn(),
          } as never
        }
      />,
    );

    expect(screen.getByTestId('goal-status')).toHaveTextContent(label);
    expect(screen.getByTestId('goal-status')).toHaveTextContent('Count to ten');
    if (goalStatus === 'blocked') {
      expect(screen.getByTestId('goal-status')).toHaveTextContent(
        'Waiting for a number',
      );
    }
  });

  it('keeps a completed goal visible after an ordinary follow-up message', () => {
    mockBuildAcpRenderBlocks.mockReturnValue([
      {
        kind: 'message',
        msg: {
          id: 'ordinary-follow-up',
          ts: 2_000,
          role: 'user',
          kind: 'text',
          partial: false,
        },
      },
    ] as never);

    render(
      <Messages
        session={
          {
            taskId: 'task-goal-history',
            prompt: null,
            task: {
              goalObjective: 'Count to ten',
              goalStatus: 'complete',
              goalBlockedReason: null,
              goalGenerationIds: ['goal-generation:1'],
            },
            taskRun: null,
            artifacts: [],
            refreshTaskSession: vi.fn(),
          } as never
        }
      />,
    );

    expect(screen.getByText('ordinary-follow-up')).toBeInTheDocument();
    expect(screen.getByTestId('goal-status')).toHaveTextContent(
      'Goal completed',
    );
  });

  it('labels the matching historical goal turn when old envelopes lack provenance', () => {
    const goalMessage = {
      id: 'historical-goal-prompt',
      ts: 1_000,
      role: 'user',
      kind: 'text',
      partial: false,
      sessionId: 'session-1',
      updateType: 'roomote_runtime.user_prompt',
      text: 'Count to ten',
      data: {},
    };
    sandboxMessagesState.messages = [goalMessage];
    mockBuildAcpRenderBlocks.mockReturnValue([
      { kind: 'message', msg: goalMessage },
    ] as never);

    render(
      <Messages
        session={
          {
            taskId: 'task-goal-history',
            prompt: null,
            task: {
              goalObjective: 'Count to ten',
              goalStatus: 'complete',
              goalBlockedReason: null,
              goalGenerationIds: ['goal-generation:1'],
            },
            taskRun: null,
            artifacts: [],
            refreshTaskSession: vi.fn(),
          } as never
        }
      />,
    );

    expect(screen.getByText('Sent as goal')).toBeVisible();
    expect(screen.getByTestId('goal-status')).toHaveTextContent(
      'Goal completed',
    );
  });

  it('labels a legacy goal session prompt when no matching envelope exists', () => {
    render(
      <Messages
        session={
          {
            taskId: 'task-initial-goal-history',
            prompt: {
              id: 'session-prompt',
              ts: 1_000,
              role: 'user',
              kind: 'text',
              partial: false,
              sessionId: null,
              updateType: 'roomote_runtime.user_prompt',
              text: 'Count to ten',
              data: {},
              visibleInTranscript: true,
            },
            task: {
              goalObjective: 'Count to ten',
              goalStatus: 'complete',
              goalBlockedReason: null,
              goalGenerationIds: ['goal-generation:1'],
            },
            taskRun: null,
            artifacts: [],
            refreshTaskSession: vi.fn(),
          } as never
        }
      />,
    );

    expect(screen.getByText('Sent as goal')).toBeVisible();
    expect(screen.getByTestId('goal-status')).toHaveTextContent(
      'Goal completed',
    );
  });

  it('does not infer goal provenance when multiple legacy messages match', () => {
    const matchingMessages = [
      {
        id: 'historical-goal-prompt',
        ts: 1_000,
        role: 'user',
        kind: 'text',
        partial: false,
        sessionId: 'session-1',
        updateType: 'roomote_runtime.user_prompt',
        text: 'Count to ten',
        data: {},
      },
      {
        id: 'ordinary-duplicate-follow-up',
        ts: 2_000,
        role: 'user',
        kind: 'text',
        partial: false,
        sessionId: 'session-1',
        updateType: 'roomote_runtime.user_prompt',
        text: 'Count to ten',
        data: {},
      },
    ];
    sandboxMessagesState.messages = matchingMessages;
    mockBuildAcpRenderBlocks.mockReturnValue(
      matchingMessages.map((msg) => ({ kind: 'message', msg })) as never,
    );

    render(
      <Messages
        session={
          {
            taskId: 'task-goal-ambiguous-history',
            prompt: null,
            task: {
              goalObjective: 'Count to ten',
              goalStatus: 'complete',
              goalBlockedReason: null,
              goalGenerationIds: ['goal-generation:1'],
            },
            taskRun: null,
            artifacts: [],
            refreshTaskSession: vi.fn(),
          } as never
        }
      />,
    );

    expect(screen.queryByText('Sent as goal')).not.toBeInTheDocument();
    expect(screen.getByTestId('goal-status')).toHaveTextContent(
      'Goal completed',
    );
  });

  it('does not infer legacy goal provenance before history finishes loading', () => {
    const goalMessage = {
      id: 'partial-goal-prompt',
      ts: 1_000,
      role: 'user',
      kind: 'text',
      partial: false,
      sessionId: 'session-1',
      updateType: 'roomote_runtime.user_prompt',
      text: 'Count to ten',
      data: {},
    };
    historyReadyState.ready = false;
    sandboxMessagesState.messages = [goalMessage];
    mockBuildAcpRenderBlocks.mockReturnValue([
      { kind: 'message', msg: goalMessage },
    ] as never);

    render(
      <Messages
        session={
          {
            taskId: 'task-goal-partial-history',
            prompt: null,
            task: {
              goalObjective: 'Count to ten',
              goalStatus: 'active',
              goalBlockedReason: null,
              goalGenerationIds: ['goal-generation:1'],
            },
            taskRun: null,
            artifacts: [],
            refreshTaskSession: vi.fn(),
          } as never
        }
      />,
    );

    expect(screen.queryByText('Sent as goal')).not.toBeInTheDocument();
    expect(screen.getByTestId('goal-status')).toHaveTextContent(
      'Pursuing goal',
    );
  });

  it('leaves non-goal transcripts unchanged', () => {
    render(
      <Messages
        session={
          {
            taskId: 'task-ordinary',
            prompt: null,
            task: {
              goalObjective: null,
              goalStatus: null,
              goalBlockedReason: null,
              goalGenerationIds: [],
            },
            taskRun: null,
            refreshTaskSession: vi.fn(),
          } as never
        }
      />,
    );

    expect(screen.queryByTestId('goal-status')).not.toBeInTheDocument();
  });

  it('collapses eligible background activity between text messages', () => {
    mockBuildAcpRenderBlocks.mockReturnValue([
      {
        kind: 'message',
        msg: {
          id: 'assistant-text-1',
          ts: 1_000,
          role: 'assistant',
          kind: 'text',
          partial: false,
        },
      },
      {
        kind: 'message',
        msg: {
          id: 'reasoning-1',
          ts: 2_000,
          role: 'assistant',
          kind: 'reasoning',
          partial: false,
        },
      },
      {
        kind: 'message',
        msg: {
          id: 'assistant-text-2',
          ts: 19_000,
          role: 'assistant',
          kind: 'text',
          partial: false,
        },
      },
    ] as never);

    render(
      <Messages
        session={
          {
            taskId: 'task-1',
            prompt: null,
            taskRun: null,
            artifacts: [],
          } as never
        }
      />,
    );

    expect(screen.getByText('Worked for 17s')).toBeInTheDocument();
    expect(screen.getByText('reasoning-1')).toBeInTheDocument();
  });

  it('uses the rendered session prompt as the left boundary for initial activity', () => {
    mockBuildAcpRenderBlocks.mockReturnValue([
      {
        kind: 'message',
        msg: {
          id: 'reasoning-1',
          ts: 2_000,
          role: 'assistant',
          kind: 'reasoning',
          partial: false,
        },
      },
      {
        kind: 'message',
        msg: {
          id: 'assistant-text-1',
          ts: 9_000,
          role: 'assistant',
          kind: 'text',
          partial: false,
        },
      },
    ] as never);

    render(
      <Messages
        session={
          {
            taskId: 'task-1',
            prompt: {
              text: 'Initial prompt',
              visibleInTranscript: true,
            },
            taskRun: null,
            artifacts: [],
          } as never
        }
      />,
    );

    expect(screen.getByText('Initial prompt')).toBeInTheDocument();
    expect(screen.getByText('Worked for 7s')).toBeInTheDocument();
    expect(screen.getByText('reasoning-1')).toBeInTheDocument();
  });

  it('collapses initial eligible activity even when there is no visible starting text message', () => {
    mockBuildAcpRenderBlocks.mockReturnValue([
      {
        kind: 'message',
        msg: {
          id: 'reasoning-1',
          ts: 2_000,
          role: 'assistant',
          kind: 'reasoning',
          partial: false,
        },
      },
      {
        kind: 'message',
        msg: {
          id: 'assistant-text-1',
          ts: 12_000,
          role: 'assistant',
          kind: 'text',
          partial: false,
        },
      },
    ] as never);

    render(
      <Messages
        session={
          {
            taskId: 'task-1',
            prompt: null,
            taskRun: null,
            artifacts: [],
          } as never
        }
      />,
    );

    expect(screen.getByText('Worked for 10s')).toBeInTheDocument();
    expect(screen.getByText('reasoning-1')).toBeInTheDocument();
  });

  it('uses todo section markers as collapse boundaries while keeping them visible', () => {
    mockBuildAcpRenderBlocks.mockReturnValue([
      {
        kind: 'message',
        msg: {
          id: 'reasoning-1',
          ts: 2_000,
          role: 'assistant',
          kind: 'reasoning',
          partial: false,
        },
      },
      {
        kind: 'message',
        msg: {
          id: 'todo-1',
          ts: 3_000,
          role: 'assistant',
          kind: 'todo_section',
          partial: false,
          data: {
            todoId: 'todo-1',
            content: 'Inspect repository guidance',
          },
        },
      },
      {
        kind: 'message',
        msg: {
          id: 'reasoning-2',
          ts: 4_000,
          role: 'assistant',
          kind: 'reasoning',
          partial: false,
        },
      },
      {
        kind: 'message',
        msg: {
          id: 'assistant-text-1',
          ts: 12_000,
          role: 'assistant',
          kind: 'text',
          partial: false,
        },
      },
    ] as never);

    render(
      <Messages
        session={
          {
            taskId: 'task-1',
            prompt: null,
            taskRun: null,
            artifacts: [],
          } as never
        }
      />,
    );

    expect(screen.getByText('Worked for 1s')).toBeInTheDocument();
    expect(screen.getByText('Worked for 8s')).toBeInTheDocument();
    expect(screen.getByText('reasoning-1')).toBeInTheDocument();
    expect(screen.getByText('todo-1')).toBeInTheDocument();
    expect(screen.getByText('reasoning-2')).toBeInTheDocument();
  });
});
