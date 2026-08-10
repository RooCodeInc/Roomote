import type { Context } from 'hono';
import { TRPCClientError } from '@trpc/client';

import { getDeploymentTaskModelOptions } from '@roomote/db/server';
import { isExitedRunStatus } from '@roomote/types';
import { withSandboxServerRpcClient } from '@roomote/sdk/server';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { findLatestTaskRun } from './helpers';
import { logHandlerError } from '../utils';

type SwitchModelBody = {
  model?: unknown;
};

/**
 * POST /api/tasks/:taskId/switch_model
 *
 * Change the model a running task uses for subsequent turns. The in-flight
 * turn is left to finish on the previous model.
 *
 * Requested models are checked against the deployment's enabled catalog here,
 * and against what the sandbox can actually resolve inside the sandbox
 * procedure. The launch API intentionally accepts arbitrary model strings; that
 * looseness is not repeated on this path.
 */
export async function switchTaskModel(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth');

  if (!auth.userId) {
    return c.json({ error: 'User context required' }, 403);
  }

  const taskId = c.req.param('taskId');

  if (!taskId?.trim()) {
    return c.json({ error: 'taskId is required' }, 400);
  }

  let body: SwitchModelBody;

  try {
    body = (await c.req.json()) as SwitchModelBody;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const model = typeof body.model === 'string' ? body.model.trim() : '';

  if (!model) {
    return c.json({ error: 'model is required' }, 400);
  }

  try {
    const { models } = await getDeploymentTaskModelOptions();

    if (!models.some((option) => option.id === model)) {
      return c.json(
        {
          success: false,
          error: `Model "${model}" is not enabled for this deployment`,
        },
        400,
      );
    }

    const run = await findLatestTaskRun(taskId, {
      id: true,
      status: true,
      sandboxServerUrl: true,
      actingUserId: true,
    });

    if (!run) {
      return c.json({ success: false, error: 'Task not found' }, 404);
    }

    if (isExitedRunStatus(run.status)) {
      return c.json(
        {
          success: false,
          error: `Task is not running: ${run.status}`,
        },
        409,
      );
    }

    if (!run.sandboxServerUrl) {
      return c.json(
        {
          success: false,
          error: 'Task has no active sandbox to switch models on',
        },
        409,
      );
    }

    const result = await withSandboxServerRpcClient({
      runId: run.id,
      userId: auth.userId ?? run.actingUserId ?? null,
      sandboxServerUrl: run.sandboxServerUrl,
      call: (client) => client.commands.switchModel.mutate({ model }),
    });

    return c.json(result);
  } catch (error) {
    if (error instanceof TRPCClientError) {
      // The sandbox rejects models its runtime cannot resolve. That is a
      // capability answer about this run, not an infrastructure fault, so it
      // must not be reported as a 502.
      const status =
        resolveSandboxRejectionStatus(error) === 'client_error' ? 409 : 502;

      return c.json(
        {
          success: false,
          error:
            status === 409 ? error.message : `Sandbox error: ${error.message}`,
        },
        status,
      );
    }

    logHandlerError('switchTaskModel', error);
    return c.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : 'Failed to switch the model',
      },
      500,
    );
  }
}

/**
 * Distinguish a deliberate sandbox rejection (bad request, unmet
 * precondition) from a transport or runtime failure, so the caller sees an
 * actionable status instead of a generic bad-gateway.
 */
function resolveSandboxRejectionStatus(
  error: TRPCClientError<never>,
): 'client_error' | 'server_error' {
  const code = (error.data as { code?: unknown } | undefined)?.code;

  return code === 'BAD_REQUEST' || code === 'PRECONDITION_FAILED'
    ? 'client_error'
    : 'server_error';
}
