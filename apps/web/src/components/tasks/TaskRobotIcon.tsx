'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import {
  getTaskRobotIconPath,
  resolveTaskRobotIconId,
} from '@/lib/task-robot-icons';
import { Avatar } from '@/components/system';

type TaskRobotIconContextValue = {
  sessionId?: string | null;
  orderedTaskIds: readonly string[];
  currentTaskId?: string;
  onOpenTask?: (taskId: string) => void;
};

const TaskRobotIconContext = createContext<TaskRobotIconContextValue | null>(
  null,
);

export function TaskRobotIconProvider({
  sessionId,
  orderedTaskIds,
  onOpenTask,
  currentTaskId,
  children,
}: TaskRobotIconContextValue & { children: ReactNode }) {
  const value = useMemo(
    () => ({ sessionId, orderedTaskIds, onOpenTask, currentTaskId }),
    [onOpenTask, orderedTaskIds, sessionId, currentTaskId],
  );

  return (
    <TaskRobotIconContext.Provider value={value}>
      {children}
    </TaskRobotIconContext.Provider>
  );
}

export function useTaskRobotIconContext() {
  return useContext(TaskRobotIconContext);
}

export function TaskRobotIcon({
  taskId,
  sessionId,
  orderedTaskIds,
  size = 'xs',
}: {
  taskId?: string | null;
  sessionId?: string | null;
  orderedTaskIds?: readonly string[];
  size?: 'xs' | 'sm';
}) {
  const context = useTaskRobotIconContext();
  const iconId = taskId
    ? resolveTaskRobotIconId({
        taskId,
        sessionId: sessionId ?? context?.sessionId,
        orderedTaskIds: orderedTaskIds ?? context?.orderedTaskIds,
      })
    : 'robot-001';

  return (
    <Avatar
      imageUrl={getTaskRobotIconPath(iconId)}
      size={size}
      alt=""
      data-task-robot-icon={iconId}
    />
  );
}
