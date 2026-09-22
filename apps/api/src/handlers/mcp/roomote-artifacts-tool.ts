import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OPEN_ARTIFACT_TOOL } from '@roomote/types';

import { artifactMcpRouter } from './artifacts';
import { invokeInProcessApi, toolResultFromApi } from './in-process-api';
import type { McpAuth } from './middleware';

export function registerRoomoteArtifactTool(
  server: McpServer,
  auth: McpAuth,
): void {
  server.registerTool(
    OPEN_ARTIFACT_TOOL.name,
    {
      title: OPEN_ARTIFACT_TOOL.title,
      description: OPEN_ARTIFACT_TOOL.description,
      inputSchema: z.object(OPEN_ARTIFACT_TOOL.inputSchema).strict(),
      annotations: OPEN_ARTIFACT_TOOL.annotations,
    },
    async (params) =>
      toolResultFromApi(
        await invokeInProcessApi({
          auth,
          mount: (app) => app.route('/artifacts', artifactMcpRouter),
          path: '/artifacts/open',
          init: {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(params),
          },
        }),
      ),
  );
}
