import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { RoomoteTaskClient } from './roomote-client.js';

export function createToolHandlers(client: RoomoteTaskClient) {
  return {
    listEnvironments: () =>
      client.callManageTasks({ action: 'list_environments' }),
    launchTask: (params: {
      prompt: string;
      environmentId: string;
      branch?: string;
      notifyOnSettle?: boolean;
    }) => client.callManageTasks({ action: 'launch', ...params }),
    getTaskStatus: (params: { taskId: string }) =>
      client.callManageTasks({ action: 'get_summary', ...params }),
    sendFollowUp: (params: { taskId: string; message: string }) =>
      client.callManageTasks({ action: 'send_message', ...params }),
  };
}

export function createRoomoteMcpServer(client: RoomoteTaskClient): McpServer {
  const server = new McpServer({
    name: 'roomote-stdio-mcp-server',
    version: '0.0.3',
  });
  const handlers = createToolHandlers(client);

  server.registerTool(
    'list_environments',
    {
      title: 'List Roomote Environments',
      description:
        'List the Roomote environments available to the authenticated user. Call this immediately before launch_task.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handlers.listEnvironments,
  );

  server.registerTool(
    'launch_task',
    {
      title: 'Launch Roomote Task',
      description:
        'Launch a Roomote task in an environment returned by list_environments.',
      inputSchema: {
        prompt: z.string().min(1),
        environmentId: z.string().min(1),
        branch: z.string().min(1).optional(),
        notifyOnSettle: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    handlers.launchTask,
  );

  server.registerTool(
    'get_task_status',
    {
      title: 'Get Roomote Task Status',
      description:
        'Get the latest summary and status for a Roomote task by task ID.',
      inputSchema: {
        taskId: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handlers.getTaskStatus,
  );

  server.registerTool(
    'send_follow_up',
    {
      title: 'Send Roomote Task Follow-up',
      description: 'Send a follow-up message to an existing Roomote task.',
      inputSchema: {
        taskId: z.string().min(1),
        message: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    handlers.sendFollowUp,
  );

  return server;
}
