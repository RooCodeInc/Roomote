import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { RunStatus } from '@roomote/types';

const useTaskSessionMock = vi.fn();
const useTaskMessageEnvelopesMock = vi.fn();

vi.mock('../../task/[taskId]/hooks/use-task-session', () => ({
  useTaskSession: (...args: unknown[]) => useTaskSessionMock(...args),
}));

vi.mock('../../task/[taskId]/hooks/use-task-message-envelopes', () => ({
  useTaskMessageEnvelopes: (...args: unknown[]) =>
    useTaskMessageEnvelopesMock(...args),
}));

vi.mock('../../task/[taskId]/hooks/ArtifactLinkProvider', () => ({
  ArtifactLinkProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../../task/[taskId]/hooks/HistoricalSandboxProvider', () => ({
  HistoricalSandboxProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="historical-provider">{children}</div>
  ),
}));

vi.mock('../../task/[taskId]/hooks/SandboxProvider', () => ({
  SandboxProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="live-provider">{children}</div>
  ),
}));

vi.mock('../../task/[taskId]/Messages', () => ({
  Messages: ({ footer }: { footer?: ReactNode }) => (
    <div>
      Child transcript
      {footer}
    </div>
  ),
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
  }: {
    title: string;
    actions: ReactNode;
  }) => (
    <header>
      {title}
      {actions}
    </header>
  ),
}));

import { NestedTaskSidePanel } from './NestedTaskSidePanel';

const baseSession = {
  taskId: 'child-1',
  task: { title: 'Fix checkout' },
  taskRun: {
    id: 42,
    harness: 'opencode-server',
    status: RunStatus.Running,
    taskPhase: 'running',
    sandboxServerUrl: 'http://sandbox.test',
  },
  artifacts: [],
  prompt: null,
  token: 'token',
  refreshConnection: vi.fn(),
  sessionState: 'interactive',
  isSessionLoading: false,
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

    expect(screen.getByText('Fix checkout')).toBeInTheDocument();
    expect(screen.getByTestId('live-provider')).toBeInTheDocument();
    expect(screen.getByText('Child transcript')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Go to task/ })).toHaveAttribute(
      'href',
      '/task/child-1',
    );
    expect(screen.queryByText('Task actions')).not.toBeInTheDocument();
    expect(useTaskSessionMock).toHaveBeenCalledWith('child-1', {
      refetchInterval: 2_000,
    });
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
  });
});
