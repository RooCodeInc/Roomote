import { StrictMode, useEffect } from 'react';
import { act, fireEvent, render } from '@testing-library/react';

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
    const { getByText } = render(
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
    expect(
      getByText('Main').closest('[data-slot=resizable-panel]'),
    ).toHaveClass('max-md:hidden');
  });

  it.each([
    ['mobile', false, true],
    ['desktop', true, false],
  ])(
    'preserves the main panel when resizing from %s across the breakpoint',
    (_layout, initialMatch, nextMatch) => {
      useMediaQueryMock.mockReturnValue(initialMatch);
      const unmounted = vi.fn();

      function StatefulMain() {
        useEffect(() => () => unmounted(), []);
        return <textarea aria-label="Main conversation" defaultValue="draft" />;
      }

      const view = render(
        <ResponsiveWorkspacePanels
          isPanelOpen
          main={<StatefulMain />}
          panel={<div>Panel</div>}
        />,
      );
      const main = view.getByLabelText('Main conversation');

      useMediaQueryMock.mockReturnValue(nextMatch);
      view.rerender(
        <ResponsiveWorkspacePanels
          isPanelOpen
          main={<StatefulMain />}
          panel={<div>Panel</div>}
        />,
      );

      expect(view.getByLabelText('Main conversation')).toBe(main);
      expect(unmounted).not.toHaveBeenCalled();
    },
  );

  it('adds every supplied side panel on wide layouts', () => {
    useMediaQueryMock.mockReturnValue(true);

    const { getByText, getAllByRole } = render(
      <ResponsiveWorkspacePanels
        isPanelOpen
        main={<div>Main</div>}
        panel={<div>Primary panel</div>}
        panelId="primary"
        mainMinSize={10}
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

  it('marks only selected conversation panels for focus dimming', () => {
    useMediaQueryMock.mockReturnValue(true);

    const { getByText } = render(
      <ResponsiveWorkspacePanels
        isPanelOpen
        main={<div>Main conversation</div>}
        panel={<div>Task conversation</div>}
        panelId="task"
        mainMinSize={10}
        dimUnfocusedPanelIds={['main', 'task']}
        additionalPanels={[
          { id: 'logs', content: <div>Logs</div> },
          { id: 'artifacts', content: <div>Artifacts</div> },
        ]}
      />,
    );

    expect(
      getByText('Main conversation').closest('[data-slot=resizable-panel]'),
    ).toHaveAttribute('data-dim-when-unfocused', 'true');
    expect(
      getByText('Task conversation').closest('[data-slot=resizable-panel]'),
    ).toHaveAttribute('data-dim-when-unfocused', 'true');
    expect(
      getByText('Logs').closest('[data-slot=resizable-panel]'),
    ).not.toHaveAttribute('data-dim-when-unfocused');
    expect(
      getByText('Artifacts').closest('[data-slot=resizable-panel]'),
    ).not.toHaveAttribute('data-dim-when-unfocused');
  });

  it('keeps Task utility panels outside focus dimming', () => {
    useMediaQueryMock.mockReturnValue(true);

    const { getByText } = render(
      <ResponsiveWorkspacePanels
        isPanelOpen
        main={<div>Task transcript</div>}
        panel={<div>Task utility panel</div>}
      />,
    );

    expect(
      getByText('Task transcript').closest('[data-slot=resizable-panel]'),
    ).not.toHaveAttribute('data-dim-when-unfocused');
    expect(
      getByText('Task utility panel').closest('[data-slot=resizable-panel]'),
    ).not.toHaveAttribute('data-dim-when-unfocused');
  });

  it('preserves the resizable group when the visible panel set changes', () => {
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

    expect(container.querySelector('[data-slot="resizable-panel-group"]')).toBe(
      initialPanelGroup,
    );
    expect(getByText('Utility panel')).toBeTruthy();
    expect(queryByText('Primary panel')).toBeNull();
    expect(queryByText('Quaternary panel')).toBeNull();
  });

  describe('desktop presence animation', () => {
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));

    beforeEach(() => {
      vi.useFakeTimers();
      useMediaQueryMock.mockReturnValue(true);
      Object.defineProperty(HTMLElement.prototype, 'animate', {
        configurable: true,
        value: animate,
      });
    });

    afterEach(() => {
      vi.useRealTimers();
      Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    });

    function workspace(open: boolean, extra = false, layoutWidth = 1280) {
      return (
        <StrictMode>
          <ResponsiveWorkspacePanels
            isPanelOpen={open}
            layoutWidth={layoutWidth}
            main={<textarea aria-label="Prompt" />}
            panel={<input aria-label="Side input" />}
            additionalPanels={
              extra
                ? [{ id: 'extra', content: <input aria-label="Extra input" /> }]
                : []
            }
          />
        </StrictMode>
      );
    }

    it('animates opening and closing, retains exits, and preserves main focus', () => {
      const view = render(workspace(false));
      const prompt = view.getByRole('textbox');
      prompt.focus();
      expect(animate).not.toHaveBeenCalled();
      view.rerender(workspace(true));
      expect(document.activeElement).toBe(prompt);
      expect(animate).toHaveBeenCalledWith(
        [{ flexGrow: 0 }, { flexGrow: 50 }],
        { duration: 240, easing: 'cubic-bezier(0.22,1,0.36,1.04)' },
      );
      act(() => vi.advanceTimersByTime(240));
      view.rerender(workspace(false));
      expect(
        view.getByLabelText('Side input').closest('[data-panel]'),
      ).toHaveAttribute('inert');
      expect(animate).toHaveBeenLastCalledWith(
        [{ flexGrow: 50 }, { flexGrow: 0 }],
        { duration: 240, easing: 'cubic-bezier(0.22,1,0.36,1.04)' },
      );
      act(() => vi.advanceTimersByTime(239));
      expect(view.queryByLabelText('Side input')).not.toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(view.queryByLabelText('Side input')).toBeNull();
      expect(document.activeElement).toBe(prompt);
    });

    it('cancels interrupted exits when reopened and cleans up on unmount', () => {
      const view = render(workspace(true));
      const input = view.getByLabelText('Side input');
      view.rerender(workspace(false));
      act(() => vi.advanceTimersByTime(120));
      view.rerender(workspace(true));
      expect(view.getByLabelText('Side input')).toBe(input);
      expect(input.closest('[data-panel]')).not.toHaveAttribute('inert');
      act(() => vi.advanceTimersByTime(120));
      expect(view.queryByLabelText('Side input')).not.toBeNull();
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
      expect(cancel).toHaveBeenCalled();
    });

    it.each(['pointer', 'keyboard', 'viewport'])(
      'stops animation for immediate %s resizing',
      (kind) => {
        const view = render(workspace(false));
        view.rerender(workspace(true));
        const separator = view.getByRole('separator');
        if (kind === 'pointer') fireEvent.pointerDown(separator);
        else if (kind === 'keyboard')
          fireEvent.keyDown(separator, { key: 'ArrowLeft' });
        else fireEvent(window, new Event('resize'));
        expect(cancel).toHaveBeenCalledTimes(2);
        if (kind === 'viewport') {
          const calls = animate.mock.calls.length;
          act(() => vi.advanceTimersByTime(32));
          view.rerender(workspace(true, true, 1600));
          expect(animate).toHaveBeenCalledTimes(calls);
        }
        expect(vi.getTimerCount()).toBe(0);
        const calls = animate.mock.calls.length;
        const before = separator.getAttribute('aria-valuenow');
        fireEvent.keyDown(separator, { key: 'ArrowRight' });
        expect(animate).toHaveBeenCalledTimes(calls);
        expect(separator.getAttribute('aria-valuenow')).not.toBe(before);
      },
    );

    it('skips initial capacity measurement and non-window capacity changes', () => {
      const view = render(workspace(true, false, 0));
      view.rerender(workspace(true, true, 1600));
      expect(animate).not.toHaveBeenCalled();
      view.rerender(workspace(true, false, 1280));
      expect(animate).not.toHaveBeenCalled();
      expect(view.queryByLabelText('Extra input')).toBeNull();
      view.rerender(workspace(true, true, 1280));
      expect(animate).toHaveBeenCalled();
    });

    it('finishes an in-flight exit when measured width changes without changing capacity', () => {
      const view = render(workspace(true, true));
      view.rerender(workspace(true));
      expect(view.queryByLabelText('Extra input')).not.toBeNull();
      view.rerender(workspace(true, false, 1200));
      expect(view.queryByLabelText('Extra input')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not interrupt exits for typing or clicks outside resize handles', () => {
      const view = render(workspace(true));
      view.rerender(workspace(false));
      const prompt = view.getByLabelText('Prompt');
      fireEvent.keyDown(prompt, { key: 'a' });
      fireEvent.keyUp(prompt, { key: 'a' });
      fireEvent.pointerDown(prompt);
      fireEvent.pointerUp(prompt);
      expect(cancel).not.toHaveBeenCalled();
      expect(view.queryByLabelText('Side input')).not.toBeNull();
      act(() => vi.advanceTimersByTime(240));
      expect(view.queryByLabelText('Side input')).toBeNull();
    });

    it.each(['pointer', 'keyboard'])(
      'defers exit cleanup during %s resizing without losing resized widths',
      (kind) => {
        const view = render(workspace(true, true));
        view.rerender(workspace(true));
        const separator = view.getAllByRole('separator')[0]!;
        if (kind === 'pointer') fireEvent.pointerDown(separator);
        const before = separator.getAttribute('aria-valuenow');
        fireEvent.keyDown(separator, { key: 'ArrowRight' });
        const resized = separator.getAttribute('aria-valuenow');
        expect(resized).not.toBe(before);
        act(() => vi.advanceTimersByTime(300));
        expect(view.queryByLabelText('Extra input')).not.toBeNull();
        if (kind === 'pointer') fireEvent.pointerUp(window);
        else fireEvent.keyUp(separator, { key: 'ArrowRight' });
        expect(view.queryByLabelText('Extra input')).toBeNull();
        expect(separator.getAttribute('aria-valuenow')).toBe(resized);
      },
    );

    it('resizes with real library pointer events throughout an interrupted exit', () => {
      const view = render(workspace(true, true));
      view.rerender(workspace(true));
      const separator = view.getAllByRole('separator')[0]!;
      const handleRect = vi
        .spyOn(separator, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(500, 0, 1, 500));
      const groupRect = vi
        .spyOn(separator.parentElement!, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 0, 1000, 500));
      const pointer = (type: string, x: number) => {
        const event = new MouseEvent(type, {
          bubbles: true,
          clientX: x,
          clientY: 100,
          buttons: type === 'pointerup' ? 0 : 1,
        });
        Object.defineProperty(event, 'isPrimary', { value: true });
        fireEvent(separator, event);
      };
      pointer('pointerdown', 500);
      pointer('pointermove', 550);
      expect(separator).toHaveAttribute('aria-valuenow', '55');
      act(() => vi.advanceTimersByTime(300));
      expect(view.queryByLabelText('Extra input')).not.toBeNull();
      pointer('pointermove', 600);
      expect(separator).toHaveAttribute('aria-valuenow', '60');
      pointer('pointerup', 600);
      expect(view.queryByLabelText('Extra input')).toBeNull();
      expect(separator).toHaveAttribute('aria-valuenow', '60');
      handleRect.mockRestore();
      groupRect.mockRestore();
    });

    it('starts an interrupted transition at its current rendered widths', () => {
      const view = render(workspace(true));
      view.rerender(workspace(false));
      const mainRect = vi
        .spyOn(
          view.getByLabelText('Prompt').closest('[data-panel]')!,
          'getBoundingClientRect',
        )
        .mockReturnValue(new DOMRect(0, 0, 800, 500));
      const sideRect = vi
        .spyOn(
          view.getByLabelText('Side input').closest('[data-panel]')!,
          'getBoundingClientRect',
        )
        .mockReturnValue(new DOMRect(800, 0, 200, 500));
      view.rerender(workspace(true));
      expect(animate).toHaveBeenLastCalledWith(
        [{ flexGrow: 20 }, { flexGrow: 50 }],
        { duration: 240, easing: 'cubic-bezier(0.22,1,0.36,1.04)' },
      );
      mainRect.mockRestore();
      sideRect.mockRestore();
    });

    it('retains only removed additional panels and preserves surviving input identity', () => {
      const view = render(workspace(true, true));
      const input = view.getByLabelText('Side input');
      input.focus();
      view.rerender(workspace(true));
      expect(view.getByLabelText('Side input')).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(view.queryByLabelText('Extra input')).not.toBeNull();
      act(() => vi.advanceTimersByTime(240));
      expect(view.queryByLabelText('Extra input')).toBeNull();
    });

    it('preserves a focused additional panel when it becomes the primary panel', () => {
      const view = render(
        <ResponsiveWorkspacePanels
          isPanelOpen
          main={<textarea aria-label="Main" />}
          panelId="first"
          panel={<div>First</div>}
          additionalPanels={[
            { id: 'second', content: <input aria-label="Second" /> },
          ]}
        />,
      );
      const input = view.getByLabelText('Second');
      input.focus();
      view.rerender(
        <ResponsiveWorkspacePanels
          isPanelOpen
          main={<textarea aria-label="Main" />}
          panelId="second"
          panel={<input aria-label="Second" />}
        />,
      );
      expect(view.getByLabelText('Second')).toBe(input);
      expect(document.activeElement).toBe(input);
      act(() => vi.advanceTimersByTime(240));
      expect(view.queryByText('First')).toBeNull();
      expect(document.activeElement).toBe(input);
    });

    it('skips reduced motion and breakpoint entry animations', () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn(
        (query) =>
          ({
            matches: true,
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          }) as unknown as MediaQueryList,
      );
      const view = render(workspace(false));
      view.rerender(workspace(true));
      view.rerender(workspace(false));
      expect(animate).not.toHaveBeenCalled();
      window.matchMedia = originalMatchMedia;
      expect(view.queryByLabelText('Side input')).toBeNull();
      useMediaQueryMock.mockReturnValue(false);
      view.rerender(workspace(true));
      expect(
        view.getByLabelText('Prompt').closest('[data-slot=resizable-panel]'),
      ).toHaveClass('max-md:hidden');
      useMediaQueryMock.mockReturnValue(true);
      view.rerender(workspace(true));
      expect(animate).not.toHaveBeenCalled();
    });
  });
});
