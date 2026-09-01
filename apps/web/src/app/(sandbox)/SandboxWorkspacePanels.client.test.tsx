import { render } from '@testing-library/react';

const useMediaQueryMock = vi.hoisted(() => vi.fn(() => false));

vi.mock('usehooks-ts', () => ({
  useMediaQuery: useMediaQueryMock,
}));

vi.mock('@/components/system', () => ({
  ArrowRightToLine: () => null,
  MessagesSquare: () => null,
  ResizableDivider: () => <div data-testid="divider" />,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@/components/layout/side-nav/SideNavItem', () => ({
  SideNavItem: () => null,
}));

vi.mock('./use-sandbox-layout', () => ({
  useSandboxLayout: () => ({
    isSidebarVisible: true,
    toggleSidebar: vi.fn(),
  }),
}));

import { ResponsiveWorkspacePanels } from './SandboxWorkspacePanels';

describe('ResponsiveWorkspacePanels', () => {
  it('uses an SSR-stable initial media query value', () => {
    const { getByText, queryByText } = render(
      <ResponsiveWorkspacePanels
        isPanelOpen
        main={<div>Main</div>}
        panel={<div>Panel</div>}
      />,
    );

    expect(useMediaQueryMock).toHaveBeenCalledWith('(min-width: 768px)', {
      initializeWithValue: false,
    });
    expect(getByText('Panel')).toBeTruthy();
    expect(queryByText('Main')).toBeNull();
  });
});
