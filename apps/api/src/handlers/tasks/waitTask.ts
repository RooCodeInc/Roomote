import type { Context } from 'hono';
import { z } from 'zod';

import { clearTaskWaitSchedule, scheduleTaskWait } from '@roomote/db/server';
import {
  enqueueTaskWake,
  removeTaskWake,
  scheduleTaskSleep,
} from '@roomote/sdk/server';
import { MAX_TASK_WAIT_MS, MIN_TASK_WAIT_MS } from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { isRunTokenContext } from '../mcp/proxy-utils';
import { logHandlerError } from '../utils';

const waitTaskSchema = z.object({
  delaySeconds: z
    .number()
    .int()
    .min(MIN_TASK_WAIT_MS / 1_000)
    .max(MAX_TASK_WAIT_MS / 1_000),
  reason: z.string().trim().min(1).max(2_000),
});

export async function waitTask(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth').authContext;
  if (!isRunTokenContext(auth)) {
    return c.json({ error: 'Waiting requires a task run token' }, 403);
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

  try {
    const input = waitTaskSchema.parse(await c.req.json());
    const result = await scheduleTaskWait({
      runId,
      delayMs: input.delaySeconds * 1_000,
      reason: input.reason,
    });

    const isExistingWait =
      !result.scheduled &&
      result.reason === 'already_waiting' &&
      result.waitUntil !== null;
    if (!result.scheduled && !isExistingWait) {
      return c.json(result, result.reason === 'invalid_duration' ? 400 : 409);
    }

    const waitUntil = result.waitUntil;
    if (!waitUntil) {
      return c.json({ error: 'Task wait is missing a wake deadline' }, 500);
    }

    try {
      await enqueueTaskWake({
        runId,
        waitUntil: waitUntil.toISOString(),
      });
      if (result.scheduled || result.sleepRequired) {
        await scheduleTaskSleep({ runId });
      }
    } catch (error) {
      if (result.scheduled) {
        await clearTaskWaitSchedule({
          runId,
          waitUntil,
          ...(result.goalRollback ? { goalRollback: result.goalRollback } : {}),
        });
        try {
          await removeTaskWake(runId);
        } catch (cleanupError) {
          logHandlerError('waitTask wake cleanup', cleanupError);
        }
      }
      throw error;
    }

    return c.json({
      scheduled: true,
      waitUntil: waitUntil.toISOString(),
      ...(isExistingWait ? { alreadyScheduled: true } : {}),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(
        { error: error.issues[0]?.message ?? 'Invalid input' },
        400,
      );
    }
    logHandlerError('waitTask', error);
    return c.json({ error: 'Failed to schedule task wait' }, 500);
  }
}
