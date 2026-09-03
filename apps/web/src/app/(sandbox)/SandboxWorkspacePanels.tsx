'use client';

import { Fragment, type ReactNode } from 'react';
import { useMediaQuery } from 'usehooks-ts';

import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';
import {
  ArrowRightToLine,
  MessagesSquare,
  ResizableDivider,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/system';

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
}: ResponsiveWorkspacePanelsProps) {
  const isMdOrLarger = useMediaQuery('(min-width: 768px)', {
    initializeWithValue: false,
  });
  const panelCount = isPanelOpen ? additionalPanels.length + 1 : 0;
  const equalPanelSize = 100 / (panelCount + 1);

  if (!isMdOrLarger) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {isPanelOpen ? panel : main}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        <ResizablePanel
          id="main"
          order={0}
          defaultSize={
            panelCount > 1 ? equalPanelSize : isPanelOpen ? mainSize : 100
          }
          minSize={mainMinSize}
          className="flex min-h-0 min-w-0 flex-col"
        >
          {main}
        </ResizablePanel>
        {isPanelOpen ? (
          <>
            <ResizableDivider />
            <ResizablePanel
              id={panelId}
              order={1}
              defaultSize={panelCount > 1 ? equalPanelSize : panelSize}
              minSize={panelMinSize}
              className="flex min-h-0 min-w-0 flex-col border-l-2 border-card"
            >
              {panel}
            </ResizablePanel>
          </>
        ) : null}
        {isPanelOpen
          ? additionalPanels.map((additionalPanel, index) => (
              <Fragment key={additionalPanel.id}>
                <ResizableDivider />
                <ResizablePanel
                  id={additionalPanel.id}
                  order={index + 2}
                  defaultSize={equalPanelSize}
                  minSize={panelMinSize}
                  className="flex min-h-0 min-w-0 flex-col border-l-2 border-card"
                >
                  {additionalPanel.content}
                </ResizablePanel>
              </Fragment>
            ))
          : null}
      </ResizablePanelGroup>
    </div>
  );
}
