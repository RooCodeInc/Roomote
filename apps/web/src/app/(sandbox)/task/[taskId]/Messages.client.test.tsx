import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

const { mockBuildAcpRenderBlocks } = vi.hoisted(() => ({
  mockBuildAcpRenderBlocks: vi.fn(() => []),
}));

const narrationModeState = vi.hoisted(() => ({
  enabled: false,
}));

const taskPhaseState = vi.hoisted(() => ({
  phase: null as string | null,
}));

const sandboxMessagesState = vi.hoisted(() => ({
  messages: [] as unknown[],
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

vi.mock('./hooks', () => ({
  useSandboxMessages: () => ({
    messages: sandboxMessagesState.messages,
  }),
  useSandboxHistoryReady: () => true,
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

vi.mock('./messages/index', () => ({
  SleepWakeMessages: () => <div>Sleep rows</div>,
}));

vi.mock('./messages/acp', () => ({
  AcpMessageItem: ({ msg }: { msg: { id: string } }) => <div>{msg.id}</div>,
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
  AcpTextMessage: ({ msg }: { msg: { text?: string } }) => (
    <div>{msg.text}</div>
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
  Lightbulb: () => <svg aria-hidden="true" />,
}));

import { Messages } from './Messages';

describe('Messages', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    narrationModeState.enabled = false;
    taskPhaseState.phase = null;
    sandboxMessagesState.messages = [];
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
