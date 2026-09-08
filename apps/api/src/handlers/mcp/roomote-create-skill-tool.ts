import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CREATE_SKILL_TOOL } from '@roomote/types';

import { customSkillsRouter } from '../custom-skills';
import { invokeInProcessApi, toolResultFromApi } from './in-process-api';
import type { McpAuth } from './middleware';

export function registerRoomoteCreateSkillTool(
  server: McpServer,
  auth: McpAuth,
): void {
  server.registerTool(
    CREATE_SKILL_TOOL.name,
    {
      title: CREATE_SKILL_TOOL.title,
      description: CREATE_SKILL_TOOL.description,
      inputSchema: CREATE_SKILL_TOOL.inputSchema,
      annotations: CREATE_SKILL_TOOL.annotations,
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
