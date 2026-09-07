'use client';

import { Component, createRef, Fragment, type ReactNode } from 'react';
import type { ImperativePanelGroupHandle } from 'react-resizable-panels';
import { useMediaQuery } from 'usehooks-ts';

import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';
import {
  ArrowRightToLine,
  MessagesSquare,
  ResizableDivider,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/system';
import { cn } from '@/lib/utils';

import { useSandboxLayout } from './use-sandbox-layout';

interface SandboxSideActionsProps {
  isPanelOpen: boolean;
  onShowMain: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function SandboxSideActions({
  isPanelOpen,
  onShowMain,
  children,
  footer,
}: SandboxSideActionsProps) {
  const { isSidebarVisible, toggleSidebar } = useSandboxLayout();

  if (!isSidebarVisible) {
    return null;
  }

  return (
    <div className="flex h-full shrink-0 flex-col gap-2 overflow-y-auto bg-card py-3 pr-2">
      <SideNavItem
        side="right"
        label="Hide sidebar"
        onClick={toggleSidebar}
        className="md:hidden"
        icon={ArrowRightToLine}
      />
      <SideNavItem
        side="right"
        label="Chat"
        tooltip="Chat"
        active={!isPanelOpen}
        onClick={onShowMain}
        className="md:hidden"
        icon={MessagesSquare}
      />
      {children}
      <div className="grow" />
      {footer}
    </div>
  );
}

interface ResponsiveWorkspacePanelsProps {
  isPanelOpen: boolean;
  main: ReactNode;
  panel: ReactNode;
  panelId?: string;
  additionalPanels?: Array<{ id: string; content: ReactNode }>;
  mainSize?: number;
  panelSize?: number;
  mainMinSize?: number;
  panelMinSize?: number;
  dimUnfocusedPanelIds?: readonly string[];
  /** Measured width used by consumers to derive panel capacity. */
  layoutWidth?: number;
}

export function ResponsiveWorkspacePanels({
  isPanelOpen,
  main,
  panel,
  panelId = 'panel',
  additionalPanels = [],
  mainSize = 50,
  panelSize = 50,
  mainMinSize = 30,
  panelMinSize = 20,
  dimUnfocusedPanelIds = [],
  layoutWidth,
}: ResponsiveWorkspacePanelsProps) {
  const isMdOrLarger = useMediaQuery('(min-width: 768px)', {
    initializeWithValue: false,
  });
  if (!isMdOrLarger) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {isPanelOpen ? panel : main}
      </div>
    );
  }

  return (
    <DesktopWorkspacePanels
      main={main}
      panels={
        isPanelOpen
          ? [{ id: panelId, content: panel }, ...additionalPanels]
          : []
      }
      mainSize={mainSize}
      panelSize={panelSize}
      mainMinSize={mainMinSize}
      panelMinSize={panelMinSize}
      dimUnfocusedPanelIds={dimUnfocusedPanelIds}
      layoutWidth={layoutWidth}
    />
  );
}

type WorkspacePanel = { id: string; content: ReactNode };
interface DesktopPanelsProps {
  main: ReactNode;
  panels: WorkspacePanel[];
  mainSize: number;
  panelSize: number;
  mainMinSize: number;
  panelMinSize: number;
  dimUnfocusedPanelIds: readonly string[];
  layoutWidth?: number;
}
interface DesktopPanelsState {
  panels: WorkspacePanel[];
  activeIds: string[];
  mainMinSize: number;
  panelMinSize: number;
}

// A pre-mutation snapshot preserves the actual widths, including an interrupted
// animation, before the resizable library recalculates its registered panels.
class DesktopWorkspacePanels extends Component<
  DesktopPanelsProps,
  DesktopPanelsState
