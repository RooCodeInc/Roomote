import { useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

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

function SandboxLayoutProvider({ children }: { children: ReactNode }) {
  const [isSidebarVisible, setSidebarVisible] = useState(true);

  return (
    <SandboxLayoutContext.Provider
      value={{
        isSidebarVisible,
        setSidebarVisible,
        toggleSidebar: () => setSidebarVisible((visible) => !visible),
      }}
    >
      {children}
    </SandboxLayoutContext.Provider>
  );
}

function renderWorkspace({ isMobile }: { isMobile: boolean }) {
  useMediaQueryMock.mockReturnValue(!isMobile);
  let viewportChangeListener: ((event: MediaQueryListEvent) => void) | null =
    null;
  const mediaQuery = {
    matches: isMobile,
    addEventListener: vi.fn(
      (event: string, listener: (event: MediaQueryListEvent) => void) => {
        if (event === 'change') {
          viewportChangeListener = listener;
        }
      },
    ),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockReturnValue(mediaQuery),
  });

  const result = render(
    <SandboxLayoutProvider>
      <SessionWorkspace session={session}>
        <div>Session transcript</div>
      </SessionWorkspace>
    </SandboxLayoutProvider>,
  );

  return {
    ...result,
    resizeToMobile() {
      mediaQuery.matches = true;
      act(() =>
        viewportChangeListener?.({ matches: true } as MediaQueryListEvent),
      );
    },
  };
}

describe('SessionWorkspace', () => {
  it('matches the task sidebar replacement behavior and controls on mobile', () => {
    renderWorkspace({ isMobile: true });

    expect(screen.getByText('Session transcript')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chat' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Session info' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));

    expect(screen.getByRole('button', { name: 'Chat' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Session info' }));

    expect(screen.queryByText('Session transcript')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Session info' }),
    ).toBeInTheDocument();
    const table = screen.getByRole('table');
    const panel = table.parentElement!.parentElement!;

    expect(panel).toHaveClass(
      'flex',
      'min-h-0',
      'min-w-0',
      'flex-1',
      'flex-col',
    );
    expect(panel.parentElement).toHaveClass(
      'flex',
      'min-h-0',
      'min-w-0',
      'flex-1',
      'flex-col',
    );
    expect(
      screen.queryByRole('button', { name: 'Close session info' }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));

    expect(
      screen.getByRole('button', { name: 'Close session info' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close session info' }));

    expect(screen.getByText('Session transcript')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Session info' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Session info' }));

    expect(
      screen.getByRole('heading', { name: 'Session info' }),
    ).toBeInTheDocument();
  });

  it('preserves the split panel and close control on desktop', () => {
    renderWorkspace({ isMobile: false });

    expect(screen.getByRole('button', { name: 'Session info' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Session info' }));

    expect(screen.getByText('Session transcript')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Close session info' }),
    ).toBeInTheDocument();
  });

  it('collapses the right rail when the viewport changes from desktop to mobile', () => {
    const { resizeToMobile } = renderWorkspace({ isMobile: false });

    expect(screen.getByRole('button', { name: 'Session info' })).toBeVisible();

    resizeToMobile();

    expect(screen.queryByRole('button', { name: 'Session info' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
  });
});
