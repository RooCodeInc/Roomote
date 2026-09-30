import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  buildManageCustomAutomationsRequest,
  compactManageCustomAutomationsResult,
  getManageCustomAutomationsTool,
  type ManageCustomAutomationsInput,
} from '@roomote/types';

import { isDeploymentExperimentEnabled } from '@roomote/db/server';

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
  launchCriteriaEnabled: boolean,
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

  return toolResultFromApi({
    ...result,
    payload: compactManageCustomAutomationsResult(
      params.action,
      result.payload,
      { includeLaunchCriteria: launchCriteriaEnabled },
    ),
  });
}

export async function registerRoomoteCustomAutomationsTool(
  server: McpServer,
  auth: McpAuth,
): Promise<void> {
  let launchCriteriaEnabled = false;
  try {
    launchCriteriaEnabled = await isDeploymentExperimentEnabled(
      'automationLaunchCriteria',
    );
  } catch (error) {
    console.warn(
      `[MCP] Could not read custom automation launch-criteria experiment; hiding its fields: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const tool = getManageCustomAutomationsTool(launchCriteriaEnabled);
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    },
    (params: ManageCustomAutomationsInput) =>
      invokeManageCustomAutomations(auth, params, launchCriteriaEnabled),
  );
}
