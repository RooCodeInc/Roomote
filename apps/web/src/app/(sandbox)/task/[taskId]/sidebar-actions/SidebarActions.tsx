'use client';

import { memo } from 'react';

import type { TaskSession } from '../hooks';
import { useTaskSidePanel } from '../hooks';

import { SandboxSideActions } from '../../../SandboxWorkspacePanels';

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

  const { activeView, closeSidePanel } = useTaskSidePanel();

  return (
    <SandboxSideActions
      isPanelOpen={activeView !== null}
      onShowMain={closeSidePanel}
      footer={
        <OverflowMenu
          taskId={taskId}
          taskRun={taskRun}
          disabled={disableSandboxActions}
        />
      }
    >
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
    </SandboxSideActions>
  );
}

export const SidebarActions = memo(SidebarActionsBase);
