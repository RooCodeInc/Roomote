'use client';

import { memo } from 'react';

import { ArrowRightToLine, MessagesSquare } from '@/components/system';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';

import type { TaskSession } from '../hooks';
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
  session: TaskSession;
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
  const { taskId, taskRun, artifacts, sessionState } = session;
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
      {taskRun && (
        <LivePreviewButton
          taskId={taskId}
          taskRun={taskRun}
          disabled={disableSandboxActions}
        />
      )}
      {taskRun && onToggleDiff && (
        <DiffButton
          active={showDiff}
          onClick={onToggleDiff}
          changedFileCount={changedFileCount}
          isLoading={isDiffLoading}
          disabled={disableSandboxActions}
        />
      )}
      {taskRun && (
        <ArtifactsButton
          taskId={taskId}
          taskRun={taskRun}
          artifacts={artifacts}
          disabled={disableSandboxActions}
        />
      )}
      {isInteractive && taskRun ? (
        <TerminalButton taskId={taskId} taskRun={taskRun} />
      ) : null}
      {isInteractive && taskRun ? (
        <LogsButton taskId={taskId} taskRun={taskRun} />
      ) : null}
      <TaskInfoButton session={session} disabled={disableSandboxActions} />

      <div className="grow" />
      <OverflowMenu
        taskId={taskId}
        taskRun={taskRun}
        resolutionStatus={session.task?.resolutionStatus}
        disabled={disableSandboxActions}
      />
    </div>
  ) : null;
}

export const SidebarActions = memo(SidebarActionsBase);
