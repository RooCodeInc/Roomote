import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  ALL_REPOSITORIES,
  ROOMOTE_MEMBER_MANAGEMENT_TOOL_DESCRIPTION,
  ROOMOTE_MEMBER_MANAGEMENT_ACTION_DESCRIPTION,
  ROOMOTE_MEMBER_MANAGEMENT_ACTIONS,
  getRoomoteSearchStatusError,
  resolveRoomoteCommunicationTarget,
  roomoteManagementFieldSchemas,
  shouldSearchTasks,
  taskOutputFieldSchemas,
} from '@roomote/types';

import { environmentsRouter } from '../environments';
import { tasksRouter } from '../tasks';
import { sessionsRouter } from '../sessions';
import { listMemberModels } from './models';
import {
  invokeInProcessApi,
  toolError,
  toolResultFromApi as resultFromApi,
  type InProcessApiResult,
} from './in-process-api';
import type { McpAuth } from './middleware';
import { toMcpToolResult } from './proxy-utils';
import { taskOutputsRouter } from './task-outputs';

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
      app.route('/task-outputs', taskOutputsRouter);
      app.get('/models', listMemberModels);
    },
    path,
    init,
  });
}

const manageTasksInputSchema = {
  action: z
    .enum(ROOMOTE_MEMBER_MANAGEMENT_ACTIONS)
    .describe(ROOMOTE_MEMBER_MANAGEMENT_ACTION_DESCRIPTION),
  ...roomoteManagementFieldSchemas,
  ...taskOutputFieldSchemas,
  limit: roomoteManagementFieldSchemas.limit.describe(
    'Positive result limit: 1–100 for search/get_updates; 1–100 (default 50) for list_models/get_command_receipts; 1–1000 for get_messages.',
  ),
} satisfies Record<string, z.ZodTypeAny>;

export function registerRoomoteMemberTools(
  server: McpServer,
  auth: McpAuth,
): void {
  server.registerTool(
    'manage_tasks',
    {
      title: 'Manage Sessions and Tasks',
      description: ROOMOTE_MEMBER_MANAGEMENT_TOOL_DESCRIPTION,
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
        case 'list_models': {
          const query = new URLSearchParams();
          if (params.query !== undefined) query.set('query', params.query);
          if (params.limit !== undefined)
            query.set('limit', String(params.limit));
          if (params.cursor !== undefined) query.set('cursor', params.cursor);
          return resultFromApi(await invokeMemberApi(auth, `/models?${query}`));
        }
        case 'list_artifacts':
        case 'get_artifact_download_url':
        case 'get_command_receipts': {
          const input =
            params.action === 'list_artifacts'
              ? {
                  action: params.action,
                  taskId: params.taskId,
                  artifactType: params.artifactType,
                }
              : params.action === 'get_artifact_download_url'
                ? {
                    action: params.action,
                    taskId: params.taskId,
                    path: params.path,
                    version: params.version,
                  }
                : {
                    action: params.action,
                    taskId: params.taskId,
                    limit: params.limit,
                    cursor: params.cursor,
                  };
          return resultFromApi(
            await invokeMemberApi(auth, '/task-outputs/read', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(input),
            }),
          );
        }
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
              body: JSON.stringify({
                message: params.message,
                attachments: params.attachments,
                model: params.model,
                reasoningEffort: params.reasoningEffort,
              }),
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
                body: JSON.stringify({
                  message: params.message,
                  attachments: params.attachments,
                }),
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
