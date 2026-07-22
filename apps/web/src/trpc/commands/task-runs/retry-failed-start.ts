import {
  DeploymentReadOnlyError,
  enqueueTaskRelaunch,
  isRelaunchableFailedStartPayloadKind,
} from '@roomote/cloud-agents/server';
import { and, db, desc, eq, isNull, taskRuns, tasks } from '@roomote/db/server';
import { RunStatus, TaskPayloadKind } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

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
            columns: {
              id: true,
              status: true,
              payloadKind: true,
            },
          })
        : await db.query.taskRuns.findFirst({
            where: and(
              eq(taskRuns.taskId, input.taskId),
              eq(taskRuns.status, RunStatus.Failed),
            ),
            orderBy: [desc(taskRuns.id)],
            columns: {
              id: true,
              status: true,
              payloadKind: true,
            },
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

    const relaunchedRun = await enqueueTaskRelaunch({
      sourceRunId: failedRun.id,
      actingUserId: auth.userId,
    });

    return {
      success: true,
      runId: relaunchedRun.id,
      taskId: relaunchedRun.taskId,
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
