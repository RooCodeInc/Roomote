import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

import {
  createOrUpdateSourceControlPullRequestForTaskRun,
  findTaskRunForSourceControlMutation,
  readSourceControlPullRequestForTaskRun,
  sourceControlPullRequestMutationInputSchema,
  sourceControlPullRequestReadInputSchema,
  sourceControlPullRequestWriteInputSchema,
  SourceControlMutationError,
  SourceControlReadError,
  SourceControlWriteError,
  writeSourceControlPullRequestForTaskRun,
} from '@roomote/sdk/server';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import {
  assertTaskRunTokenTargetExists,
  isRunTokenContext,
  McpProxyError,
} from '../mcp/proxy-utils';
import { logHandlerError } from '../utils';

/**
 * POST /api/mcp/tasks/:taskId/source_control
 *
 * Mutate source-control state for the currently authenticated task run.
 * This keeps provider API tokens server-side while allowing sandboxes to
 * create or refresh provider-neutral PR/MR metadata.
 */
export async function manageSourceControl(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth');
  const taskId = c.req.param('taskId');

  if (!taskId?.trim()) {
    return c.json({ error: 'taskId is required' }, 400);
  }

  if (!isRunTokenContext(auth.authContext)) {
    return c.json(
      { error: 'Source control mutations require a task run token' },
      403,
    );
  }

  try {
    await assertTaskRunTokenTargetExists(auth.authContext);

    const input = z
      .union([
        sourceControlPullRequestMutationInputSchema,
        sourceControlPullRequestReadInputSchema,
        sourceControlPullRequestWriteInputSchema,
      ])
      .parse(await c.req.json());
    const taskRun = await findTaskRunForSourceControlMutation({
      runId: auth.authContext.runId,
      taskId,
    });

    switch (input.action) {
      case 'create_or_update_pull_request':
        return c.json(
          await createOrUpdateSourceControlPullRequestForTaskRun({
            taskRun,
            input,
          }),
        );
      case 'get_pull_request':
      case 'list_pull_request_comments':
      case 'list_pull_requests':
        return c.json(
          await readSourceControlPullRequestForTaskRun({
            taskRun,
            input,
          }),
        );
      case 'reply_to_pull_request_comment':
      case 'create_pull_request_comment':
      case 'resolve_pull_request_thread':
      case 'submit_pull_request_review':
      case 'update_pull_request_comment':
        return c.json(
          await writeSourceControlPullRequestForTaskRun({
            taskRun,
            input,
          }),
        );
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: error.message }, 400);
    }

    if (error instanceof McpProxyError) {
      return c.json(
        { error: error.message },
        { status: error.httpStatus as ContentfulStatusCode },
      );
    }

    if (
      error instanceof SourceControlMutationError ||
      error instanceof SourceControlReadError ||
      error instanceof SourceControlWriteError
    ) {
      return c.json(
        { error: error.message },
        { status: error.httpStatus as ContentfulStatusCode },
      );
    }

    logHandlerError('manageSourceControl', error);
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to manage source control',
      },
      500,
    );
  }
}
