import type { Context } from 'hono';
import { isExitedRunStatus } from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { findLatestCloudJob } from './helpers';
import { stopTaskJob } from './task-stop';
import { logHandlerError } from '../utils';

/**
 * POST /api/tasks/:taskId/stop
 *
 * Stop an active Roomote task using the same resumable sandbox path as the
 * live task UI stop button.
 */
export async function stopTask(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth');

  const taskId = c.req.param('taskId');

  if (!taskId?.trim()) {
    return c.json({ error: 'taskId is required' }, 400);
  }

  try {
    const job = await findLatestCloudJob(taskId, {
      id: true,
      status: true,
      sandboxServerUrl: true,
      userId: true,
      actingUserId: true,
    });

    if (!job) {
      return c.json({ success: false, error: 'Task not found' }, 404);
    }

    if (isExitedRunStatus(job.status)) {
      return c.json(
        {
          success: false,
          error: `Task is not active (status: ${job.status})`,
        },
        409,
      );
    }

    const result = await stopTaskJob({
      job,
      authUserId: auth.userId,
      cancelledBy: { source: 'api' },
    });

    if (!result.success) {
      return c.json(
        {
          success: false,
          error: result.error,
        },
        result.statusCode,
      );
    }

    return c.json({ success: true });
  } catch (error) {
    logHandlerError('stopTask', error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop task',
      },
      500,
    );
  }
}
