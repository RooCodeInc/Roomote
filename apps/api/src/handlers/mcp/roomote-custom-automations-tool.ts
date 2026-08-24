import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  MANAGE_CUSTOM_AUTOMATIONS_TOOL,
  buildManageCustomAutomationsRequest,
  type ManageCustomAutomationsInput,
} from '@roomote/types';

import { customAutomationsRouter } from '../custom-automations';
import {
  invokeInProcessApi,
  toolError,
  toolResultFromApi,
} from './in-process-api';
import type { McpAuth } from './middleware';

async function invokeManageCustomAutomations(
  auth: McpAuth,
  params: ManageCustomAutomationsInput,
) {
  const built = buildManageCustomAutomationsRequest(params);
  if (!built.ok) {
    return toolError({ error: built.error });
  }

  const { path, method, body } = built.request;
  const result = await invokeInProcessApi({
    auth,
    mount: (app) => app.route('/custom-automations', customAutomationsRouter),
    path: `/custom-automations${path}`,
    init: body
      ? {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : { method },
  });

  return toolResultFromApi(result);
}

export function registerRoomoteCustomAutomationsTool(
  server: McpServer,
  auth: McpAuth,
): void {
  server.registerTool(
    MANAGE_CUSTOM_AUTOMATIONS_TOOL.name,
    {
      title: MANAGE_CUSTOM_AUTOMATIONS_TOOL.title,
      description: MANAGE_CUSTOM_AUTOMATIONS_TOOL.description,
      inputSchema: MANAGE_CUSTOM_AUTOMATIONS_TOOL.inputSchema,
      annotations: MANAGE_CUSTOM_AUTOMATIONS_TOOL.annotations,
    },
    (params) => invokeManageCustomAutomations(auth, params),
  );
}