> {
  state = {
    panels: this.props.panels,
    activeIds: this.props.panels.map(({ id }) => id),
    mainMinSize: this.props.mainMinSize,
    panelMinSize: this.props.panelMinSize,
  };
  pendingWidths: Map<string, number> | undefined;
  settledWidths: Map<string, number> | undefined;
  animatePendingChange = false;
  interacting = false;
  container = createRef<HTMLDivElement>();
  group = createRef<ImperativePanelGroupHandle>();
  animations: Animation[] = [];
  timer: ReturnType<typeof setTimeout> | undefined;
  reducedMotion: MediaQueryList | undefined;

  static getDerivedStateFromProps(
    props: DesktopPanelsProps,
    state: DesktopPanelsState,
  ) {
    const panels = [...props.panels];
    state.panels.forEach((panel, index) => {
      if (!props.panels.some(({ id }) => id === panel.id)) {
        panels.splice(index, 0, panel);
      }
    });
    return { panels };
  }

  componentDidMount() {
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion.addEventListener('change', this.finishAnimation);
    window.addEventListener('resize', this.handleViewportResize);
    window.addEventListener('pointerup', this.finishInteraction);
    window.addEventListener('pointercancel', this.finishInteraction);
    window.addEventListener('keyup', this.finishInteraction);
    window.addEventListener('blur', this.finishInteraction);
  }

  componentWillUnmount() {
    this.cancelAnimation();
    this.reducedMotion?.removeEventListener('change', this.finishAnimation);
    window.removeEventListener('resize', this.handleViewportResize);
    window.removeEventListener('pointerup', this.finishInteraction);
    window.removeEventListener('pointercancel', this.finishInteraction);
    window.removeEventListener('keyup', this.finishInteraction);
    window.removeEventListener('blur', this.finishInteraction);
  }

  cancelAnimation = () => {
    clearTimeout(this.timer);
    this.animations.forEach((animation) => animation.cancel());
    this.animations = [];
  };

  finishAnimation = () => {
    this.cancelAnimation();
    // Keep the registered array stable until the library finishes its drag/key
    // resize. Removing an exit earlier invalidates its captured initial layout.
    if (this.interacting) return;
    if (
      this.state.panels.some(
        ({ id }) => !this.props.panels.some((panel) => panel.id === id),
      )
    ) {
      const layout = this.group.current?.getLayout() ?? [];
      this.settledWidths = new Map(
        ['main', ...this.state.panels.map(({ id }) => id)].map((id, index) => [
          id,
          layout[index] ?? 0,
        ]),
      );
      this.setState({
        panels: this.state.panels.filter(({ id }) =>
          this.props.panels.some((panel) => panel.id === id),
        ),
      });
    }
  };

  handleViewportResize = () => {
    this.finishAnimation();
  };

  finishInteraction = () => {
    if (!this.interacting) return;
    this.interacting = false;
    this.finishAnimation();
  };

  getSnapshotBeforeUpdate(previous: DesktopPanelsProps) {
    if (
      previous.panels.length === this.props.panels.length &&
      previous.panels.every(
        ({ id }, index) => id === this.props.panels[index]?.id,
      )
    )
      return new Map<string, number>();
    const panels = Array.from(
      this.container.current?.firstElementChild?.children ?? [],
    ).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element.hasAttribute('data-panel'),
    );
    const total = panels.reduce(
      (sum, panel) => sum + panel.getBoundingClientRect().width,
      0,
    );
    return new Map(
      panels.map((panel, index) => [
        panel.dataset.panelId!,
        total
          ? (panel.getBoundingClientRect().width / total) * 100
          : (this.group.current?.getLayout()[index] ?? 0),
      ]),
    );
  }

  componentDidUpdate(
    previous: DesktopPanelsProps,
    previousState: DesktopPanelsState,
    widths: Map<string, number>,
  ) {
    const changed =
      JSON.stringify(previous.panels.map(({ id }) => id)) !==
      JSON.stringify(this.props.panels.map(({ id }) => id));
    if (previous.layoutWidth !== this.props.layoutWidth) this.finishAnimation();
    if (
      changed ||
      previous.mainMinSize !== this.props.mainMinSize ||
      previous.panelMinSize !== this.props.panelMinSize
    ) {
      // Register the new set before changing constraints: v2 otherwise resizes
      // against a partially registered array and can throw on a stale index.
      if (changed) {
        this.pendingWidths = widths;
        this.animatePendingChange =
          previous.layoutWidth === this.props.layoutWidth;
      }
      this.setState({
        activeIds: this.props.panels.map(({ id }) => id),
        mainMinSize: this.props.mainMinSize,
        panelMinSize: this.props.panelMinSize,
      });
      return;
    }
    const animateChange = this.pendingWidths !== undefined;
    widths = this.pendingWidths ?? widths;
    this.pendingWidths = undefined;
    const removed = previousState.panels.length !== this.state.panels.length;
    if (!animateChange && !removed) return;

    this.cancelAnimation();
    const { panels, mainSize, panelSize } = this.props;
    const count = panels.length;
    const target = [
      count > 1 ? 100 / (count + 1) : count ? mainSize : 100,
      ...this.state.panels.map(({ id }) =>
        panels.some((panel) => panel.id === id)
          ? count > 1
            ? 100 / (count + 1)
            : panelSize
          : 0,
      ),
    ];
    this.group.current?.setLayout(
      !animateChange && this.settledWidths
        ? ['main', ...this.state.panels.map(({ id }) => id)].map(
            (id) => this.settledWidths!.get(id) ?? 0,
          )
        : target,
    );
    this.settledWidths = undefined;
    const layout = this.group.current?.getLayout() ?? target;
    const elements = Array.from(
      this.container.current?.firstElementChild?.children ?? [],
    ).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element.hasAttribute('data-panel'),
    );
    if (
      !animateChange ||
      !this.animatePendingChange ||
      this.interacting ||
      this.reducedMotion?.matches ||
      !elements[0]?.animate
    ) {
      this.finishAnimation();
      return;
    }

    this.animations = elements.map((element, index) =>
      element.animate(
        [
          { flexGrow: widths.get(element.dataset.panelId!) ?? 0 },
          { flexGrow: layout[index] },
        ],
        { duration: 240, easing: 'cubic-bezier(0.22,1,0.36,1.04)' },
      ),
    );
    this.timer = setTimeout(this.finishAnimation, 240);
  }

  render() {
    const { main, dimUnfocusedPanelIds } = this.props;
    const { mainMinSize, panelMinSize } = this.state;
    const panelCount = this.state.activeIds.length;
    const equalPanelSize = 100 / (panelCount + 1);
    return (
      <div
        ref={this.container}
        className="flex min-h-0 min-w-0 flex-1"
        onPointerDownCapture={(event) => {
          if (
            (event.target as HTMLElement).closest(
              '[data-panel-resize-handle-id]',
            )
          ) {
            this.interacting = true;
            this.cancelAnimation();
          }
        }}
        onKeyDownCapture={(event) => {
          if (
            (event.target as HTMLElement).closest(
              '[data-panel-resize-handle-id]',
            )
          ) {
            this.interacting = true;
            this.cancelAnimation();
          }
        }}
      >
        <ResizablePanelGroup
          ref={this.group}
          direction="horizontal"
          className={cn(
            'min-h-0 flex-1',
            dimUnfocusedPanelIds.length > 0 &&
              '[&_[data-dim-when-unfocused=true]]:transition-opacity [&:has([data-dim-when-unfocused=true]:focus-within)_[data-dim-when-unfocused=true]:not(:focus-within)]:opacity-80',
          )}
        >
          <ResizablePanel
            id="main"
            order={0}
            defaultSize={
              panelCount > 1
                ? equalPanelSize
                : panelCount
                  ? this.props.mainSize
                  : 100
            }
            minSize={mainMinSize}
            data-dim-when-unfocused={
              dimUnfocusedPanelIds.includes('main') || undefined
            }
            className="flex min-h-0 min-w-0 flex-col"
          >
            {main}
          </ResizablePanel>
          {this.state.panels.map((additionalPanel, index) => {
            const exiting = !this.state.activeIds.includes(additionalPanel.id);
            return (
              <Fragment key={additionalPanel.id}>
                <ResizableDivider
                  onDragging={(dragging) => {
                    this.interacting = dragging;
                    if (dragging) this.cancelAnimation();
                    else this.finishAnimation();
                  }}
                  disabled={exiting}
                  style={exiting ? { width: 0 } : undefined}
                />
                <ResizablePanel
                  id={additionalPanel.id}
                  order={index + 1}
                  defaultSize={
                    exiting
                      ? 0
                      : panelCount > 1
                        ? equalPanelSize
                        : this.props.panelSize
                  }
                  minSize={exiting ? 0 : panelMinSize}
                  maxSize={exiting ? 0 : undefined}
                  inert={exiting || undefined}
                  data-dim-when-unfocused={
                    dimUnfocusedPanelIds.includes(additionalPanel.id) ||
                    undefined
                  }
                  className="flex min-h-0 min-w-0 flex-col border-card"
                >
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l-2 border-card">
                    {additionalPanel.content}
                  </div>
                </ResizablePanel>
              </Fragment>
            );
          })}
        </ResizablePanelGroup>
      </div>
    );
  }
}
