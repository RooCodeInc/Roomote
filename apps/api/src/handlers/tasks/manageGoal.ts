import type { Context } from 'hono';
import { z } from 'zod';

import { getTaskGoalForRun, markTaskGoalForRun } from '@roomote/db/server';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { isRunTokenContext } from '../mcp/proxy-utils';
import { logHandlerError } from '../utils';

const goalMutationSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('complete'),
    generation: z.string().max(200).nullable(),
  }),
  z.object({
    action: z.literal('blocked'),
    generation: z.string().max(200).nullable(),
    reason: z.string().trim().min(1).max(2_000),
  }),
]);

function getScopedRunId(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): number | Response {
  const auth = c.get('mcpAuth').authContext;
  if (!isRunTokenContext(auth)) {
    return c.json({ error: 'Goal operations require a task run token' }, 403);
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

  return runId;
}

export async function getGoal(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const runId = getScopedRunId(c);
  if (runId instanceof Response) return runId;

  try {
    return c.json({ goal: await getTaskGoalForRun(runId) });
  } catch (error) {
    logHandlerError('getGoal', error);
    return c.json({ error: 'Failed to get goal' }, 500);
  }
}

export async function manageGoal(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const runId = getScopedRunId(c);
  if (runId instanceof Response) return runId;

  try {
    const input = goalMutationSchema.parse(await c.req.json());
    const result = await markTaskGoalForRun(
      input.action === 'complete'
        ? { runId, generation: input.generation, status: 'complete' }
        : {
            runId,
            generation: input.generation,
            status: 'blocked',
            reason: input.reason,
          },
    );
    return c.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(
        { error: error.issues[0]?.message ?? 'Invalid input' },
        400,
      );
    }
    logHandlerError('manageGoal', error);
    return c.json({ error: 'Failed to update goal' }, 500);
  }
}
