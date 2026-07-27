import { render, screen } from '@testing-library/react';
import { ACP_ENVELOPE_EVENT_TYPES, RunStatus } from '@roomote/types';

import { HistoricalSandboxProvider } from '../HistoricalSandboxProvider';
import { useSandboxMessages, useSandboxTaskPhase } from '../SandboxProvider';
import type { TaskMessageEnvelope } from '@/types';

function PhaseProbe() {
  const phase = useSandboxTaskPhase();

  return <div data-testid="phase">{phase ?? 'none'}</div>;
}

function MessageKindsProbe() {
  const { messages } = useSandboxMessages();

  return (
    <div data-testid="messages">
      {JSON.stringify(
        messages.map((message) => ({
          kind: message.kind,
          text: message.text,
          title:
            message.kind === 'tool_call' || message.kind === 'tool_result'
              ? message.data.title
              : null,
        })),
      )}
    </div>
  );
}

describe('HistoricalSandboxProvider', () => {
  const history = {
    data: [],
    isPending: false,
    isSuccess: true,
    isError: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('seeds the sandbox task phase from persisted task metadata', () => {
    render(
      <HistoricalSandboxProvider
        taskId="task-123"
        history={history}
        harness="opencode-server"
        taskStatus={RunStatus.Completed}
        taskPhase="idle"
      >
        <PhaseProbe />
      </HistoricalSandboxProvider>,
    );

    expect(screen.getByTestId('phase')).toHaveTextContent('idle');
  });

  it('keeps workspace children mounted while history is loading', () => {
    render(
      <HistoricalSandboxProvider
        taskId="task-123"
        history={{
          data: undefined,
          isPending: true,
          isSuccess: false,
          isError: false,
        }}
        harness="opencode-server"
      >
        <div data-testid="workspace-shell" />
      </HistoricalSandboxProvider>,
    );

    expect(screen.getByTestId('workspace-shell')).toBeInTheDocument();
  });

  it('updates the sandbox task phase when persisted task metadata changes', () => {
    const { rerender } = render(
      <HistoricalSandboxProvider
        taskId="task-123"
        history={history}
        harness="opencode-server"
        taskStatus={RunStatus.Running}
        taskPhase={null}
      >
        <PhaseProbe />
      </HistoricalSandboxProvider>,
    );

    expect(screen.getByTestId('phase')).toHaveTextContent('none');

    rerender(
      <HistoricalSandboxProvider
        taskId="task-123"
        history={history}
        harness="opencode-server"
        taskStatus={RunStatus.Completed}
        taskPhase="waiting_for_prompt"
      >
        <PhaseProbe />
      </HistoricalSandboxProvider>,
    );

    expect(screen.getByTestId('phase')).toHaveTextContent('waiting_for_prompt');
  });

  it('hydrates historical tool-call updates into transcript messages', () => {
    const history = {
      data: [
        {
          id: 'user-1',
          userId: 'user-1',
          userName: 'Ada',
          userEmail: 'ada@example.com',
          userImageUrl: null,
          taskId: 'task-123',
          ts: 1,
          createdAt: 1,
          sequence: 1,
          eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
          role: 'user',
          kind: 'text',
          protocol: 'roomote_runtime',
          contentBlocks: [{ type: 'text', text: 'Inspect the transcript UI' }],
          metadata: { sessionId: 'session-1' },
          payload: {},
          text: 'Inspect the transcript UI',
        },
        {
          id: 'assistant-1',
          userId: null,
          userName: null,
          userEmail: null,
          userImageUrl: null,
          taskId: 'task-123',
          ts: 2,
          createdAt: 2,
          sequence: 2,
          eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
          role: 'assistant',
          kind: 'text',
          protocol: 'roomote_runtime',
          contentBlocks: [{ type: 'text', text: 'I spawned the explorer.' }],
          metadata: { sessionId: 'session-1' },
          payload: {},
          text: 'I spawned the explorer.',
        },
        {
          id: 'tool-call-1',
          userId: null,
          userName: null,
          userEmail: null,
          userImageUrl: null,
          taskId: 'task-123',
          ts: 3,
          createdAt: 3,
          sequence: 3,
          eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
          role: 'tool',
          kind: 'tool_call',
          protocol: 'roomote_runtime',
          contentBlocks: [],
          metadata: { sessionId: 'session-1' },
          payload: {
            toolCallId: 'call-1',
            kind: 'subagent',
            title: 'Spawning subagent',
            status: 'in_progress',
            isSubagentSpawn: true,
          },
          text: 'Spawning subagent',
        },
        {
          id: 'tool-update-1',
          userId: null,
          userName: null,
          userEmail: null,
          userImageUrl: null,
          taskId: 'task-123',
          ts: 4,
          createdAt: 4,
          sequence: 4,
          eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate,
          role: 'tool',
          kind: 'tool_result',
          protocol: 'roomote_runtime',
          contentBlocks: [],
          metadata: { sessionId: 'session-1' },
          payload: {
            toolCallId: 'call-1',
            kind: 'subagent',
            title: 'Subagent completed',
            status: 'completed',
            isSubagentSpawn: true,
            output: 'Found the issue.',
          },
          text: 'Subagent completed',
        },
      ] satisfies TaskMessageEnvelope[],
      isPending: false,
      isSuccess: true,
      isError: false,
    };

    render(
      <HistoricalSandboxProvider
        taskId="task-123"
        history={history}
        harness="opencode-server"
        taskStatus={RunStatus.Completed}
        taskPhase="idle"
      >
        <MessageKindsProbe />
      </HistoricalSandboxProvider>,
    );

    const renderedMessages = JSON.parse(
      screen.getByTestId('messages').textContent ?? '[]',
    ) as Array<{ kind: string; text?: string; title: string | null }>;

    expect(renderedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool_result',
          title: 'Subagent completed',
        }),
      ]),
    );
  });
});
