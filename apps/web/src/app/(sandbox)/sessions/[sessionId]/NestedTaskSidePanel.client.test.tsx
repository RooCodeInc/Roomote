import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { RunStatus } from '@roomote/types';

const useTaskSessionMock = vi.fn();

vi.mock('../../task/[taskId]/hooks/use-task-session', () => ({
  useTaskSession: (...args: unknown[]) => useTaskSessionMock(...args),
}));

vi.mock('../../task/[taskId]/hooks/use-task-message-envelopes', () => ({
  useTaskMessageEnvelopes: () => ({
    data: [],
    isPending: false,
    isSuccess: true,
    isError: false,
  }),
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
  Messages: () => <div>Child transcript</div>,
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

describe('NestedTaskSidePanel', () => {
  beforeEach(() => {
    useTaskSessionMock.mockReturnValue({
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
    });
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
});
