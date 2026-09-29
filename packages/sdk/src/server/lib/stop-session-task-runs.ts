import {
  and,
  db,
  eq,
  inArray,
  sessionTasks,
  taskRuns,
} from '@roomote/db/server';
import {
  activeRunStatuses,
  isExitedRunStatus,
  type RunStatus,
} from '@roomote/types';

import { stopTaskRun } from './task-runs/stop-task-run';

/** Stop every currently active task linked to one Session without terminating
 * its sandbox, so the task can be resumed from the same Session later. */
export async function stopSessionTaskRuns(input: {
  sessionId: string;
  authUserId: string;
  cancelledBy?: { name?: string; source?: string };
}) {
  const runs = await db
    .select({
      id: taskRuns.id,
      taskId: taskRuns.taskId,
      payload: taskRuns.payload,
      status: taskRuns.status,
      sandboxServerUrl: taskRuns.sandboxServerUrl,
      actingUserId: taskRuns.actingUserId,
    })
    .from(taskRuns)
    .innerJoin(sessionTasks, eq(sessionTasks.taskId, taskRuns.taskId))
    .where(
      and(
        eq(sessionTasks.sessionId, input.sessionId),
        inArray(taskRuns.status, activeRunStatuses as readonly RunStatus[]),
      ),
    );

  const results = await Promise.all(
    runs.map(async (run) => {
      const result = await stopTaskRun({
        run,
        authUserId: input.authUserId,
        terminate: false,
        cancelledBy: input.cancelledBy,
      }).catch(() => null);
      if (result?.success) return true;

      const current = await db.query.taskRuns.findFirst({
        where: eq(taskRuns.id, run.id),
        columns: { status: true },
      });
      return !current || isExitedRunStatus(current.status);
    }),
  );

  const stoppedCount = results.filter(Boolean).length;
  return {
    success: stoppedCount === runs.length,
    stoppedCount,
    ...(stoppedCount === runs.length
      ? {}
      : { failedCount: runs.length - stoppedCount }),
  };
}
