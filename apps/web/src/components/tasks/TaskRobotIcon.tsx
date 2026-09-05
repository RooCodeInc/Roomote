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
};

const TaskRobotIconContext = createContext<TaskRobotIconContextValue | null>(
  null,
);

export function TaskRobotIconProvider({
  sessionId,
  orderedTaskIds,
  children,
}: TaskRobotIconContextValue & { children: ReactNode }) {
  const value = useMemo(
    () => ({ sessionId, orderedTaskIds }),
    [orderedTaskIds, sessionId],
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
}: {
  taskId: string;
  sessionId?: string | null;
  orderedTaskIds?: readonly string[];
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
      size="sm"
      alt=""
      data-task-robot-icon={iconId}
    />
  );
}
