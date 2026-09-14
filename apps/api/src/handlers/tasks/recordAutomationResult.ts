import type { Context } from 'hono';
import { z } from 'zod';

import {
  db,
  eq,
  recordAutomationResultForTask,
  taskRuns,
} from '@roomote/db/server';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { isRunTokenContext } from '../mcp/proxy-utils';

const bodySchema = z.object({
  content: z.string().trim().min(1),
  dedupeKey: z.string().trim().min(1).max(256),
});

export async function recordAutomationResult(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
) {
  const auth = c.get('mcpAuth');
  const taskId = c.req.param('taskId');
  if (!taskId) return c.json({ error: 'taskId is required' }, 400);

  if (!isRunTokenContext(auth.authContext)) {
    return c.json({ error: 'Task access denied' }, 403);
  }

  const tokenRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, auth.authContext.runId),
    columns: { taskId: true },
  });
  if (!tokenRun || tokenRun.taskId !== taskId) {
    return c.json({ error: 'Task access denied' }, 403);
  }

  const body = bodySchema.safeParse(await c.req.json());
  if (!body.success) {
    return c.json({ error: 'Invalid automation result payload' }, 400);
  }

  const result = await recordAutomationResultForTask({
    taskId,
    content: body.data.content,
    dedupeKey: body.data.dedupeKey,
  });

  return c.json({ recorded: Boolean(result) });
}
