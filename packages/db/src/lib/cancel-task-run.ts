import { and, eq, inArray, isNull, not } from 'drizzle-orm';
import { CloudTaskStatus, exitedCloudTaskStatuses } from '@roomote/types';

import { db } from '../db';
import { taskRuns } from '../schema';
import { syncTaskStateFromRuns } from './sync-task-state';
import { markTaskStartParallelCountEndedAt } from './task-start-parallel-counts';

/**
 * Best-effort direct cancel of a run that has not attached a sandbox yet.
 *
 * This is the enqueue-level cancel shared by the stop-task fallback (a run
 * with no sandbox to RPC into) and the work-item launch surfaces (canceling a
 * run whose fenced `finalizeWorkItemLaunched` lost to a reclaim, so the run
 * would otherwise keep running unlinked from its work item).
 *
 * Guarded so it only applies while the run is still pre-sandbox and
 * non-terminal (`sandbox_server_url IS NULL` and status not exited): once a
 * sandbox attached, cancellation must go through the sandbox RPC instead, and
 * this returns false. On success the owning task's state is re-derived from
 * all its runs and the run's parallel-count window is closed, matching the
 * other cancel writers.
 */
export async function cancelTaskRunDirect(params: {
  runId: number;
  /** Optional `error` to record on the canceled run (why it was canceled). */
  error?: string;
}): Promise<boolean> {
  const endedAt = new Date();

  const [canceled] = await db.transaction(async (tx) => {
    const [run] = await tx
      .update(taskRuns)
      .set({
        status: CloudTaskStatus.Canceled,
        // Stamp the stop intent alongside the terminal write so a later
        // Failed finalization (e.g. the sandbox dying mid-cancel) reports as
        // canceled, not as a runtime failure.
        cancelRequestedAt: endedAt,
        canceledAt: endedAt,
        ...(params.error ? { error: params.error } : {}),
      })
      .where(
        and(
          eq(taskRuns.id, params.runId),
          isNull(taskRuns.sandboxServerUrl),
          not(
            inArray(
              taskRuns.status,
              exitedCloudTaskStatuses as unknown as CloudTaskStatus[],
            ),
          ),
        ),
      )
      .returning({ id: taskRuns.id, taskId: taskRuns.taskId });

    if (!run) {
      return [];
    }

    await syncTaskStateFromRuns(tx, run.taskId);

    await markTaskStartParallelCountEndedAt(tx, {
      runId: params.runId,
      endedAt,
    });

    return [true];
  });

  return Boolean(canceled);
}
