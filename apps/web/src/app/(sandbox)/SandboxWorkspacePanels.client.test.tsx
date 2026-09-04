import { StrictMode } from 'react';
import { render } from '@testing-library/react';

const useMediaQueryMock = vi.hoisted(() => vi.fn(() => false));

vi.mock('usehooks-ts', () => ({
  useMediaQuery: useMediaQueryMock,
}));

vi.mock('@/components/system', async () => {
  const resizable = await import('@/components/system/primitives/resizable');

  return {
    ArrowRightToLine: () => null,
    MessagesSquare: () => null,
    ...resizable,
  };
});

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

    const { getByText, getAllByRole } = render(
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
    expect(getAllByRole('separator')).toHaveLength(3);
  });

  it('resets the resizable layout when the visible panel set changes', () => {
    useMediaQueryMock.mockReturnValue(true);

    const { container, getByText, queryByText, rerender } = render(
      <StrictMode>
        <ResponsiveWorkspacePanels
          isPanelOpen
          main={<div>Main</div>}
          panel={<div>Primary panel</div>}
          panelId="primary"
          mainMinSize={10}
          panelMinSize={10}
          additionalPanels={[
            { id: 'secondary', content: <div>Secondary panel</div> },
            { id: 'tertiary', content: <div>Tertiary panel</div> },
            { id: 'quaternary', content: <div>Quaternary panel</div> },
          ]}
        />
      </StrictMode>,
    );
    const initialPanelGroup = container.querySelector(
      '[data-slot="resizable-panel-group"]',
    );

    rerender(
      <StrictMode>
        <ResponsiveWorkspacePanels
          isPanelOpen
          main={<div>Main</div>}
          panel={<div>Utility panel</div>}
          panelId="utility"
          mainMinSize={10}
          panelMinSize={25}
          additionalPanels={[
            { id: 'secondary', content: <div>Secondary panel</div> },
            { id: 'tertiary', content: <div>Tertiary panel</div> },
          ]}
        />
      </StrictMode>,
    );

    expect(
      container.querySelector('[data-slot="resizable-panel-group"]'),
    ).not.toBe(initialPanelGroup);
    expect(getByText('Utility panel')).toBeTruthy();
    expect(queryByText('Primary panel')).toBeNull();
    expect(queryByText('Quaternary panel')).toBeNull();
  });
});
