import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import type { TaskSession } from './hooks/use-task-session';

const { usePendingUserInputRequestStateMock } = vi.hoisted(() => ({
  usePendingUserInputRequestStateMock: vi.fn(),
}));

vi.mock('./PendingUserInputRequestPanel', () => ({
  PendingUserInputRequestPanel: () => <div data-testid="pending-user-input" />,
  PendingUserInputRequestStateProvider: ({
    children,
  }: {
    children: ReactNode;
  }) => <>{children}</>,
  usePendingUserInputRequestState: usePendingUserInputRequestStateMock,
}));

vi.mock('./TodoList', () => ({
  TodoList: () => <div data-testid="todo-list" />,
}));

vi.mock('./PendingEnvVarRequestPanel', () => ({
  PendingEnvVarRequestPanel: () => <div data-testid="pending-env-var" />,
}));

vi.mock('./QueuedMessages', () => ({
  QueuedMessages: () => <div data-testid="queued-messages" />,
}));

vi.mock('./prompt-input', () => ({
  PromptInput: () => <div data-testid="prompt-input" />,
}));

import { TaskInputStack } from './TaskInputStack';

const baseSession: TaskSession = {
  artifacts: [],
  blank: false,
  taskRun: {
    id: 1,
    status: 'dequeued' as const,
    taskPhase: null,
    payloadKind: 'standard' as const,
  } as TaskSession['taskRun'],
  draftPrompt: null,
  harness: 'opencode-server',
  hasTransportError: false,
  transportErrorCategory: null,
  isLoading: false,
  isSessionLoading: false,
  isTokenLoading: false,
  prompt: null,
  refreshConnection: vi.fn(),
  sessionState: 'interactive',
  task: null,
  taskId: 'task-123',
  token: undefined,
};

describe('TaskInputStack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePendingUserInputRequestStateMock.mockReturnValue({
      shouldHidePromptInput: false,
    });
  });

  it('leaves the input area empty while startup renders in the conversation', () => {
    render(
      <TaskInputStack
        session={{
          ...baseSession,
          sessionState: 'booting',
        }}
        promptInputRef={{ current: null }}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
        scrollToBottom={() => {}}
      />,
    );

    expect(screen.queryByTestId('prompt-input')).not.toBeInTheDocument();
  });

  it('shows the prompt input once the session is interactive', () => {
    render(
      <TaskInputStack
        session={baseSession}
        promptInputRef={{ current: null }}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
        scrollToBottom={() => {}}
      />,
    );

    expect(screen.getByTestId('prompt-input')).toBeInTheDocument();
  });

  it('places the durable goal panel immediately above the composer', () => {
    render(
      <TaskInputStack
        session={{
          ...baseSession,
          task: {
            goalObjective: 'Finish the current objective',
            goalStatus: 'active',
            goalStartedAt: new Date('2026-08-14T12:00:00Z'),
            goalEndedAt: null,
          } as never,
        }}
        promptInputRef={{ current: null }}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
        scrollToBottom={() => {}}
      />,
    );

    const panel = screen.getByTestId('goal-panel');
    const composer = screen.getByTestId('prompt-input');
    expect(panel.compareDocumentPosition(composer)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('keeps the durable goal panel after an ordinary follow-up update', () => {
    const task = {
      goalObjective: 'Finish the current objective',
      goalStatus: 'complete',
      goalStartedAt: new Date('2026-08-14T12:00:00Z'),
      goalEndedAt: new Date('2026-08-14T12:01:00Z'),
    } as never;
    const { rerender } = render(
      <TaskInputStack
        session={{ ...baseSession, task }}
        promptInputRef={{ current: null }}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
        scrollToBottom={() => {}}
      />,
    );

    rerender(
      <TaskInputStack
        session={{ ...baseSession, task, draftPrompt: 'Ordinary follow-up' }}
        promptInputRef={{ current: null }}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
        scrollToBottom={() => {}}
      />,
    );

    expect(screen.getByTestId('goal-panel')).toHaveTextContent('Complete');
    expect(screen.getByTestId('goal-panel')).toHaveTextContent(
      'Finish the current objective',
    );
  });

  it('does not add goal UI for a non-goal task', () => {
    render(
      <TaskInputStack
        session={baseSession}
        promptInputRef={{ current: null }}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
        scrollToBottom={() => {}}
      />,
    );

    expect(screen.queryByTestId('goal-panel')).not.toBeInTheDocument();
  });
});
