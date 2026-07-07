import { fireEvent, render, screen } from '@testing-library/react';

import type {
  AcpToolCallUiMessage,
  AcpToolResultUiMessage,
} from './messages/acp/types';

const {
  useSandboxMessagesMock,
  useIsInsideSandboxProviderMock,
  useSandboxTaskPhaseMock,
  useInternalTranscriptRowsVisibleMock,
} = vi.hoisted(() => ({
  useSandboxMessagesMock: vi.fn<() => { messages: unknown[] }>(),
  useIsInsideSandboxProviderMock: vi.fn<() => boolean>(),
  useSandboxTaskPhaseMock:
    vi.fn<() => 'running' | 'waiting_for_user_input' | 'idle' | null>(),
  useInternalTranscriptRowsVisibleMock: vi.fn<() => boolean>(),
}));

vi.mock('./hooks/SandboxProvider', () => ({
  useSandboxMessages: useSandboxMessagesMock,
  useIsInsideSandboxProvider: useIsInsideSandboxProviderMock,
  useSandboxTaskPhase: useSandboxTaskPhaseMock,
}));

vi.mock('./useInternalTranscriptRowsVisible', () => ({
  useInternalTranscriptRowsVisible: useInternalTranscriptRowsVisibleMock,
}));

import { ActiveSubtasksList } from './ActiveSubtasksList';

function buildSubagentMessage(
  overrides: Partial<AcpToolResultUiMessage['data']> = {},
): AcpToolResultUiMessage {
  return {
    id: 'subagent-result-1',
    ts: 1,
    role: 'tool',
    partial: false,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.tool_result',
    kind: 'tool_result',
    data: {
      toolCallId: 'call-1',
      kind: 'subagent',
      title: 'Spawning explorer subagent',
      status: 'completed',
      isExecute: false,
      isMcp: false,
      mcpServerName: null,
      mcpToolName: null,
      command: null,
      exitCode: null,
      output: '',
      isSubagentSpawn: true,
      senderThreadId: 'thread-parent',
      receiverThreadIds: ['thread-child-1'],
      agentsStates: {
        'thread-child-1': {
          status: 'pendingInit',
          message: null,
        },
      },
      prompt: 'Inspect the transcript grouping path.',
      agentType: 'explorer',
      model: 'gpt-5.4-mini',
      reasoningEffort: 'medium',
      ...overrides,
    },
  };
}

function buildPendingToolCall(
  overrides: Partial<AcpToolCallUiMessage['data']> = {},
): AcpToolCallUiMessage {
  return {
    id: 'subagent-call-1',
    ts: 1,
    role: 'tool',
    partial: true,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.tool_call',
    kind: 'tool_call',
    data: {
      toolCallId: 'call-1',
      kind: 'subagent',
      title: 'Spawning worker subagent',
      status: 'in_progress',
      isExecute: false,
      isRead: false,
      isMcp: false,
      mcpServerName: null,
      mcpToolName: null,
      command: null,
      isSubagentSpawn: true,
      senderThreadId: 'thread-parent',
      receiverThreadIds: [],
      agentsStates: {},
      prompt: null,
      agentType: 'worker',
      model: 'gpt-5.4-mini',
      reasoningEffort: 'medium',
      ...overrides,
    },
  };
}

