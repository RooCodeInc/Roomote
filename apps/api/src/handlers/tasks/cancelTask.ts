import type { Context } from 'hono';

import {
  db,
  eq,
  markTaskStartParallelCountEndedAt,
  syncTaskStateFromRuns,
  taskRuns,
} from '@roomote/db/server';
import { CloudTaskStatus, isExitedCloudTaskStatus } from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { findLatestCloudJob } from './helpers';
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
    const job = await findLatestCloudJob(taskId);

    if (!job) {
      return c.json({ success: false, error: 'Task not found' }, 404);
    }

    if (isExitedCloudTaskStatus(job.status)) {
      return c.json(
        {
          success: false,
          error: `Task is already in a terminal state: ${job.status}`,
        },
        409,
      );
    }

    const endedAt = new Date();

    await db.transaction(async (tx) => {
      await tx
        .update(taskRuns)
        .set({
          status: CloudTaskStatus.Canceled,
          canceledAt: endedAt,
        })
        .where(eq(taskRuns.id, job.id));

      // Derive the durable task state from all its runs after canceling this
      // run, so a still-running or already-completed sibling is respected.
      await syncTaskStateFromRuns(tx, taskId);

      await markTaskStartParallelCountEndedAt(tx, {
        runId: job.id,
        endedAt,
      });
    });

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
