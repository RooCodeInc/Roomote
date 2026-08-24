import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  ALL_REPOSITORIES,
  PRODUCT_NAME,
  ROOMOTE_TASK_INSPECTION_ACTIONS,
  roomoteTaskInspectionFieldSchemas,
} from '@roomote/types';

import { environmentsRouter } from '../environments';
import { tasksRouter } from '../tasks';
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
      app.route('/environments', environmentsRouter);
    },
    path,
    init,
  });
}

const manageTasksInputSchema = {
  action: z.enum([
    ...ROOMOTE_TASK_INSPECTION_ACTIONS,
    'launch',
    'cancel',
    'send_message',
    'list_environments',
  ]),
  ...roomoteTaskInspectionFieldSchemas,
  message: z.string().optional(),
  prompt: z.string().optional(),
  environmentId: z.string().optional(),
  branch: z.string().optional(),
  notifyOnSettle: z.boolean().optional(),
} satisfies Record<string, z.ZodTypeAny>;

export function registerRoomoteMemberTools(
  server: McpServer,
  auth: McpAuth,
): void {
  server.registerTool(
    'manage_tasks',
    {
      title: 'Manage Tasks',
      description:
        `Manage ${PRODUCT_NAME} tasks as the signed-in member. ` +
        'Use list_environments immediately before launch, search for task history, inspect summaries/messages/compute logs, launch tasks, cancel active tasks, or send follow-up messages.',
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
        case 'search': {
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
        case 'get_compute_logs':
        case 'get_messages': {
          if (!params.taskId?.trim()) {
            return toolError({
              error: `taskId is required for ${params.action}`,
            });
          }
          const actionPath = {
            get_summary: 'summary',
            get_compute_logs: 'compute_logs',
            get_messages: 'messages',
          }[params.action];
          const query = new URLSearchParams();
          if (params.action === 'get_messages') {
            query.set('order', 'desc');
            if (params.limit) query.set('limit', String(params.limit));
          }
          const suffix = query.size > 0 ? `?${query.toString()}` : '';
          return resultFromApi(
            await invokeMemberApi(
              auth,
              `/tasks/${encodeURIComponent(params.taskId)}/${actionPath}${suffix}`,
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
          if (!params.taskId?.trim()) {
            return toolError({ error: 'taskId is required for send_message' });
          }
          if (!params.message?.trim()) {
            return toolError({ error: 'message is required for send_message' });
          }
          return resultFromApi(
            await invokeMemberApi(
              auth,
              `/tasks/${encodeURIComponent(params.taskId)}/send_message`,
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
