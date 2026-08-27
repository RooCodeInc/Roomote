'use client';

import { type ReactNode } from 'react';

import { ResponsiveWorkspacePanels } from '../../SandboxWorkspacePanels';
import { TaskSidePanelDesktop } from './sidebar-panels/TaskSidePanel';

import type { TaskSession, GitDiffResponse } from './hooks';

import { useTaskSidePanel } from './hooks/use-task-side-panel';

interface DiffPanelProps {
  data: GitDiffResponse | undefined;
  error: Error | null;
  isLoading: boolean;
  onRefresh: () => void;
}

interface PreviewPaneLayoutProps {
  session: TaskSession;
  children: ReactNode;
  diffPanel?: DiffPanelProps;
}

export function PreviewPaneLayout({
  session,
  children,
  diffPanel,
}: PreviewPaneLayoutProps) {
  const { activeView } = useTaskSidePanel();

  return (
    <ResponsiveWorkspacePanels
      isPanelOpen={activeView !== null}
      main={children}
      panel={<TaskSidePanelDesktop session={session} diffPanel={diffPanel} />}
    />
  );
}
