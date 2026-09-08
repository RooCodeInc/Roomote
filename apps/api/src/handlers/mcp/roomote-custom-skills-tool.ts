import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CREATE_CUSTOM_SKILL_TOOL } from '@roomote/types';
import { customSkillsRouter } from '../custom-skills';
import { invokeInProcessApi, toolResultFromApi } from './in-process-api';
import type { McpAuth } from './middleware';

export function registerRoomoteCustomSkillsTool(
  server: McpServer,
  auth: McpAuth,
): void {
  const { name, ...config } = CREATE_CUSTOM_SKILL_TOOL;
  // A raw shape makes the SDK strip unknown inputs before route validation.
  server.registerTool(
    name,
    {
      ...config,
      inputSchema: z.object(config.inputSchema).strict(),
    },
    async (params) =>
      toolResultFromApi(
        await invokeInProcessApi({
          auth,
          mount: (app) => app.route('/custom-skills', customSkillsRouter),
          path: '/custom-skills',
          init: {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(params),
          },
        }),
      ),
  );
}
