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
  beforeEach(() => {
    useMediaQueryMock.mockReturnValue(false);
  });

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

  it('adds every supplied side panel on wide layouts', () => {
    useMediaQueryMock.mockReturnValue(true);

    const { getByText, getAllByTestId } = render(
      <ResponsiveWorkspacePanels
        isPanelOpen
        main={<div>Main</div>}
        panel={<div>Primary panel</div>}
        panelId="primary"
        additionalPanels={[
          { id: 'secondary', content: <div>Secondary panel</div> },
          { id: 'tertiary', content: <div>Tertiary panel</div> },
        ]}
      />,
    );

    expect(getByText('Main')).toBeTruthy();
    expect(getByText('Primary panel')).toBeTruthy();
    expect(getByText('Secondary panel')).toBeTruthy();
    expect(getByText('Tertiary panel')).toBeTruthy();
    expect(getAllByTestId('divider')).toHaveLength(3);
  });
});
