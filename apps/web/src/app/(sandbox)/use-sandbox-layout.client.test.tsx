import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';

import {
  SandboxLayoutContext,
  useResponsiveSandboxSidebar,
} from './use-sandbox-layout';

const setSidebarVisible = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SandboxLayoutContext.Provider
      value={{
        isSidebarVisible: true,
        setSidebarVisible,
        toggleSidebar: vi.fn(),
      }}
    >
      {children}
    </SandboxLayoutContext.Provider>
  );
}

function mockViewport(isMobile: boolean) {
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

  return {
    mediaQuery,
    resize(isMobile: boolean) {
      mediaQuery.matches = isMobile;
      act(() =>
        viewportChangeListener?.({ matches: isMobile } as MediaQueryListEvent),
      );
    },
  };
}

describe('useResponsiveSandboxSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tracks the viewport from an initial desktop state and restores the rail on cleanup', () => {
    const viewport = mockViewport(false);
    const { unmount } = renderHook(
      () => useResponsiveSandboxSidebar('workspace-1'),
      { wrapper },
    );

    expect(setSidebarVisible).toHaveBeenLastCalledWith(true);

    viewport.resize(true);
    expect(setSidebarVisible).toHaveBeenLastCalledWith(false);

    viewport.resize(false);
    expect(setSidebarVisible).toHaveBeenLastCalledWith(true);

    unmount();
    expect(viewport.mediaQuery.removeEventListener).toHaveBeenCalledWith(
      'change',
      expect.any(Function),
    );
    expect(setSidebarVisible).toHaveBeenLastCalledWith(true);
  });

  it('starts with the rail collapsed on mobile', () => {
    mockViewport(true);

    renderHook(() => useResponsiveSandboxSidebar('workspace-1'), { wrapper });

    expect(setSidebarVisible).toHaveBeenLastCalledWith(false);
  });

  it('reinitializes the responsive lifecycle when the workspace changes', () => {
    const viewport = mockViewport(true);
    const { rerender } = renderHook(
      ({ scopeKey }) => useResponsiveSandboxSidebar(scopeKey),
      {
        initialProps: { scopeKey: 'workspace-1' },
        wrapper,
      },
    );

    rerender({ scopeKey: 'workspace-2' });

    expect(viewport.mediaQuery.removeEventListener).toHaveBeenCalledTimes(1);
    expect(viewport.mediaQuery.addEventListener).toHaveBeenCalledTimes(2);
    expect(setSidebarVisible).toHaveBeenLastCalledWith(false);
  });
});
