import { RunStatus } from '@roomote/types';
import {
  db,
  taskRuns,
  eq,
  markTaskStartParallelCountEndedAt,
} from '@roomote/db/server';

import type { ActiveLinearJobResult } from './types';
import { clearLinearMessageQueue } from './queue-linear-message';

/**
 * Result of canceling a Linear job
 */
export interface CancelLinearJobResult {
  success: boolean;
  jobId?: number;
  error?: string;
}

/**
 * Cancel an active Linear job and clear its message queue.
 *
 * This is called when a user sends a "stop" signal from Linear to halt
 * agent work immediately. The run status is set to Canceled and any
 * pending messages in the queue are cleared.
 *
 * Note: Lock release is handled by the controller when it detects the
 * run status change. This function only updates the database status.
 */
export async function cancelLinearJob(
  activeJob: ActiveLinearJobResult,
  sessionId: string,
): Promise<CancelLinearJobResult> {
  const { id: jobId } = activeJob;

  try {
    // Verify the run exists
    const job = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, jobId),
    });

    if (!job) {
      return {
        success: false,
        jobId,
        error: 'Job not found',
      };
    }

    // Update the run status to Canceled
    const endedAt = new Date();

    await db.transaction(async (tx) => {
      await tx
        .update(taskRuns)
        .set({
          status: RunStatus.Canceled,
          canceledAt: endedAt,
          error: 'Canceled by user via stop signal',
        })
        .where(eq(taskRuns.id, jobId));

      await markTaskStartParallelCountEndedAt(tx, {
        runId: jobId,
        endedAt,
      });
    });

    // Clear any pending messages in the queue
    await clearLinearMessageQueue(jobId);

    console.log(
      `[cancelLinearJob] Successfully canceled job ${jobId} for session ${sessionId}`,
    );

    return {
      success: true,
      jobId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error(
      `[cancelLinearJob] Failed to cancel job ${jobId}: ${message}`,
    );

    return {
      success: false,
      jobId,
      error: message,
    };
  }
}
