import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import type { CloudSession } from './hooks/use-cloud-session';

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

vi.mock('./startup', () => ({
  Startup: () => <div data-testid="startup" />,
}));

import { TaskInputStack } from './TaskInputStack';

const baseSession: CloudSession = {
  artifacts: [],
  blank: false,
  cloudJob: {
    id: 1,
    status: 'dequeued' as const,
    taskPhase: null,
    payloadKind: 'standard' as const,
  } as CloudSession['cloudJob'],
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

  it('shows the startup surface instead of the prompt input while booting', () => {
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

    expect(screen.getByTestId('startup')).toBeInTheDocument();
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
    expect(screen.queryByTestId('startup')).not.toBeInTheDocument();
  });
});
