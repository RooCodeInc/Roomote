import type { Context } from 'hono';
import { z } from 'zod';

import {
  DIFF_RISK_HINTS_MAX_DIFF_CHARS,
  screenDiffRiskHints,
} from '@roomote/cloud-agents/server';
import { db, eq, tasks, taskRuns } from '@roomote/db/server';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { isRunTokenContext } from '../mcp/proxy-utils';
import { logHandlerError } from '../utils';

const bodySchema = z.object({
  diff: z.string().min(1).max(DIFF_RISK_HINTS_MAX_DIFF_CHARS),
});

/**
 * Risk hints for a task's own diff: the pull request review pre-screen, run
 * before the agent ships. The sandbox sends the diff; the judgment model key
 * stays here.
 */
export async function getDiffRiskHints(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth').authContext;

  if (!isRunTokenContext(auth)) {
    return c.json({ error: 'Diff risk hints require a task run token' }, 403);
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

  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json(
      {
        error: `Invalid request: send the diff as \`diff\` (at most ${DIFF_RISK_HINTS_MAX_DIFF_CHARS} characters).`,
      },
      400,
    );
  }

  try {
    const [row] = await db
      .select({ title: tasks.title })
      .from(taskRuns)
      .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
      .where(eq(taskRuns.id, runId))
      .limit(1);

    if (!row) {
      return c.json({ error: 'Task run not found' }, 404);
    }

    return c.json(
      await screenDiffRiskHints({ title: row.title, diff: parsed.data.diff }),
    );
  } catch (error) {
    logHandlerError('getDiffRiskHints', error);
    return c.json({ error: 'Failed to screen the diff' }, 500);
  }
}
