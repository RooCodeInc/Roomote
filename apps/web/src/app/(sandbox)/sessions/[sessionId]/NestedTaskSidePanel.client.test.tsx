import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { RunStatus } from '@roomote/types';

const useTaskSessionMock = vi.fn();
const useTaskMessageEnvelopesMock = vi.fn();
const useSleepInvalidationMock = vi.fn();

vi.mock('../../task/[taskId]/hooks/use-task-session', () => ({
  useTaskSession: (...args: unknown[]) => useTaskSessionMock(...args),
}));

vi.mock('../../task/[taskId]/hooks/use-task-message-envelopes', () => ({
  useTaskMessageEnvelopes: (...args: unknown[]) =>
    useTaskMessageEnvelopesMock(...args),
}));

vi.mock('../../task/[taskId]/hooks/HistoricalSandboxProvider', () => ({
  HistoricalSandboxProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="historical-provider">{children}</div>
  ),
}));

vi.mock('../../task/[taskId]/hooks/SandboxProvider', () => ({
  SandboxProvider: ({
    taskId,
    children,
  }: {
    taskId: string;
    children: ReactNode;
  }) => (
    <div data-testid="live-provider" data-task-id={taskId}>
      {children}
    </div>
  ),
}));

vi.mock('../../task/[taskId]/hooks/use-sleep-invalidation', () => ({
  useSleepInvalidation: (...args: unknown[]) =>
    useSleepInvalidationMock(...args),
}));

vi.mock('../../task/[taskId]/ErrorFallback', () => ({
  ConnectionStatusBanner: () => <div>Task connection status</div>,
}));

vi.mock('../../task/[taskId]/PendingUserInputRequestPanel', () => ({
  PendingUserInputRequestStateProvider: ({
    taskId,
    children,
  }: {
    taskId: string;
    children: ReactNode;
  }) => (
    <div data-testid="pending-input-provider" data-task-id={taskId}>
      {children}
    </div>
  ),
}));

vi.mock('../../task/[taskId]/TaskInputStack', () => ({
  TaskInputStack: ({
    session,
    promptPlaceholder,
    onFileSearchOpen,
    onCommandSearchOpen,
  }: {
    session: { taskId: string; sessionState: string };
    promptPlaceholder: string;
    onFileSearchOpen: () => void;
    onCommandSearchOpen: () => void;
  }) => (
    <div data-testid="task-input-stack" data-task-id={session.taskId}>
      {session.sessionState !== 'booting' ? (
        <label>
          Task composer
          <textarea placeholder={promptPlaceholder} />
        </label>
      ) : null}
      <div>Queued task messages</div>
      <div>Pending task requests</div>
      <button type="button" onClick={onFileSearchOpen}>
        Search task files
      </button>
      <button type="button" onClick={onCommandSearchOpen}>
        Search task commands
      </button>
    </div>
  ),
}));

vi.mock('../../task/[taskId]/FileSearch', () => ({
  FileSearch: ({ open }: { open: boolean }) =>
    open ? <div>Task file search</div> : null,
}));

vi.mock('../../task/[taskId]/CommandSearch', () => ({
  CommandSearch: ({ open }: { open: boolean }) =>
    open ? <div>Task command search</div> : null,
}));

vi.mock('../../task/[taskId]/WakeTaskInput', () => ({
  WakeTaskInput: ({ initialPrompt }: { initialPrompt: string }) => (
    <div>Wake task input: {initialPrompt}</div>
  ),
}));

vi.mock('../../task/[taskId]/DraftPromptBanner', () => ({
  DraftPromptBanner: ({ draftPrompt }: { draftPrompt: string }) => (
    <div>Resuming task draft: {draftPrompt}</div>
  ),
}));

vi.mock('../../task/[taskId]/Messages', () => ({
  Messages: ({ footer }: { footer?: ReactNode }) => {
    const artifactLink = useArtifactLink();

    return (
      <div>
        Child transcript
        <button
          type="button"
          onClick={() => artifactLink?.openArtifact('proof/result.png', 2)}
        >
          Open nested artifact
        </button>
        {footer}
      </div>
    );
  },
}));

vi.mock('../../task/[taskId]/startup', () => ({
  Startup: ({
    runId,
    initialTaskRun,
  }: {
    runId: number;
    initialTaskRun: { status: RunStatus };
  }) => (
    <div data-testid="startup-progress">
      {runId}:{initialTaskRun.status}
    </div>
  ),
}));

vi.mock('../../task/[taskId]/sidebar-panels/SidePanelHeader', () => ({
  SidePanelHeader: ({
    title,
    actions,
    titleAdornment,
  }: {
    title?: string;
    actions: ReactNode;
    titleAdornment?: ReactNode;
  }) => (
    <header>
      {title}
      {titleAdornment}
      {actions}
    </header>
  ),
}));

vi.mock('@/components/sandbox', () => ({
  WorkspaceBadge: ({
    environmentId,
    repo,
  }: {
    environmentId?: string;
    repo?: string;
  }) => (
    <span>{environmentId ? `Workspace ${environmentId}` : `Repo ${repo}`}</span>
  ),
}));

