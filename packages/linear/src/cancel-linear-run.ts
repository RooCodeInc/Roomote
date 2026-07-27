import { RunStatus, exitedRunStatuses } from '@roomote/types';
import {
  and,
  db,
  taskRuns,
  eq,
  inArray,
  markTaskStartParallelCountEndedAt,
  not,
} from '@roomote/db/server';
import { captureTaskSettled } from '@roomote/telemetry/server';

import type { ActiveLinearTaskRunResult } from './types';
import { clearLinearMessageQueue } from './queue-linear-message';

/**
 * Result of canceling a Linear run
 */
export interface CancelLinearTaskRunResult {
  success: boolean;
  runId?: number;
  error?: string;
}

/**
 * Cancel an active Linear run and clear its message queue.
 *
 * This is called when a user sends a "stop" signal from Linear to halt
 * agent work immediately. The run status is set to Canceled and any
 * pending messages in the queue are cleared.
 *
 * Note: Lock release is handled by the controller when it detects the
 * run status change. This function only updates the database status.
 */
export async function cancelLinearTaskRun(
  activeRun: ActiveLinearTaskRunResult,
  sessionId: string,
): Promise<CancelLinearTaskRunResult> {
  const { id: runId } = activeRun;

  try {
    // Verify the run exists
    const run = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, runId),
    });

    if (!run) {
      return {
        success: false,
        runId,
        error: 'Run not found',
      };
    }

    // Update the run status to Canceled
    const endedAt = new Date();

    const canceledRun = await db.transaction(async (tx) => {
      const [canceled] = await tx
        .update(taskRuns)
        .set({
          status: RunStatus.Canceled,
          canceledAt: endedAt,
          error: 'Canceled by user via stop signal',
        })
        .where(
          and(
            eq(taskRuns.id, runId),
            not(inArray(taskRuns.status, [...exitedRunStatuses])),
          ),
        )
        .returning({ id: taskRuns.id });

      if (!canceled) {
        return null;
      }

      await markTaskStartParallelCountEndedAt(tx, {
        runId: runId,
        endedAt,
      });

      return canceled;
    });

    if (canceledRun) {
      void captureTaskSettled(canceledRun.id, RunStatus.Canceled);
    }

    // Clear any pending messages in the queue
    await clearLinearMessageQueue(runId);

    console.log(
      `[cancelLinearTaskRun] Successfully canceled task run ${runId} for session ${sessionId}`,
    );

    return {
      success: true,
      runId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error(
      `[cancelLinearTaskRun] Failed to cancel task run ${runId}: ${message}`,
    );

    return {
      success: false,
      runId,
      error: message,
    };
  }
}
