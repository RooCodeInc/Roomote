'use client';

import { memo } from 'react';

import { Info } from '@/components/system';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';

import { useTaskSidePanel, type TaskSession } from '../hooks';

interface TaskInfoButtonProps {
  session: TaskSession;
  disabled?: boolean;
}

function TaskInfoButtonBase({
  session: { task, taskRun },
  disabled = false,
}: TaskInfoButtonProps) {
  const { openTaskInfoView, closeSidePanel, isViewActive } = useTaskSidePanel();

  if (!task || !taskRun) {
    return null;
  }

  const taskInfoViewActive = isViewActive('task-info');

  return (
    <SideNavItem
      side="right"
      label="Task info"
      tooltip={disabled ? undefined : 'Task info'}
      active={!disabled && taskInfoViewActive}
      disabled={disabled}
      icon={Info}
      onClick={
        disabled
          ? undefined
          : () => (taskInfoViewActive ? closeSidePanel() : openTaskInfoView())
      }
    />
  );
}

export const TaskInfoButton = memo(TaskInfoButtonBase);
