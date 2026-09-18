'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

import { DelegatedTaskCard } from '../../task/[taskId]/messages/acp/DelegatedTaskCard';
import { useOpenSessionTaskPanel } from './session-task-panel-context';

/**
 * Body for a Session with no Fast conversation (automation-owned Sessions such
 * as code reviews): render each attached task as a started-task row instead of
 * leaving the Session a bare header. Rows open the nested task panel.
 */
export function SessionTaskTimeline({
  sessionId,
  initialTasks,
}: {
  sessionId: string;
  initialTasks: Array<{ taskId: string; title: string | null }>;
}) {
  const trpc = useTRPC();
  const openTaskPanel = useOpenSessionTaskPanel();
  // Same query key as SessionWorkspace's poll, so this reads its cache and
  // picks up tasks attached after the initial server render.
  const { data } = useQuery(trpc.sessions.byId.queryOptions({ sessionId }));
  const tasks = data?.tasks ?? initialTasks;

  if (tasks.length === 0) return null;

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-2 @[600px]:px-6">
      <div className="mx-auto w-full max-w-3xl">
        {tasks.map((task) => (
          <DelegatedTaskCard
            key={task.taskId}
            taskId={task.taskId}
            prompt={task.title}
            onOpen={(taskId) => openTaskPanel?.(taskId)}
          />
        ))}
      </div>
    </div>
  );
}
