'use client';

import { type ReactNode } from 'react';
import { useMediaQuery } from 'usehooks-ts';

import {
  ResizableDivider,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/system';
import { TaskSidePanelDesktop } from './sidebar-panels/TaskSidePanel';

import type { CloudSession, GitDiffResponse } from './hooks';

import { useTaskSidePanel } from './hooks/use-task-side-panel';

interface DiffPanelProps {
  data: GitDiffResponse | undefined;
  error: Error | null;
  isLoading: boolean;
  onRefresh: () => void;
}

interface PreviewPaneLayoutProps {
  session: CloudSession;
  children: ReactNode;
  diffPanel?: DiffPanelProps;
}

export function PreviewPaneLayout({
  session,
  children,
  diffPanel,
}: PreviewPaneLayoutProps) {
  const { activeView } = useTaskSidePanel();
  const isMdOrLarger = useMediaQuery('(min-width: 768px)');

  // On mobile: when a side panel is active, show it in place of the
  // conversation. No Sheet/drawer — same component as desktop.
  if (!isMdOrLarger) {
    if (activeView !== null) {
      return <TaskSidePanelDesktop session={session} diffPanel={diffPanel} />;
    }
    return <div className="flex min-h-0 min-w-0 flex-1">{children}</div>;
  }

  // Always render the ResizablePanelGroup so toggling the side panel doesn't
  // unmount/remount the conversation tree (which would reset LazyMessage
  // observers and cause messages to briefly disappear).
  const hasSidePanel = activeView !== null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        <ResizablePanel
          defaultSize={hasSidePanel ? 50 : 100}
          minSize={30}
          className="flex min-h-0 min-w-0 flex-col"
        >
          {children}
        </ResizablePanel>
        {hasSidePanel && (
          <>
            <ResizableDivider />
            <ResizablePanel
              defaultSize={50}
              minSize={20}
              className="flex min-h-0 min-w-0 flex-col border-l-2 border-card"
            >
              <TaskSidePanelDesktop session={session} diffPanel={diffPanel} />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}
