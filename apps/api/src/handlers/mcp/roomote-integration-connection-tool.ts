import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { prepareIntegrationConnection } from '@roomote/sdk/server';
import { PREPARE_INTEGRATION_CONNECTION_TOOL } from '@roomote/types';

export function registerRoomoteIntegrationConnectionTool(
  server: McpServer,
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
}
