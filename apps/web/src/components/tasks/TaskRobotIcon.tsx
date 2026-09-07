'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import {
  getTaskRobotIconPath,
  resolveTaskRobotIconId,
} from '@/lib/task-robot-icons';
import { Avatar } from '@/components/system';

type TaskRobotIconContextValue = {
  sessionId: string;
  orderedTaskIds: readonly string[];
  onOpenTask?: (taskId: string) => void;
};

const TaskRobotIconContext = createContext<TaskRobotIconContextValue | null>(
  null,
);

export function TaskRobotIconProvider({
  sessionId,
  orderedTaskIds,
  onOpenTask,
  children,
}: TaskRobotIconContextValue & { children: ReactNode }) {
  const value = useMemo(
    () => ({ sessionId, orderedTaskIds, onOpenTask }),
    [onOpenTask, orderedTaskIds, sessionId],
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
  taskId: string;
  sessionId?: string | null;
  orderedTaskIds?: readonly string[];
  size?: 'xs' | 'sm';
}) {
  const context = useTaskRobotIconContext();
  const iconId = resolveTaskRobotIconId({
    taskId,
    sessionId: sessionId ?? context?.sessionId,
    orderedTaskIds: orderedTaskIds ?? context?.orderedTaskIds,
  });

  return (
    <Avatar
      imageUrl={getTaskRobotIconPath(iconId)}
      size={size}
      alt=""
      data-task-robot-icon={iconId}
    />
  );
}
