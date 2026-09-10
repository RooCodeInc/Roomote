import type { Context } from 'hono';
import { z } from 'zod';

import {
  appendLearnedUserPreference,
  db,
  eq,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { isRunTokenContext } from '../mcp/proxy-utils';
import { logHandlerError } from '../utils';

const inputSchema = z.object({
  preference: z.string().trim().min(1).max(500),
  confidence: z.enum(['explicit', 'inferred']),
});

const EXCLUDED_PERSONALIZATION_PAYLOADS = new Set<TaskPayloadKind>([
  TaskPayloadKind.Scan,
  TaskPayloadKind.McpRecommendations,
  TaskPayloadKind.SnapshotEnvironment,
]);

export function canLearnPersonalizationForRun(run: {
  actingUserId: string | null;
  initiatorKind: string;
  payloadKind: TaskPayloadKind;
}): run is typeof run & { actingUserId: string } {
  return (
    Boolean(run.actingUserId) &&
    run.initiatorKind === 'user' &&
    !EXCLUDED_PERSONALIZATION_PAYLOADS.has(run.payloadKind)
  );
}

export async function updatePersonalization(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth').authContext;
  if (!isRunTokenContext(auth)) {
    return c.json(
      { error: 'Personalization updates require a task run token' },
      403,
    );
  }

  const runId = Number(c.req.param('runId'));
  if (!Number.isInteger(runId) || runId <= 0 || auth.runId !== runId) {
    return c.json(
      { error: 'Task run token does not match requested task run' },
      403,
    );
  }

  const parsed = inputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: 'Invalid personalization update' }, 400);

  try {
    const [run] = await db
      .select({
        actingUserId: taskRuns.actingUserId,
        payloadKind: taskRuns.payloadKind,
        initiatorKind: tasks.initiatorKind,
      })
      .from(taskRuns)
      .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
      .where(eq(taskRuns.id, runId))
      .limit(1);

    if (!run || !canLearnPersonalizationForRun(run)) {
      return c.json({ saved: false, reason: 'not_human_initiated' }, 200);
    }

    const result = await appendLearnedUserPreference({
      userId: run.actingUserId,
      ...parsed.data,
    });
    return c.json(result, 200);
  } catch (error) {
    logHandlerError('updatePersonalization', error);
    return c.json({ error: 'Failed to update personalization' }, 500);
  }
}
