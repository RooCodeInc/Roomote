import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { appRouter, prepareIntegrationConnection } from '@roomote/sdk/server';
import {
  MANAGE_INTEGRATION_CONNECTION_TOOL,
  PREPARE_INTEGRATION_CONNECTION_TOOL,
} from '@roomote/types';
import type { McpAuth } from './middleware';

export function registerRoomoteIntegrationConnectionTool(
  server: McpServer,
  auth: McpAuth,
): void {
  server.registerTool(
    PREPARE_INTEGRATION_CONNECTION_TOOL.name,
    PREPARE_INTEGRATION_CONNECTION_TOOL,
    async (input) => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(prepareIntegrationConnection(input)),
        },
      ],
    }),
  );
  server.registerTool(
    MANAGE_INTEGRATION_CONNECTION_TOOL.name,
    MANAGE_INTEGRATION_CONNECTION_TOOL,
    async (input) => {
      try {
        const result = await appRouter
          .createCaller({ auth: auth.authContext })
          .mcpConnections.manageConnection(input);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'Integration connection operation failed. Admin access and valid input are required.',
            },
          ],
        };
      }
    },
  );
}
