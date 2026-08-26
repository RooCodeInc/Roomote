import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@/components/layout', () => ({
  WorkspaceSurface: ({
    children,
    sideActions,
  }: {
    children: ReactNode;
    sideActions: ReactNode;
  }) => (
    <div>
      {sideActions}
      {children}
    </div>
  ),
}));

vi.mock('@/components/layout/side-nav/SideNavItem', () => ({
  SideNavItem: ({ onClick }: { onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      Session info
    </button>
  ),
}));

vi.mock('@/components/system', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/system')>();

  return {
    ...actual,
    Avatar: () => null,
    BasicTooltip: ({ children }: { children: ReactNode }) => children,
    ResizableDivider: () => <div />,
    ResizablePanel: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

vi.mock('../../task/[taskId]/sidebar-panels/SidePanelHeader', () => ({
  SidePanelHeader: ({ title }: { title: string }) => <header>{title}</header>,
}));

vi.mock('./NestedTaskSidePanel', () => ({
  NestedTaskSidePanel: ({ taskId }: { taskId: string }) => (
    <div>Nested panel {taskId}</div>
  ),
}));

vi.mock('@/hooks/task-models/useLaunchTaskModels', () => ({
  useLaunchTaskModels: () => ({ data: { models: [] } }),
}));

import { SessionWorkspace, type SessionInfo } from './SessionWorkspace';
import { useOpenSessionTaskPanel } from './session-task-panel-context';

const session: SessionInfo = {
  id: 'session-1',
  ownerName: 'User',
  ownerEmail: 'user@example.com',
  ownerImageUrl: null,
  surface: 'web',
  model: null,
  inferenceCostMicroUsd: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

function OpenNestedTask() {
  const openTaskPanel = useOpenSessionTaskPanel();
  return (
    <button type="button" onClick={() => openTaskPanel?.('child-1')}>
      Open child
    </button>
  );
}

describe('SessionWorkspace', () => {
  it('opens delegated tasks in the existing session side-panel slot', () => {
    render(
      <SessionWorkspace session={session}>
        <OpenNestedTask />
      </SessionWorkspace>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open child' }));

    expect(screen.getByText('Nested panel child-1')).toBeInTheDocument();
  });
});
