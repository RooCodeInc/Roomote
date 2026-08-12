import type { Context } from 'hono';
import { z } from 'zod';

import {
  TaskModelSelectionError,
  applyTaskModelSelectionToRun,
} from '@roomote/cloud-agents/server';
import { withSandboxServerRpcClient } from '@roomote/sdk/server';
import { REASONING_EFFORT_VALUES, isExitedRunStatus } from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { findLatestTaskRun } from './helpers';
import { logHandlerError } from '../utils';

const updateModelSelectionBodySchema = z.object({
  role: z.enum([
    'coding',
    'helper',
    'vision',
    'codeReview',
    'explore',
    'planning',
  ]),
  /** Desired model id, or null/omitted for the deployment default. */
  model: z.string().trim().min(1).nullish(),
  /** Desired reasoning level, or null/omitted for the deployment level. */
  reasoningEffort: z.enum(REASONING_EFFORT_VALUES).nullish(),
});

/**
 * POST /api/tasks/:taskId/model_selection
 *
 * Update one model role for a task (agent-facing surface of the in-task
 * model switcher). Persists the selection on the task's latest run and asks
 * the live sandbox to apply it; from a running turn the change applies at
 * the next turn boundary.
 */
export async function updateTaskModelSelection(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const taskId = c.req.param('taskId');

  if (!taskId?.trim()) {
    return c.json({ error: 'taskId is required' }, 400);
  }

  const parsedBody = updateModelSelectionBodySchema.safeParse(
    await c.req.json().catch(() => null),
  );

  if (!parsedBody.success) {
    return c.json(
      {
        success: false,
        error: parsedBody.error.issues[0]?.message ?? 'Invalid request body',
      },
      400,
    );
  }

  try {
    const run = await findLatestTaskRun(taskId, {
      id: true,
      status: true,
      sandboxServerUrl: true,
      actingUserId: true,
    });

    if (!run) {
      return c.json({ success: false, error: 'Task not found' }, 404);
    }

    await applyTaskModelSelectionToRun({
      runId: run.id,
      role: parsedBody.data.role,
      model: parsedBody.data.model ?? null,
      reasoningEffort: parsedBody.data.reasoningEffort ?? null,
    });

    let application: 'restarted' | 'deferred' | 'unavailable' | 'offline' =
      'offline';

    if (run.sandboxServerUrl && !isExitedRunStatus(run.status)) {
      try {
        const result = await withSandboxServerRpcClient({
          runId: run.id,
          userId: run.actingUserId ?? null,
          sandboxServerUrl: run.sandboxServerUrl,
          call: (client) => client.commands.applyTaskModelSettings.mutate(),
        });

        application = result.application;
      } catch (error) {
        // The selection is persisted; a failed live apply only means it
        // takes effect at the next resume instead of the next turn.
        logHandlerError('updateTaskModelSelection.liveApply', error);
      }
    }

    return c.json({ success: true, application });
  } catch (error) {
    if (error instanceof TaskModelSelectionError) {
      const status =
        error.code === 'run_not_found'
          ? 404
          : error.code === 'payload_missing'
            ? 409
            : 400;

      return c.json({ success: false, error: error.message }, status);
    }

    logHandlerError('updateTaskModelSelection', error);
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to update the task model selection',
      },
      500,
    );
  }
}
