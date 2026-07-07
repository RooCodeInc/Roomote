import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

const { useTaskSidePanelMock, useSandboxLayoutMock } = vi.hoisted(() => ({
  useTaskSidePanelMock: vi.fn(),
  useSandboxLayoutMock: vi.fn(),
}));

vi.mock('../hooks', () => ({
  useTaskSidePanel: useTaskSidePanelMock,
}));

vi.mock('../../../use-sandbox-layout', () => ({
  useSandboxLayout: useSandboxLayoutMock,
}));

vi.mock('./LivePreviewButton', () => ({
  LivePreviewButton: ({ disabled }: { disabled?: boolean }) => (
    <button type="button" data-testid="live-preview" disabled={disabled} />
  ),
}));

vi.mock('./DiffButton', () => ({
  DiffButton: ({ disabled }: { disabled?: boolean }) => (
    <button type="button" data-testid="diff" disabled={disabled} />
  ),
}));

vi.mock('./ArtifactsButton', () => ({
  ArtifactsButton: ({ disabled }: { disabled?: boolean }) => (
    <button type="button" data-testid="artifacts" disabled={disabled} />
  ),
}));

vi.mock('./TaskInfoButton', () => ({
  TaskInfoButton: ({ disabled }: { disabled?: boolean }) => (
    <button type="button" data-testid="task-info" disabled={disabled} />
  ),
}));

vi.mock('./OverflowMenu', () => ({
  OverflowMenu: ({ disabled }: { disabled?: boolean }) => (
    <button type="button" data-testid="overflow" disabled={disabled} />
  ),
}));

vi.mock('./TerminalButton', () => ({
  TerminalButton: () => <button type="button" data-testid="terminal" />,
}));

vi.mock('./LogsButton', () => ({
  LogsButton: () => <button type="button" data-testid="logs" />,
}));

vi.mock('@/components/layout/side-nav/SideNavItem', () => ({
  SideNavItem: ({
    children,
    disabled,
  }: {
    children: ReactNode;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled}>
      {children}
    </button>
  ),
}));

import { SidebarActions } from './SidebarActions';

const baseSession = {
  artifacts: [],
  cloudJob: {
    id: 1,
    status: 'running',
  },
  sessionState: 'interactive',
  taskId: 'task-123',
};

describe('SidebarActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    useSandboxLayoutMock.mockReturnValue({
      isSidebarVisible: true,
      toggleSidebar: vi.fn(),
    });

    useTaskSidePanelMock.mockReturnValue({
      activeView: null,
      closeSidePanel: vi.fn(),
    });
  });

  it('disables sandbox-dependent right rail actions while booting', () => {
    render(
      <SidebarActions
        session={
          {
            ...baseSession,
            sessionState: 'booting',
          } as never
        }
        onToggleDiff={() => {}}
      />,
    );

    expect(screen.getByTestId('live-preview')).toBeDisabled();
    expect(screen.getByTestId('diff')).toBeDisabled();
    expect(screen.getByTestId('artifacts')).toBeDisabled();
    expect(screen.getByTestId('task-info')).toBeDisabled();
    expect(screen.getByTestId('overflow')).toBeDisabled();
    expect(screen.queryByTestId('terminal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('logs')).not.toBeInTheDocument();
  });

  it('keeps right rail actions enabled once the session is interactive', () => {
    render(
      <SidebarActions session={baseSession as never} onToggleDiff={() => {}} />,
    );

    expect(screen.getByTestId('live-preview')).toBeEnabled();
    expect(screen.getByTestId('diff')).toBeEnabled();
    expect(screen.getByTestId('artifacts')).toBeEnabled();
    expect(screen.getByTestId('task-info')).toBeEnabled();
    expect(screen.getByTestId('overflow')).toBeEnabled();
    expect(screen.getByTestId('terminal')).toBeInTheDocument();
    expect(screen.getByTestId('logs')).toBeInTheDocument();
  });
});
