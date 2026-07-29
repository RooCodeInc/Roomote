import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import {
  claimLatestUserMessageForReplyQuote,
  restoreClaimedLatestUserMessageForReplyQuote,
} from '@roomote/communication/messages';
import { resolveSourceControlProviderFromPayload } from '@roomote/types';

import {
  createOrUpdateSourceControlPullRequestForTaskRun,
  findTaskRunForSourceControlMutation,
  manageSourceControlIssueForTaskRun,
  readSourceControlPullRequestForTaskRun,
  sourceControlIssueInputSchema,
  sourceControlPullRequestMutationInputSchema,
  sourceControlPullRequestReadInputSchema,
  sourceControlPullRequestWriteInputSchema,
  SourceControlMutationError,
  SourceControlIssueError,
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

const GITHUB_REPLY_QUOTE_MAX_LENGTH = 280;

function formatGitHubReplyQuote(params: {
  userName: string;
  text: string;
}): string | null {
  const userName = params.userName.replace(/\s+/g, ' ').trim();
  const text = params.text.trim();

  if (!userName || !text) {
    return null;
  }

  const truncated =
    text.length <= GITHUB_REPLY_QUOTE_MAX_LENGTH
      ? text
      : `${text.slice(0, GITHUB_REPLY_QUOTE_MAX_LENGTH - 3).trimEnd()}...`;

  return `> **${userName}:** ${truncated.replaceAll('\n', '\n> ')}`;
}

/**
 * POST /api/mcp/tasks/:taskId/source_control
 *
 * Read or mutate source-control state for the currently authenticated task
 * run. This keeps provider API tokens server-side while allowing sandboxes to
 * operate on provider-neutral issues and pull requests.
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
        sourceControlIssueInputSchema,
      ])
      .parse(await c.req.json());
    const taskRun = await findTaskRunForSourceControlMutation({
      runId: auth.authContext.runId,
      taskId,
    });
    const isGitHubTask =
      resolveSourceControlProviderFromPayload(taskRun.payload) === 'github';
    const bodyInput = 'body' in input ? input : null;
    const shouldQuote =
      isGitHubTask &&
      (input.action === 'reply_to_pull_request_comment' ||
        input.action === 'create_pull_request_comment' ||
        input.action === 'create_issue_comment') &&
      typeof bodyInput?.body === 'string';
    const pendingQuote = shouldQuote
      ? await claimLatestUserMessageForReplyQuote('github', taskRun.id)
      : null;

    if (pendingQuote && typeof bodyInput?.body === 'string') {
      const quote = formatGitHubReplyQuote(pendingQuote);
      if (quote) {
        bodyInput.body = `${quote}\n\n${bodyInput.body}`;
      }
    }

    const restoreQuoteAfterFailure = async () => {
      if (pendingQuote) {
        await restoreClaimedLatestUserMessageForReplyQuote(
          'github',
          taskRun.id,
          pendingQuote,
        );
      }
    };

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
      case 'update_pull_request_comment': {
        try {
          return c.json(
            await writeSourceControlPullRequestForTaskRun({ taskRun, input }),
          );
        } catch (error) {
          await restoreQuoteAfterFailure();
          throw error;
        }
      }
      case 'get_issue':
      case 'list_issue_comments':
      case 'create_issue_comment': {
        try {
          return c.json(
            await manageSourceControlIssueForTaskRun({ taskRun, input }),
          );
        } catch (error) {
          await restoreQuoteAfterFailure();
          throw error;
        }
      }
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
      error instanceof SourceControlIssueError ||
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