import { useArtifactLink } from '../../task/[taskId]/hooks/ArtifactLinkProvider';
import { NestedTaskSidePanel } from './NestedTaskSidePanel';

const baseSession = {
  taskId: 'child-1',
  task: { title: 'Fix checkout' },
  taskRun: {
    id: 42,
    payload: { environmentId: 'env-1' },
    harness: 'opencode-server',
    status: RunStatus.Running,
    taskPhase: 'running',
    sandboxServerUrl: 'http://sandbox.test',
  },
  artifacts: [],
  prompt: null,
  draftPrompt: null,
  token: 'token',
  refreshConnection: vi.fn(),
  sessionState: 'interactive',
  isSessionLoading: false,
  hasTransportError: false,
};

describe('NestedTaskSidePanel', () => {
  beforeEach(() => {
    useTaskMessageEnvelopesMock.mockReturnValue({
      data: [],
      isPending: false,
      isSuccess: true,
      isError: false,
    });
    useTaskSessionMock.mockReturnValue(baseSession);
  });

  it('renders the focused live transcript and full-task navigation without task chrome', () => {
    render(<NestedTaskSidePanel taskId="child-1" onClose={vi.fn()} />);

    expect(screen.getByText('Task:')).toHaveClass('font-semibold');
    expect(screen.getByText('Fix checkout')).toBeInTheDocument();
    expect(screen.getByText('Workspace env-1')).toBeInTheDocument();
    expect(screen.getByTestId('live-provider')).toBeInTheDocument();
    expect(screen.getByText('Child transcript')).toBeInTheDocument();
    expect(screen.getByTestId('pending-input-provider')).toHaveAttribute(
      'data-task-id',
      'child-1',
    );
    expect(screen.getByTestId('task-input-stack')).toHaveAttribute(
      'data-task-id',
      'child-1',
    );
    expect(
      screen.getByPlaceholderText('Message task, / for commands'),
    ).toBeInTheDocument();
    expect(screen.getByText('Task connection status')).toBeInTheDocument();
    expect(screen.getByTestId('live-provider')).toHaveAttribute(
      'data-task-id',
      'child-1',
    );
    expect(
      screen.getByTestId('live-provider').closest('[data-session-task-panel]'),
    ).toHaveAttribute('data-session-task-panel', 'child-1');
    expect(screen.getByText('Queued task messages')).toBeInTheDocument();
    expect(screen.getByText('Pending task requests')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to task' })).toHaveAttribute(
      'href',
      '/task/child-1',
    );
    expect(screen.queryByText('Task actions')).not.toBeInTheDocument();
    expect(useTaskSessionMock).toHaveBeenCalledWith('child-1', {
      refetchInterval: 2_000,
    });
    expect(useSleepInvalidationMock).toHaveBeenCalledWith(baseSession.taskRun);
  });

  it('switches among tasks from the title dropdown', async () => {
    const onSelectTask = vi.fn();
    render(
      <NestedTaskSidePanel
        taskId="child-1"
        tasks={[
          { taskId: 'child-1', title: 'Fix checkout' },
          { taskId: 'child-2', title: 'Review checkout' },
        ]}
        onSelectTask={onSelectTask}
        onClose={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', {
      name: /Task:.*Fix checkout/,
    });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(
      await screen.findByText('Tasks in this session'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText('Review checkout'));

    expect(onSelectTask).toHaveBeenCalledWith('child-2');
  });

  it('keeps task file and command controls available in the nested composer', () => {
    render(<NestedTaskSidePanel taskId="child-1" onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Search task files' }));
    expect(screen.getByText('Task file search')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Search task commands' }),
    );
    expect(screen.getByText('Task command search')).toBeInTheDocument();
  });

  it.each([
    RunStatus.Pending,
    RunStatus.Dequeued,
    RunStatus.Processing,
    RunStatus.Preparing,
    RunStatus.Spawning,
    RunStatus.Connecting,
    RunStatus.Running,
  ])(
    'shows shared startup progress for a %s nested task before its transcript starts',
    (status) => {
      useTaskSessionMock.mockReturnValue({
        ...baseSession,
        taskRun: {
          ...baseSession.taskRun,
          status,
          taskPhase:
            status === RunStatus.Running
              ? 'running'
              : 'waiting_for_sandbox_provider',
        },
        prompt: null,
        sessionState: 'booting',
      });

      render(<NestedTaskSidePanel taskId="child-1" onClose={vi.fn()} />);

      expect(screen.getByTestId('startup-progress')).toHaveTextContent(
        `42:${status}`,
      );
      expect(screen.queryByText('Child transcript')).not.toBeInTheDocument();
      expect(screen.queryByTestId('live-provider')).not.toBeInTheDocument();
    },
  );

  it('keeps startup progress inline once the child transcript begins, then removes it when initialization finishes', () => {
    const bootingSession = {
      ...baseSession,
      taskRun: {
        ...baseSession.taskRun,
        status: RunStatus.Connecting,
        taskPhase: null,
      },
      prompt: {
        id: 'prompt-1',
        visibleInTranscript: true,
      },
      sessionState: 'booting',
    };
    useTaskSessionMock.mockReturnValue(bootingSession);

    const { rerender } = render(
      <NestedTaskSidePanel taskId="child-1" onClose={vi.fn()} />,
    );

    expect(screen.getByText('Child transcript')).toBeInTheDocument();
    expect(screen.getByTestId('startup-progress')).toHaveTextContent(
      `42:${RunStatus.Connecting}`,
    );

    useTaskSessionMock.mockReturnValue({
      ...bootingSession,
      taskRun: {
        ...bootingSession.taskRun,
        status: RunStatus.Running,
        taskPhase: 'running',
      },
      sessionState: 'interactive',
    });
    rerender(<NestedTaskSidePanel taskId="child-1" onClose={vi.fn()} />);

    expect(screen.getByText('Child transcript')).toBeInTheDocument();
    expect(screen.queryByTestId('startup-progress')).not.toBeInTheDocument();
    expect(screen.getByTestId('live-provider')).toBeInTheDocument();
    expect(screen.getByText('Task composer')).toBeInTheDocument();
  });

  it('keeps historical and terminal tasks read-only', () => {
    useTaskSessionMock.mockReturnValue({
      ...baseSession,
      taskRun: {
        ...baseSession.taskRun,
        status: RunStatus.Completed,
        taskPhase: 'completed',
      },
      sessionState: 'historical',
    });

    render(<NestedTaskSidePanel taskId="child-1" onClose={vi.fn()} />);

    expect(screen.getByTestId('historical-provider')).toBeInTheDocument();
    expect(screen.queryByTestId('task-input-stack')).not.toBeInTheDocument();
    expect(screen.queryByText(/Wake task input/)).not.toBeInTheDocument();
  });

  it('shows startup failure details without a composer when task boot fails', () => {
    useTaskSessionMock.mockReturnValue({
      ...baseSession,
      taskRun: {
        ...baseSession.taskRun,
        status: RunStatus.Failed,
        taskPhase: 'failed',
      },
      sessionState: 'boot-failed',
    });

    render(<NestedTaskSidePanel taskId="child-1" onClose={vi.fn()} />);

    expect(screen.getByTestId('startup-progress')).toHaveTextContent(
      `42:${RunStatus.Failed}`,
    );
    expect(screen.queryByTestId('task-input-stack')).not.toBeInTheDocument();
    expect(screen.queryByTestId('historical-provider')).not.toBeInTheDocument();
  });

  it('uses the dedicated wake input for a sleeping task snapshot', () => {
    useTaskSessionMock.mockReturnValue({
      ...baseSession,
      draftPrompt: 'Continue from the checkpoint',
      taskRun: {
        ...baseSession.taskRun,
        status: RunStatus.Completed,
        taskPhase: 'completed',
        snapshotId: 'snapshot-1',
      },
      sessionState: 'historical',
    });

    render(<NestedTaskSidePanel taskId="child-1" onClose={vi.fn()} />);

    expect(
      screen.getByText('Wake task input: Continue from the checkpoint'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('task-input-stack')).not.toBeInTheDocument();
  });

  it('shows the saved draft without a live composer while a task resumes', () => {
    useTaskSessionMock.mockReturnValue({
      ...baseSession,
      draftPrompt: 'Follow the updated direction',
      sessionState: 'resuming',
    });

    render(<NestedTaskSidePanel taskId="child-1" onClose={vi.fn()} />);

    expect(
      screen.getByText('Resuming task draft: Follow the updated direction'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('task-input-stack')).not.toBeInTheDocument();
  });

  it('switches the live interaction providers and composer to the selected task', () => {
    const { rerender } = render(
      <NestedTaskSidePanel taskId="child-1" onClose={vi.fn()} />,
    );

    useTaskSessionMock.mockReturnValue({
      ...baseSession,
      taskId: 'child-2',
      task: { title: 'Review checkout' },
      taskRun: { ...baseSession.taskRun, taskId: 'child-2', id: 84 },
    });
    rerender(<NestedTaskSidePanel taskId="child-2" onClose={vi.fn()} />);

    expect(screen.getByTestId('live-provider')).toHaveAttribute(
      'data-task-id',
      'child-2',
    );
    expect(screen.getByTestId('pending-input-provider')).toHaveAttribute(
      'data-task-id',
      'child-2',
    );
    expect(screen.getByTestId('task-input-stack')).toHaveAttribute(
      'data-task-id',
      'child-2',
    );
    expect(screen.getByRole('link', { name: /Go to task/ })).toHaveAttribute(
      'href',
      '/task/child-2',
    );
  });

  it('routes transcript artifact clicks through the session panel callback', () => {
    const onOpenArtifact = vi.fn();
    render(
      <NestedTaskSidePanel
        taskId="child-1"
        onClose={vi.fn()}
        onOpenArtifact={onOpenArtifact}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Open nested artifact' }),
    );

    expect(onOpenArtifact).toHaveBeenCalledWith('proof/result.png', 2);
  });
});