describe('ActiveSubtasksList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useIsInsideSandboxProviderMock.mockReturnValue(true);
    useSandboxTaskPhaseMock.mockReturnValue('running');
    useInternalTranscriptRowsVisibleMock.mockReturnValue(true);
    useSandboxMessagesMock.mockReturnValue({ messages: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders active subagents with type, name, and runtime after expanding the dock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T00:00:10.000Z'));

    const activeSubagentMessage = buildSubagentMessage();
    activeSubagentMessage.ts = Date.now() - 5_000;

    useSandboxMessagesMock.mockReturnValue({
      messages: [activeSubagentMessage],
    });

    render(<ActiveSubtasksList taskEntryKey="task-1" />);

    const trigger = screen.getByRole('button', { name: /1 active subagent/i });

    expect(trigger).toBeVisible();
    expect(
      screen.queryByText('Inspect the transcript grouping path.'),
    ).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(
      screen.getByText('Inspect the transcript grouping path.'),
    ).toBeVisible();
    expect(screen.getByText(/Explorer/)).toBeVisible();
    expect(screen.getByText('5s')).toBeVisible();
  });

  it('does not expand active subagents by default', () => {
    useSandboxMessagesMock.mockReturnValue({
      messages: [buildSubagentMessage()],
    });

    render(<ActiveSubtasksList taskEntryKey="task-1" />);

    expect(
      screen.getByRole('button', { name: /1 active subagent/i }),
    ).toBeVisible();
    expect(
      screen.queryByText('Inspect the transcript grouping path.'),
    ).not.toBeInTheDocument();
  });

  it('dedupes late placeholder launches once the child thread is known', () => {
    const activeSubagentMessage = buildSubagentMessage();
    activeSubagentMessage.ts = 1_000;

    const latePlaceholderMessage = buildPendingToolCall({
      title: 'Spawning explorer subagent',
      prompt: 'Inspect the transcript grouping path.',
      agentType: 'explorer',
    });
    latePlaceholderMessage.ts = 2_000;

    useSandboxMessagesMock.mockReturnValue({
      messages: [activeSubagentMessage, latePlaceholderMessage],
    });

    render(<ActiveSubtasksList taskEntryKey="task-1" />);

    const trigger = screen.getByRole('button', { name: /1 active subagent/i });

    expect(trigger).toBeVisible();

    fireEvent.click(trigger);

    expect(
      screen.getAllByText('Inspect the transcript grouping path.'),
    ).toHaveLength(1);
    expect(
      screen.queryByText('Spawning explorer subagent'),
    ).not.toBeInTheDocument();
  });

  it('shows pending subagent launches before child thread ids exist', () => {
    useSandboxMessagesMock.mockReturnValue({
      messages: [buildPendingToolCall()],
    });

    render(<ActiveSubtasksList taskEntryKey="task-1" />);

    const trigger = screen.getByRole('button', { name: /1 active subagent/i });

    expect(trigger).toBeVisible();

    fireEvent.click(trigger);

    expect(screen.getByText('Spawning worker subagent')).toBeVisible();
    expect(screen.getByText(/Worker/)).toBeVisible();
  });

  it('hides completed subagents after the latest child state resolves', () => {
    const completedSubtaskMessage = buildSubagentMessage({
      toolCallId: 'call-2',
      receiverThreadIds: ['thread-child-2'],
      agentsStates: {
        'thread-child-2': {
          status: 'completed',
          message: 'Done.',
        },
      },
      prompt: 'Wrap up the child task.',
    });

    completedSubtaskMessage.id = 'subagent-result-2';

    useSandboxMessagesMock.mockReturnValue({
      messages: [buildSubagentMessage(), completedSubtaskMessage],
    });

    render(<ActiveSubtasksList taskEntryKey="task-1" />);

    const trigger = screen.getByRole('button', { name: /1 active subagent/i });

    expect(trigger).toBeVisible();

    fireEvent.click(trigger);

    expect(
      screen.queryByText('Wrap up the child task.'),
    ).not.toBeInTheDocument();
  });

  it('hides the dock when internal transcript rows are disabled', () => {
    useInternalTranscriptRowsVisibleMock.mockReturnValue(false);
    useSandboxMessagesMock.mockReturnValue({
      messages: [buildSubagentMessage()],
    });

    const { container } = render(<ActiveSubtasksList taskEntryKey="task-1" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the dock visible while the task waits for user input', () => {
    useSandboxTaskPhaseMock.mockReturnValue('waiting_for_user_input');
    useSandboxMessagesMock.mockReturnValue({
      messages: [buildSubagentMessage()],
    });

    render(<ActiveSubtasksList taskEntryKey="task-1" />);

    expect(
      screen.getByRole('button', { name: /1 active subagent/i }),
    ).toBeVisible();
  });

  it('returns null outside the sandbox provider', () => {
    useIsInsideSandboxProviderMock.mockReturnValue(false);
    useSandboxMessagesMock.mockReturnValue({
      messages: [buildSubagentMessage()],
    });

    const { container } = render(<ActiveSubtasksList taskEntryKey="task-1" />);

    expect(container).toBeEmptyDOMElement();
  });
});
