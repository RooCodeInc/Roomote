import { fireEvent, render, screen } from '@testing-library/react';

import { SandboxLayoutContext } from '../../use-sandbox-layout';
import { SessionWorkspace, type SessionInfo } from './SessionWorkspace';

const { useMediaQueryMock } = vi.hoisted(() => ({
  useMediaQueryMock: vi.fn(),
}));

vi.mock('usehooks-ts', () => ({
  useMediaQuery: useMediaQueryMock,
}));

vi.mock('@/hooks/task-models/useLaunchTaskModels', () => ({
  useLaunchTaskModels: () => ({
    data: { models: [{ id: 'model-1', displayName: 'Model One' }] },
  }),
}));

const session: SessionInfo = {
  id: 'session-1',
  ownerName: 'Test User',
  ownerEmail: 'test@example.com',
  ownerImageUrl: null,
  surface: 'slack',
  model: 'model-1',
  inferenceCostMicroUsd: 1_000_000,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

function renderWorkspace({
  isMobile,
  toggleSidebar = vi.fn(),
}: {
  isMobile: boolean;
  toggleSidebar?: () => void;
}) {
  useMediaQueryMock.mockReturnValue(!isMobile);

  render(
    <SandboxLayoutContext.Provider
      value={{
        isSidebarVisible: true,
        setSidebarVisible: vi.fn(),
        toggleSidebar,
      }}
    >
      <SessionWorkspace session={session}>
        <div>Session transcript</div>
      </SessionWorkspace>
    </SandboxLayoutContext.Provider>,
  );

  return { toggleSidebar };
}

describe('SessionWorkspace', () => {
  it('matches the task sidebar replacement behavior and controls on mobile', () => {
    const { toggleSidebar } = renderWorkspace({ isMobile: true });

    expect(screen.getByText('Session transcript')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chat' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Session info' }));

    expect(screen.queryByText('Session transcript')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Session info' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Close session info' }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));

    expect(screen.getByText('Session transcript')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    expect(toggleSidebar).toHaveBeenCalledOnce();
  });

  it('preserves the split panel and close control on desktop', () => {
    renderWorkspace({ isMobile: false });

    fireEvent.click(screen.getByRole('button', { name: 'Session info' }));

    expect(screen.getByText('Session transcript')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Close session info' }),
    ).toBeInTheDocument();
  });
});
