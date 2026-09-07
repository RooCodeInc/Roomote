'use client';

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import {
  TaskRobotIconProvider,
  useTaskRobotIconContext,
} from '@/components/tasks/TaskRobotIcon';
import { useTRPC } from '@/trpc/client';

export function TaskRobotIconScope({
  taskId,
  fastAgentSessionId,
  children,
}: {
  taskId: string;
  fastAgentSessionId?: string | null;
  children: ReactNode;
}) {
  const inheritedContext = useTaskRobotIconContext();
  const trpc = useTRPC();
  const { data: parentSession } = useQuery(
    trpc.sessions.forTask.queryOptions(
      { taskId },
      { enabled: inheritedContext === null },
    ),
  );
  const sessionId = parentSession?.sessionId ?? fastAgentSessionId ?? null;
  const { data: iconSession } = useQuery(
    trpc.sessions.byId.queryOptions(
      { sessionId: sessionId ?? '' },
      { enabled: inheritedContext === null && Boolean(sessionId) },
    ),
  );

  if (inheritedContext || !sessionId) return children;

  return (
    <TaskRobotIconProvider
      sessionId={sessionId}
      orderedTaskIds={iconSession?.tasks.map((task) => task.taskId) ?? []}
    >
      {children}
    </TaskRobotIconProvider>
  );
}
