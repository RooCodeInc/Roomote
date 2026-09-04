import type { Context } from 'hono';

import { and, db, environments, eq, tasks } from '@roomote/db/server';
import { getLinkedEnvironmentIdFromPayload } from '@roomote/types';
import { Env } from '@roomote/env';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';

import {
  getLatestTaskRunsByTaskIds,
  TASK_SELECT_COLUMNS,
  visibleTaskHistoryCondition,
} from './helpers';
import { logHandlerError } from '../utils';
import { listArtifactsByTask } from '../artifacts/service';

function buildArtifactViewUrl(input: {
  taskId: string;
  path: string;
  version: number;
}): string {
  const baseUrl = (Env.R_PUBLIC_URL ?? Env.R_APP_URL).replace(/\/+$/, '');
  const encodedPath = input.path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${baseUrl}/task/${encodeURIComponent(input.taskId)}/artifacts/${encodedPath}?v=${input.version}`;
}

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

    const latestRuns = await getLatestTaskRunsByTaskIds([task.id]);
    const latestRun = latestRuns[task.id] ?? null;
    const linkedEnvironmentId = getLinkedEnvironmentIdFromPayload(
      latestRun?.payload,
    );
    const [linkedEnvironment, artifacts] = await Promise.all([
      linkedEnvironmentId
        ? db.query.environments.findFirst({
            where: eq(environments.id, linkedEnvironmentId),
            columns: { id: true, name: true },
          })
        : null,
      listArtifactsByTask({ taskId: task.id, auth: {} }),
    ]);
    const imageArtifacts = artifacts
      .filter((artifact) => artifact.contentType.startsWith('image/'))
      .map((artifact) => ({
        id: artifact.id,
        path: artifact.path,
        version: artifact.version,
        artifactType: artifact.artifactType,
        contentType: artifact.contentType,
        viewUrl: buildArtifactViewUrl({
          taskId: task.id,
          path: artifact.path,
          version: artifact.version,
        }),
      }));

    return c.json({
      id: task.id,
      title: task.title,
      mode: task.mode,
      completed: task.state === 'completed',
      state: task.state,
      repositoryName: task.repositoryName,
      harness: task.harness,
      createdAt: task.timestamp,
      taskRunStatus: latestRun?.status ?? null,
      taskPhase: latestRun?.taskPhase ?? null,
      taskRunError: latestRun?.error ?? null,
      environmentSetupState: latestRun?.environmentSetupState ?? null,
      linkedEnvironmentId: linkedEnvironmentId ?? null,
      linkedEnvironmentName: linkedEnvironment?.name ?? null,
      imageArtifacts,
    });
  } catch (error) {
    logHandlerError('getTaskSummary', error);
    return c.json({ error: 'Failed to get task summary' }, 500);
  }
}
