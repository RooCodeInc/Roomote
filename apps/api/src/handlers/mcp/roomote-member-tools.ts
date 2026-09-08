import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  resolveRepositoryRow,
  writeSourceControlPullRequestForRepository,
} from '@roomote/sdk/server';

import {
  ALL_REPOSITORIES,
  ROOMOTE_MANAGEMENT_TOOL_DESCRIPTION,
  ROOMOTE_MANAGEMENT_ACTION_DESCRIPTION,
  ROOMOTE_MEMBER_MANAGEMENT_ACTIONS,
  getRoomoteSearchStatusError,
  resolveRoomoteCommunicationTarget,
  roomoteManagementFieldSchemas,
  shouldSearchTasks,
} from '@roomote/types';

import { environmentsRouter } from '../environments';
import { tasksRouter } from '../tasks';
import { sessionsRouter } from '../sessions';
import {
  invokeInProcessApi,
  toolError,
  toolResultFromApi as resultFromApi,
  type InProcessApiResult,
} from './in-process-api';
import type { McpAuth } from './middleware';
import { toMcpToolResult } from './proxy-utils';

function invokeMemberApi(
  auth: McpAuth,
  path: string,
  init?: RequestInit,
): Promise<InProcessApiResult> {
  return invokeInProcessApi({
    auth,
    mount: (app) => {
      app.route('/tasks', tasksRouter);
      app.route('/sessions', sessionsRouter);
      app.route('/environments', environmentsRouter);
    },
    path,
    init,
  });
}

const manageTasksInputSchema = {
  action: z
    .enum(ROOMOTE_MEMBER_MANAGEMENT_ACTIONS)
    .describe(ROOMOTE_MANAGEMENT_ACTION_DESCRIPTION),
  ...roomoteManagementFieldSchemas,
} satisfies Record<string, z.ZodTypeAny>;

const manageSourceControlInputSchema = z
  .object({
    action: z.enum([
      'update_pull_request_metadata',
      'create_pull_request_comment',
      'update_pull_request_comment',
      'reply_to_pull_request_comment',
    ]),
    sourceControlProvider: z.enum(['github', 'gitlab', 'bitbucket']),
    repositoryFullName: z.string().trim().min(1),
    prNumber: z.number().int().positive(),
    title: z.string().trim().min(1).optional(),
    body: z.string().optional(),
    state: z.enum(['open', 'closed']).optional(),
    commentId: z.string().trim().min(1).optional(),
    threadId: z.string().trim().min(1).optional(),
  })
  .strict();

