import type { Context } from 'hono';
import { z } from 'zod';

import { recordAutomationResultForTask } from '@roomote/db/server';

import type { Variables } from '../../types';

const bodySchema = z.object({
  content: z.string().trim().min(1),
  dedupeKey: z.string().trim().min(1).max(256),
});

export async function recordAutomationResult(
  c: Context<{ Variables: Variables }>,
) {
  const taskId = c.req.param('taskId');
  if (!taskId) return c.json({ error: 'taskId is required' }, 400);
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
