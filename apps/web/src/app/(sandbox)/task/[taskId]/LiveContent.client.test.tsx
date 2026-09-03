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

vi.mock('./ActiveSubtasksList', () => ({
  ActiveSubtasksList: () => <div data-testid="active-subtasks" />,
}));

vi.mock('./PendingEnvVarRequestPanel', () => ({
  PendingEnvVarRequestPanel: () => <div data-testid="pending-env-var" />,
}));

vi.mock('./QueuedMessages', () => ({
  QueuedMessages: () => <div data-testid="queued-messages" />,
}));

vi.mock('./prompt-input', () => ({
  PromptInput: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="prompt-input" data-placeholder={placeholder} />
  ),
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
        promptPlaceholder="Message task, / for commands"
      />,
    );

    expect(screen.getByTestId('prompt-input')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-input')).toHaveAttribute(
      'data-placeholder',
      'Message task, / for commands',
    );
    expect(screen.getByTestId('todo-list')).toBeInTheDocument();
    expect(screen.getByTestId('active-subtasks')).toBeInTheDocument();
    expect(screen.getByTestId('pending-user-input')).toBeInTheDocument();
    expect(screen.getByTestId('pending-env-var')).toBeInTheDocument();
    expect(screen.getByTestId('queued-messages')).toBeInTheDocument();
  });

  it('keeps pending task activity visible while an option request hides the freeform prompt', () => {
    usePendingUserInputRequestStateMock.mockReturnValue({
      shouldHidePromptInput: true,
    });

    render(
      <TaskInputStack
        session={baseSession}
        promptInputRef={{ current: null }}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
        scrollToBottom={() => {}}
      />,
    );

    expect(screen.getByTestId('pending-user-input')).toBeInTheDocument();
    expect(screen.getByTestId('todo-list')).toBeInTheDocument();
    expect(screen.getByTestId('queued-messages')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-input').parentElement).toHaveClass(
      'hidden',
    );
  });
});