export function registerRoomoteMemberTools(
  server: McpServer,
  auth: McpAuth,
): void {
  server.registerTool(
    'manage_source_control',
    {
      title: 'Manage Pull Request Metadata and Comments',
      description:
        'Update an existing PR/MR title, body, or open/closed state, or create, update, or reply to its discussion comments in an active connected repository. Requires a member user token, not a task run token. Metadata updates require at least one of title/body/state. Comment actions require body; updates require commentId and replies require threadId. Provider limitations are returned as applied:false with warnings. No merging, branch changes, code writes, reviews, or administration.',
      inputSchema: manageSourceControlInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      // Match the userOnly repository-write boundary; never synthesize a task actor.
      if (
        auth.authContext.tokenType !== 'auth' ||
        !auth.userId ||
        auth.userId !== auth.authContext.userId
      ) {
        return toolError({
          error:
            'Source control writes require an authenticated member user token.',
        });
      }
      if (params.action === 'update_pull_request_metadata') {
        if (
          params.title === undefined &&
          params.body === undefined &&
          params.state === undefined
        ) {
          return toolError({
            error:
              'Metadata updates require at least one of title, body, or state.',
          });
        }
        if (params.commentId !== undefined || params.threadId !== undefined) {
          return toolError({
            error: 'Comment identifiers are not accepted for metadata updates.',
          });
        }
      } else {
        if (
          !params.body?.trim() ||
          params.title !== undefined ||
          params.state !== undefined
        ) {
          return toolError({
            error:
              'Comment actions require a non-empty body and do not accept title or state.',
          });
        }
        if (
          params.action === 'update_pull_request_comment' &&
          !params.commentId
        ) {
          return toolError({
            error: 'commentId is required for update_pull_request_comment.',
          });
        }
        if (
          params.action === 'reply_to_pull_request_comment' &&
          (!params.threadId || params.commentId !== undefined)
        ) {
          return toolError({
            error: 'Replies require threadId and do not accept commentId.',
          });
        }
        if (
          params.action === 'create_pull_request_comment' &&
          (params.commentId !== undefined || params.threadId !== undefined)
        ) {
          return toolError({
            error: 'Comment creation does not accept comment identifiers.',
          });
        }
      }
      try {
        const repository = await resolveRepositoryRow({
          provider: params.sourceControlProvider,
          repositoryFullName: params.repositoryFullName,
        });
        return toMcpToolResult(
          await writeSourceControlPullRequestForRepository({
            repository,
            input: params,
          }),
        );
      } catch (error) {
        return toolError({
          error:
            error instanceof Error
              ? error.message
              : 'Source control write failed.',
        });
      }
    },
  );
  server.registerTool(
    'manage_tasks',
    {
      title: 'Manage Sessions and Tasks',
      description: ROOMOTE_MANAGEMENT_TOOL_DESCRIPTION,
      inputSchema: manageTasksInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      switch (params.action) {
        case 'start': {
          if (!params.message?.trim()) {
            return toolError({
              error: 'message is required for start',
            });
          }
          return resultFromApi(
            await invokeMemberApi(auth, '/sessions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: params.message }),
            }),
          );
        }
        case 'search': {
          const statusError = getRoomoteSearchStatusError({
            action: 'search',
            pullRequest: params.pullRequest,
            status: params.status,
          });
          if (statusError) return toolError({ error: statusError });
          if (
            shouldSearchTasks({
              action: 'search',
              pullRequest: params.pullRequest,
              status: params.status,
            })
          ) {
            const query = new URLSearchParams();
            if (params.query) query.set('query', params.query);
            if (params.status) query.set('status', params.status);
            if (params.pullRequest) {
              query.set('pullRequest', params.pullRequest);
            }
            if (params.limit) {
              query.set('limit', String(Math.min(params.limit, 100)));
            }
            if (params.cursor) query.set('cursor', params.cursor);
            const suffix = query.size > 0 ? `?${query.toString()}` : '';
            return resultFromApi(
              await invokeMemberApi(auth, `/tasks${suffix}`),
            );
          }
          const query = new URLSearchParams();
          if (params.query) query.set('query', params.query);
          if (params.status) query.set('status', params.status);
          if (params.limit)
            query.set('limit', String(Math.min(params.limit, 100)));
          if (params.cursor) query.set('cursor', params.cursor);
          const suffix = query.size > 0 ? `?${query.toString()}` : '';
          return resultFromApi(
            await invokeMemberApi(auth, `/sessions${suffix}`),
          );
        }
        case 'search_tasks': {
          const statusError = getRoomoteSearchStatusError({
            action: 'search_tasks',
            status: params.status,
          });
          if (statusError) return toolError({ error: statusError });
          const query = new URLSearchParams();
          if (params.query) query.set('query', params.query);
          if (params.status) query.set('status', params.status);
          if (params.pullRequest) query.set('pullRequest', params.pullRequest);
          if (params.limit)
            query.set('limit', String(Math.min(params.limit, 100)));
          if (params.cursor) query.set('cursor', params.cursor);
          const suffix = query.size > 0 ? `?${query.toString()}` : '';
          return resultFromApi(await invokeMemberApi(auth, `/tasks${suffix}`));
        }
        case 'get_summary':
        case 'get_messages':
        case 'get_updates': {
          const target = resolveRoomoteCommunicationTarget(params);
          if (!target) {
            return toolError({
              error: `sessionId is required for ${params.action} when taskId is omitted`,
            });
          }
          if (target.kind === 'task') {
            const actionPath =
              params.action === 'get_summary'
                ? 'summary'
                : params.action === 'get_messages'
                  ? 'messages'
                  : 'updates';
            const query = new URLSearchParams();
            if (params.action === 'get_messages') {
              query.set('order', 'desc');
              if (params.limit) query.set('limit', String(params.limit));
            } else if (params.action === 'get_updates') {
              if (params.limit) query.set('limit', String(params.limit));
              if (params.cursor) query.set('cursor', params.cursor);
            }
            const suffix = query.size > 0 ? `?${query.toString()}` : '';
            return resultFromApi(
              await invokeMemberApi(
                auth,
                `/tasks/${encodeURIComponent(target.id)}/${actionPath}${suffix}`,
              ),
            );
          }
          const actionPath =
            params.action === 'get_summary'
              ? 'summary'
              : params.action === 'get_messages'
                ? 'messages'
                : 'updates';
          const query = new URLSearchParams();
          if (params.action === 'get_messages') {
            query.set('order', 'desc');
            if (params.limit) query.set('limit', String(params.limit));
          } else if (params.action === 'get_updates') {
            if (params.limit) query.set('limit', String(params.limit));
            if (params.cursor) query.set('cursor', params.cursor);
          }
          const suffix = query.size > 0 ? `?${query.toString()}` : '';
          return resultFromApi(
            await invokeMemberApi(
              auth,
              `/sessions/${encodeURIComponent(target.id)}/${actionPath}${suffix}`,
            ),
          );
        }
        case 'get_compute_logs': {
          if (!params.taskId?.trim()) {
            return toolError({
              error: 'taskId is required for get_compute_logs',
            });
          }
          return resultFromApi(
            await invokeMemberApi(
              auth,
              `/tasks/${encodeURIComponent(params.taskId)}/compute_logs`,
            ),
          );
        }
        case 'launch': {
          if (!params.prompt?.trim()) {
            return toolError({ error: 'prompt is required for launch' });
          }
          if (!params.environmentId?.trim()) {
            return toolError({
              error:
                'environmentId is required for launch; call list_environments first',
            });
          }
          return resultFromApi(
            await invokeMemberApi(auth, '/tasks', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                prompt: params.prompt,
                repo: ALL_REPOSITORIES,
                branch: params.branch,
                environmentId:
                  params.environmentId === ALL_REPOSITORIES
                    ? undefined
                    : params.environmentId,
                type: 'standard',
                notifyOnSettle: params.notifyOnSettle,
              }),
            }),
          );
        }
        case 'cancel': {
          if (!params.taskId?.trim()) {
            return toolError({ error: 'taskId is required for cancel' });
          }
          return resultFromApi(
            await invokeMemberApi(
              auth,
              `/tasks/${encodeURIComponent(params.taskId)}/cancel`,
              { method: 'POST' },
            ),
          );
        }
        case 'send_message': {
          if (!params.message?.trim()) {
            return toolError({ error: 'message is required for send_message' });
          }
          const target = resolveRoomoteCommunicationTarget(params);
          if (!target) {
            return toolError({
              error:
                'sessionId is required for send_message when taskId is omitted',
            });
          }
          return resultFromApi(
            await invokeMemberApi(
              auth,
              `/${target.kind === 'task' ? 'tasks' : 'sessions'}/${encodeURIComponent(target.id)}/send_message`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: params.message }),
              },
            ),
          );
        }
        case 'list_environments': {
          const result = await invokeMemberApi(auth, '/environments');
          if (!result.ok) return resultFromApi(result);
          const environments = Array.isArray(result.payload.environments)
            ? result.payload.environments
            : [];
          return toMcpToolResult({
            instructions:
              'Call launch with one of these environmentId values. Do not invent an environmentId.',
            environments: [
              {
                environmentId: ALL_REPOSITORIES,
                name: 'All repositories',
                description: 'Run the task against all repositories',
              },
              ...environments.map((environment) => {
                const value = environment as {
                  id?: unknown;
                  name?: unknown;
                  description?: unknown;
                };
                return {
                  environmentId: value.id,
                  name: value.name,
                  description: value.description,
                };
              }),
            ],
          });
        }
      }
    },
  );
}
