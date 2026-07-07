import type { Context } from 'hono';

import { and, db, environments, eq, tasks } from '@roomote/db/server';
import { getEnvironmentDefinitionIdFromPayload } from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';

import {
  getLatestCloudJobsByTaskIds,
  TASK_SELECT_COLUMNS,
  visibleTaskHistoryCondition,
} from './helpers';
import { logHandlerError } from '../utils';

/**
 * GET /api/tasks/:taskId/summary
 *
 * Get a summary of a specific task including MCP-facing metadata.
 */
export async function getTaskSummary(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const taskId = c.req.param('taskId');

  if (!taskId) {
    return c.json({ error: 'taskId is required' }, 400);
  }

  try {
    const [task] = await db
      .select(TASK_SELECT_COLUMNS)
      .from(tasks)
      .where(and(eq(tasks.id, taskId), visibleTaskHistoryCondition))
      .limit(1);

    if (!task) {
      return c.json({ error: 'Task not found' }, 404);
    }

    const latestJobs = await getLatestCloudJobsByTaskIds([task.id]);
    const latestJob = latestJobs[task.id] ?? null;
    const linkedEnvironmentId = getEnvironmentDefinitionIdFromPayload(
      latestJob?.payload,
    );
    const linkedEnvironment = linkedEnvironmentId
      ? await db.query.environments.findFirst({
          where: eq(environments.id, linkedEnvironmentId),
          columns: { id: true, name: true },
        })
      : null;

    return c.json({
      id: task.id,
      title: task.title,
      mode: task.mode,
      completed: task.completed,
      repositoryName: task.repositoryName,
      harness: task.harness,
      createdAt: task.timestamp,
      cloudJobStatus: latestJob?.status ?? null,
      taskPhase: latestJob?.taskPhase ?? null,
      cloudJobError: latestJob?.error ?? null,
      linkedEnvironmentId: linkedEnvironmentId ?? null,
      linkedEnvironmentName: linkedEnvironment?.name ?? null,
    });
  } catch (error) {
    logHandlerError('getTaskSummary', error);
    return c.json({ error: 'Failed to get task summary' }, 500);
  }
}
