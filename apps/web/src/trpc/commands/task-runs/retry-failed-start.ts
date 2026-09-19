import {
  DeploymentReadOnlyError,
  isRelaunchableFailedStartPayloadKind,
  retryFailedTaskStart,
} from '@roomote/cloud-agents/server';
import { and, db, desc, eq, isNull, taskRuns, tasks } from '@roomote/db/server';
import { RunStatus, TaskPayloadKind } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import { requireTaskAccess } from '@/lib/server/custom-automation-task-access';

type RetryFailedTaskStartResult =
  | { success: true; runId: number; taskId: string }
  | { success: false; error: string };

/**
 * Re-enqueues a failed first-start run on the same task so the user can retry
 * after fixing provider capacity (for example Modal spend limits).
 */
export async function retryFailedTaskStartCommand(
  auth: UserAuthSuccess,
  input: { taskId: string; runId?: number },
): Promise<RetryFailedTaskStartResult> {
  try {
    await requireTaskAccess(auth, input.taskId);
    const task = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, input.taskId), isNull(tasks.deletedAt)),
      columns: { id: true },
    });

    if (task == null) {
      return { success: false, error: 'Task not found' };
    }

    const failedRun =
      input.runId !== undefined
        ? await db.query.taskRuns.findFirst({
            where: and(
              eq(taskRuns.id, input.runId),
              eq(taskRuns.taskId, input.taskId),
            ),
          })
        : await db.query.taskRuns.findFirst({
            where: and(
              eq(taskRuns.taskId, input.taskId),
              eq(taskRuns.status, RunStatus.Failed),
            ),
            orderBy: [desc(taskRuns.id)],
          });

    if (!failedRun) {
      return { success: false, error: 'Failed task run not found' };
    }

    if (failedRun.status !== RunStatus.Failed) {
      return {
        success: false,
        error: 'Only failed task starts can be retried.',
      };
    }

    if (failedRun.payloadKind === TaskPayloadKind.SnapshotResume) {
      return {
        success: false,
        error: 'Use Retry resume for snapshot resume failures.',
      };
    }

    if (!isRelaunchableFailedStartPayloadKind(failedRun.payloadKind)) {
      return {
        success: false,
        error: 'This task type does not support start retry yet.',
      };
    }

    const result = await retryFailedTaskStart({
      sourceRun: failedRun,
      actingUserId: auth.userId,
      trigger: 'manual',
    });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    return {
      success: true,
      runId: result.run.id,
      taskId: result.run.taskId,
    };
  } catch (error) {
    console.error('retryFailedTaskStart error:', error);

    if (error instanceof DeploymentReadOnlyError) {
      return { success: false, error: error.code };
    }

    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'An unknown error occurred.',
    };
  }
}
