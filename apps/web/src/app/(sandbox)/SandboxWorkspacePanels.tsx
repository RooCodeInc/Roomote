'use client';

import type { ReactNode } from 'react';
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
  mainSize?: number;
  panelSize?: number;
}

export function ResponsiveWorkspacePanels({
  isPanelOpen,
  main,
  panel,
  mainSize = 50,
  panelSize = 50,
}: ResponsiveWorkspacePanelsProps) {
  const isMdOrLarger = useMediaQuery('(min-width: 768px)');

  if (!isMdOrLarger) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1">
        {isPanelOpen ? panel : main}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        <ResizablePanel
          defaultSize={isPanelOpen ? mainSize : 100}
          minSize={30}
          className="flex min-h-0 min-w-0 flex-col"
        >
          {main}
        </ResizablePanel>
        {isPanelOpen ? (
          <>
            <ResizableDivider />
            <ResizablePanel
              defaultSize={panelSize}
              minSize={20}
              className="flex min-h-0 min-w-0 flex-col border-l-2 border-card"
            >
              {panel}
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
    </div>
  );
}
