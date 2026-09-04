'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import {
  getTaskRobotIconPath,
  resolveTaskRobotIconId,
} from '@/lib/task-robot-icons';
import { cn } from '@/lib/utils';

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
  className,
}: {
  taskId: string;
  sessionId?: string | null;
  orderedTaskIds?: readonly string[];
  className?: string;
}) {
  const context = useTaskRobotIconContext();
  const iconId = resolveTaskRobotIconId({
    taskId,
    sessionId: sessionId ?? context?.sessionId,
    orderedTaskIds: orderedTaskIds ?? context?.orderedTaskIds,
  });

  return (
    <span
      aria-hidden="true"
      data-task-robot-icon={iconId}
      className={cn(
        'inline-flex shrink-0 overflow-hidden rounded-md bg-[#c7f33c]',
        className,
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={getTaskRobotIconPath(iconId)}
        alt=""
        className="size-full object-cover"
        draggable={false}
      />
    </span>
  );
}
