'use client';

import { memo } from 'react';

import { ArrowRightToLine, MessagesSquare } from '@/components/system';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';

import type { CloudSession } from '../hooks';
import { useTaskSidePanel } from '../hooks';

import { useSandboxLayout } from '../../../use-sandbox-layout';

import { DiffButton } from './DiffButton';
import { LivePreviewButton } from './LivePreviewButton';
import { ArtifactsButton } from './ArtifactsButton';
import { LogsButton } from './LogsButton';
import { TaskInfoButton } from './TaskInfoButton';
import { TerminalButton } from './TerminalButton';
import { OverflowMenu } from './OverflowMenu';

interface SidebarActionsProps {
  session: CloudSession;
  showDiff?: boolean;
  onToggleDiff?: () => void;
  changedFileCount?: number;
  isDiffLoading?: boolean;
}

function SidebarActionsBase({
  session,
  showDiff = false,
  onToggleDiff,
  changedFileCount = 0,
  isDiffLoading = false,
}: SidebarActionsProps) {
  const { taskId, cloudJob, artifacts, sessionState } = session;
  const isInteractive = sessionState === 'interactive';
  const disableSandboxActions =
    sessionState === 'booting' || sessionState === 'resuming';

  const { isSidebarVisible, toggleSidebar } = useSandboxLayout();
  const { activeView, closeSidePanel } = useTaskSidePanel();

  return isSidebarVisible ? (
    <div className="flex h-full shrink-0 flex-col gap-2 overflow-y-auto bg-card pr-2 py-3">
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
        active={activeView === null}
        onClick={closeSidePanel}
        className="md:hidden"
        icon={MessagesSquare}
      />
      {cloudJob && (
        <LivePreviewButton
          taskId={taskId}
          cloudJob={cloudJob}
          disabled={disableSandboxActions}
        />
      )}
      {cloudJob && onToggleDiff && (
        <DiffButton
          active={showDiff}
          onClick={onToggleDiff}
          changedFileCount={changedFileCount}
          isLoading={isDiffLoading}
          disabled={disableSandboxActions}
        />
      )}
      {cloudJob && (
        <ArtifactsButton
          taskId={taskId}
          cloudJob={cloudJob}
          artifacts={artifacts}
          disabled={disableSandboxActions}
        />
      )}
      {isInteractive && cloudJob ? (
        <TerminalButton taskId={taskId} cloudJob={cloudJob} />
      ) : null}
      {isInteractive && cloudJob ? (
        <LogsButton taskId={taskId} cloudJob={cloudJob} />
      ) : null}
      <TaskInfoButton session={session} disabled={disableSandboxActions} />

      <div className="grow" />
      <OverflowMenu
        taskId={taskId}
        cloudJob={cloudJob}
        disabled={disableSandboxActions}
      />
    </div>
  ) : null;
}

export const SidebarActions = memo(SidebarActionsBase);
