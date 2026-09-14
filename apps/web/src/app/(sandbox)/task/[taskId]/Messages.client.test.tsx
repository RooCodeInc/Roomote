import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { TaskArtifact } from '@/types';
import type { AcpConversationRenderBlock } from './messages/acp/activity-groups';
import type { AcpRenderBlock } from './messages/acp/render-blocks';
import type { AcpUiMessage } from './messages/acp/types';

const { mockBuildAcpRenderBlocks } = vi.hoisted(() => ({
  mockBuildAcpRenderBlocks: vi.fn(
    (_messages: unknown[], _options: Record<string, unknown>) =>
      [] as AcpRenderBlock[],
  ),
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

const historyControlsState = vi.hoisted(() => ({
  isError: false,
  isRetrying: false,
  retry: vi.fn(async () => undefined),
  hasOlderMessages: false,
  isFetchingOlderMessages: false,
  olderMessagesError: null as unknown,
  fetchOlderMessages: vi.fn(async () => false),
}));

const scrollState = vi.hoisted(() => ({
  element: null as HTMLDivElement | null,
  stopScroll: vi.fn(),
}));

vi.mock('use-stick-to-bottom', () => ({
  useStickToBottomContext: () => ({
    scrollRef: { current: scrollState.element },
    stopScroll: scrollState.stopScroll,
  }),
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
  useSandboxHistoryControls: () => historyControlsState,
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

vi.mock('./messages/acp', async () => {
  const { buildAcpActivityRenderBlocks } =
    await import('./messages/acp/activity-groups');
  const hasAssistantOutput = (blocks: AcpConversationRenderBlock[]): boolean =>
    blocks.some((block) =>
      block.kind === 'activity_group'
        ? hasAssistantOutput(block.blocks)
        : block.kind === 'tool_group'
          ? false
          : block.msg.role === 'assistant' ||
            hasAssistantOutput(block.childBlocks ?? []),
    );
  const renderBlock = (block: AcpConversationRenderBlock): ReactNode => {
    if (block.kind === 'activity_group') {
      return (
        <div key={block.id}>
          <button type="button">
            Worked for {Math.round((block.endTs - block.ts) / 1000)}s
          </button>
          <div>{block.blocks.map(renderBlock)}</div>
        </div>
      );
    }
    if (block.kind === 'tool_group') return null;
    return (
      <div key={block.msg.id}>
        {block.msg.id}
        {block.childBlocks?.map(renderBlock)}
      </div>
    );
  };

  return {
    AcpTextMessage: ({ msg }: { msg: { text?: string } }) => (
      <div>{msg.text}</div>
    ),
    AcpTranscriptBlockList: ({
      blocks,
    }: {
      blocks: AcpConversationRenderBlock[];
    }) => <>{blocks.map(renderBlock)}</>,
    hasVisibleAssistantOutput: hasAssistantOutput,
    useAcpTranscriptBlocks: (options: {
      messages: AcpUiMessage[];
      artifacts: TaskArtifact[];
      displayMode: 'default' | 'narration';
      initialPrompt: AcpUiMessage | null;
      shouldHideFirstMessage: boolean;
      showInternalMessages: boolean;
      hasLeadingTextBoundary: boolean;
    }) => {
      const blocks = mockBuildAcpRenderBlocks(options.messages, {
        displayMode: options.displayMode,
        initialPrompt: options.initialPrompt,
        shouldHideFirstMessage: options.shouldHideFirstMessage,
        showInternalMessages: options.showInternalMessages,
        suppressedMessageIds: new Set(),
      });
      return {
        renderBlocks: buildAcpActivityRenderBlocks(blocks, {
          artifacts: options.artifacts,
          displayMode: options.displayMode,
          hasLeadingTextBoundary: options.hasLeadingTextBoundary,
        }),
        suppressMessage: vi.fn(),
      };
    },
  };
});

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
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Lightbulb: () => <svg aria-hidden="true" />,
  Skeleton: ({ className }: { className?: string }) => (
    <div className={className} />
  ),
}));

import { Messages } from './Messages';

function createScrollElement(scrollTop = 1_200, scrollHeight = 2_000) {
  const element = document.createElement('div');
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    value: scrollHeight,
  });
  element.scrollTop = scrollTop;
  return element;
}

describe('Messages', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mindReaderModeState.enabled = false;
    narrationModeState.enabled = false;
    taskPhaseState.phase = null;
    sandboxMessagesState.messages = [];
    historyControlsState.isError = false;
    historyControlsState.isRetrying = false;
    historyControlsState.hasOlderMessages = false;
    historyControlsState.isFetchingOlderMessages = false;
    historyControlsState.olderMessagesError = null;
    historyControlsState.retry.mockClear();
    historyControlsState.fetchOlderMessages.mockClear();
    scrollState.element = null;
    scrollState.stopScroll.mockClear();
    mockBuildAcpRenderBlocks.mockReturnValue([]);
  });

  it('offers retry when initial conversation history fails', async () => {
    historyControlsState.isError = true;

    render(<Messages session={{ taskId: 'task-1', taskRun: null } as never} />);

    screen.getByText('Conversation history could not be loaded.');
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(historyControlsState.retry).toHaveBeenCalledOnce();
  });

  it.each([390, 1_280])(
    'loads one older page when scrolling near the top at %ipx wide',
    async (width) => {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: width,
      });
      historyControlsState.hasOlderMessages = true;
      const scrollElement = createScrollElement();
      scrollState.element = scrollElement;

      render(
        <Messages session={{ taskId: 'task-1', taskRun: null } as never} />,
      );

      scrollElement.scrollTop = 800;
      await act(async () => {
        fireEvent.scroll(scrollElement);
        await Promise.resolve();
      });
      expect(historyControlsState.fetchOlderMessages).toHaveBeenCalledOnce();
    },
  );

  it('preserves the visible scroll position when older messages are prepended', async () => {
    historyControlsState.hasOlderMessages = true;
    sandboxMessagesState.messages = [{ id: 'newer-message' }];
    const scrollElement = createScrollElement(400, 1_000);
    scrollState.element = scrollElement;
    historyControlsState.fetchOlderMessages.mockImplementationOnce(async () => {
      sandboxMessagesState.messages = [
        { id: 'older-message' },
        { id: 'newer-message' },
      ];
      Object.defineProperty(scrollElement, 'scrollHeight', {
        configurable: true,
        value: 1_400,
      });
      return true;
    });

    const { rerender } = render(
      <Messages session={{ taskId: 'task-1', taskRun: null } as never} />,
    );

    await act(async () => {
      fireEvent.scroll(scrollElement);
      await Promise.resolve();
    });
    expect(historyControlsState.fetchOlderMessages).toHaveBeenCalledOnce();
    rerender(
      <Messages session={{ taskId: 'task-1', taskRun: null } as never} />,
    );

    expect(scrollState.stopScroll).toHaveBeenCalledOnce();
    expect(scrollElement.scrollTop).toBe(800);
  });

  it('prevents overlapping loads and requires leaving the threshold before loading again', async () => {
    historyControlsState.hasOlderMessages = true;
    const scrollElement = createScrollElement();
    scrollState.element = scrollElement;
    let resolveLoad: ((loaded: boolean) => void) | undefined;
    historyControlsState.fetchOlderMessages.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    render(<Messages session={{ taskId: 'task-1', taskRun: null } as never} />);

    scrollElement.scrollTop = 500;
    await act(async () => {
      fireEvent.scroll(scrollElement);
      fireEvent.scroll(scrollElement);
      await Promise.resolve();
    });
    expect(historyControlsState.fetchOlderMessages).toHaveBeenCalledOnce();

    await act(async () => resolveLoad?.(true));
    fireEvent.scroll(scrollElement);
    expect(historyControlsState.fetchOlderMessages).toHaveBeenCalledOnce();

    scrollElement.scrollTop = 900;
    fireEvent.scroll(scrollElement);
    scrollElement.scrollTop = 500;
    await act(async () => {
      fireEvent.scroll(scrollElement);
      await Promise.resolve();
    });
    expect(historyControlsState.fetchOlderMessages).toHaveBeenCalledTimes(2);
  });

  it('stops automatic loading after failure and keeps manual retry visible', async () => {
    historyControlsState.hasOlderMessages = true;
    const scrollElement = createScrollElement();
    scrollState.element = scrollElement;
    historyControlsState.fetchOlderMessages.mockImplementationOnce(async () => {
      historyControlsState.olderMessagesError = new Error('network error');
      return false;
    });

    const { rerender } = render(
      <Messages session={{ taskId: 'task-1', taskRun: null } as never} />,
    );

    scrollElement.scrollTop = 500;
    await act(async () => {
      fireEvent.scroll(scrollElement);
      await Promise.resolve();
    });
    expect(historyControlsState.fetchOlderMessages).toHaveBeenCalledOnce();
    rerender(
      <Messages session={{ taskId: 'task-1', taskRun: null } as never} />,
    );

    fireEvent.scroll(scrollElement);
    expect(historyControlsState.fetchOlderMessages).toHaveBeenCalledOnce();

    historyControlsState.fetchOlderMessages.mockImplementationOnce(async () => {
      historyControlsState.olderMessagesError = null;
      return true;
    });
    screen
      .getByRole('button', { name: 'Retry loading older messages' })
      .click();

    await act(async () => {
      await Promise.resolve();
    });
    expect(historyControlsState.fetchOlderMessages).toHaveBeenCalledTimes(2);
  });

  it('stops requesting pages at the end of history', async () => {
    historyControlsState.hasOlderMessages = true;
    const scrollElement = createScrollElement();
    scrollState.element = scrollElement;
    historyControlsState.fetchOlderMessages.mockImplementationOnce(async () => {
      historyControlsState.hasOlderMessages = false;
      return true;
    });

    const { rerender } = render(
      <Messages session={{ taskId: 'task-1', taskRun: null } as never} />,
    );

    scrollElement.scrollTop = 500;
    await act(async () => {
      fireEvent.scroll(scrollElement);
      await Promise.resolve();
    });
    expect(historyControlsState.fetchOlderMessages).toHaveBeenCalledOnce();
    rerender(
      <Messages session={{ taskId: 'task-1', taskRun: null } as never} />,
    );

    scrollElement.scrollTop = 900;
    fireEvent.scroll(scrollElement);
    scrollElement.scrollTop = 500;
    fireEvent.scroll(scrollElement);

    expect(historyControlsState.fetchOlderMessages).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole('button', { name: /older messages/i }),
    ).not.toBeInTheDocument();
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

    expect(screen.queryByText('Worked for 17s')).not.toBeInTheDocument();
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
    expect(screen.queryByText('Worked for 7s')).not.toBeInTheDocument();
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

    expect(screen.queryByText('Worked for 10s')).not.toBeInTheDocument();
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

    expect(screen.queryByText(/Worked for/)).not.toBeInTheDocument();
    expect(screen.getByText('reasoning-1')).toBeInTheDocument();
    expect(screen.getByText('todo-1')).toBeInTheDocument();
    expect(screen.getByText('reasoning-2')).toBeInTheDocument();
  });
});
