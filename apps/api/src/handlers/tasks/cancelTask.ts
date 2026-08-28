import type { Context } from 'hono';

import {
  db,
  and,
  eq,
  inArray,
  markTaskStartParallelCountEndedAt,
  syncTaskStateFromRuns,
  taskRuns,
} from '@roomote/db/server';
import {
  RunStatus,
  activeRunStatuses,
  isExitedRunStatus,
} from '@roomote/types';
import { captureTaskSettled } from '@roomote/telemetry/server';
import { settleSlackLiveTaskCardForRun } from '@roomote/slack';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { findLatestTaskRun } from './helpers';
import { logHandlerError } from '../utils';

/**
 * POST /api/tasks/:taskId/cancel
 *
 * Cancel an active Roomote task.
 */
export async function cancelTask(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const taskId = c.req.param('taskId');

  if (!taskId?.trim()) {
    return c.json({ error: 'taskId is required' }, 400);
  }

  try {
    const job = await findLatestTaskRun(taskId);

    if (!job) {
      return c.json({ success: false, error: 'Task not found' }, 404);
    }

    if (isExitedRunStatus(job.status)) {
      return c.json(
        {
          success: false,
          error: `Task is already in a terminal state: ${job.status}`,
        },
        409,
      );
    }

    const endedAt = new Date();

    const canceledRun = await db.transaction(async (tx) => {
      const [canceled] = await tx
        .update(taskRuns)
        .set({
          status: RunStatus.Canceled,
          cancelRequestedAt: endedAt,
          canceledAt: endedAt,
        })
        .where(
          and(
            eq(taskRuns.id, job.id),
            inArray(taskRuns.status, [...activeRunStatuses]),
          ),
        )
        .returning({ id: taskRuns.id });

      if (!canceled) {
        return null;
      }

      // Derive the durable task state from all its runs after canceling this
      // run, so a still-running or already-completed sibling is respected.
      await syncTaskStateFromRuns(tx, taskId);

      await markTaskStartParallelCountEndedAt(tx, {
        runId: job.id,
        endedAt,
      });

      return canceled;
    });

    if (canceledRun) {
      void captureTaskSettled(canceledRun.id, 'canceled');
      // A run canceled before any worker claimed it has nobody else to
      // settle its Slack task card (the worker settles it otherwise).
      void settleSlackLiveTaskCardForRun({
        taskId,
        payload: job.payload,
        status: RunStatus.Canceled,
      });
    }

    return c.json({ success: true });
  } catch (error) {
    logHandlerError('cancelTask', error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to cancel task',
      },
      500,
    );
  }
}
