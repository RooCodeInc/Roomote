import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

import {
  createOrUpdateSourceControlPullRequestForCloudJob,
  findCloudJobForSourceControlMutation,
  readSourceControlPullRequestForCloudJob,
  sourceControlPullRequestMutationInputSchema,
  sourceControlPullRequestReadInputSchema,
  sourceControlPullRequestWriteInputSchema,
  SourceControlMutationError,
  SourceControlReadError,
  SourceControlWriteError,
  writeSourceControlPullRequestForCloudJob,
} from '@roomote/sdk/server';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import {
  assertCloudJobTokenJobExists,
  isJobTokenContext,
  McpProxyError,
} from '../mcp/proxy-utils';
import { logHandlerError } from '../utils';

/**
 * POST /api/mcp/tasks/:taskId/source_control
 *
 * Mutate source-control state for the currently authenticated cloud job.
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

  if (!isJobTokenContext(auth.authContext)) {
    return c.json(
      { error: 'Source control mutations require a cloud job token' },
      403,
    );
  }

  try {
    await assertCloudJobTokenJobExists(auth.authContext);

    const input = z
      .union([
        sourceControlPullRequestMutationInputSchema,
        sourceControlPullRequestReadInputSchema,
        sourceControlPullRequestWriteInputSchema,
      ])
      .parse(await c.req.json());
    const cloudJob = await findCloudJobForSourceControlMutation({
      cloudJobId: auth.authContext.cloudJobId,
      taskId,
    });

    switch (input.action) {
      case 'create_or_update_pull_request':
        return c.json(
          await createOrUpdateSourceControlPullRequestForCloudJob({
            cloudJob,
            input,
          }),
        );
      case 'get_pull_request':
      case 'list_pull_request_comments':
        return c.json(
          await readSourceControlPullRequestForCloudJob({
            cloudJob,
            input,
          }),
        );
      case 'reply_to_pull_request_comment':
      case 'create_pull_request_comment':
      case 'resolve_pull_request_thread':
      case 'submit_pull_request_review':
      case 'update_pull_request_comment':
        return c.json(
          await writeSourceControlPullRequestForCloudJob({
            cloudJob,
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
