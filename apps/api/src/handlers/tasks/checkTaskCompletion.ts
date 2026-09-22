import type { Context } from 'hono';

import { evaluateTaskCompletionGate } from '@roomote/cloud-agents/server';
import { db, eq, taskRuns } from '@roomote/db/server';
import {
  taskCompletionCheckRequestSchema,
  type TaskCompletionCheckResponse,
} from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { isRunTokenContext } from '../mcp/proxy-utils';
import { logHandlerError } from '../utils';

/**
 * The sandbox supplies the runtime trigger and workspace evidence; what was
 * asked is read from the transcript server-side, and the judgment model key
 * never leaves the API. Every non-verdict outcome is `skipped` so the harness
 * completes the turn normally.
 */
export async function checkTaskCompletion(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth').authContext;

  if (!isRunTokenContext(auth)) {
    return c.json({ error: 'Completion checks require a task run token' }, 403);
  }

  const runId = Number(c.req.param('runId'));

  if (!Number.isInteger(runId) || runId <= 0) {
    return c.json({ error: 'Invalid task run id' }, 400);
  }

  if (auth.runId !== runId) {
    return c.json(
      { error: 'Task run token does not match requested task run' },
      403,
    );
  }

  const parsed = taskCompletionCheckRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  );

  if (!parsed.success) {
    return c.json(
      { error: 'Invalid completion check', issues: parsed.error.issues },
      400,
    );
  }

  try {
    const taskRun = await db.query.taskRuns.findFirst({
      columns: { taskId: true, actingUserId: true },
      where: eq(taskRuns.id, runId),
    });

    if (!taskRun) {
      return c.json({ error: 'Task run not found' }, 404);
    }

    const result: TaskCompletionCheckResponse =
      await evaluateTaskCompletionGate({
        taskId: taskRun.taskId,
        userId: taskRun.actingUserId,
        check: parsed.data,
      });

    return c.json(result);
  } catch (error) {
    logHandlerError('checkTaskCompletion', error);
    return c.json({ error: 'Failed to check task completion' }, 500);
  }
}
