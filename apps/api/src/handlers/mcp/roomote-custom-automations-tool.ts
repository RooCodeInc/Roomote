import { Hono } from 'hono';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  MANAGE_CUSTOM_AUTOMATIONS_TOOL,
  type ManageCustomAutomationsInput,
} from '@roomote/types';

import type { Variables } from '../../types';
import { customAutomationsRouter } from '../custom-automations';
import type { McpAuth } from './middleware';
import { toMcpToolResult } from './proxy-utils';

function toolError(payload: Record<string, unknown>) {
  return { ...toMcpToolResult(payload), isError: true as const };
}

async function invokeCustomAutomationsApi(
  auth: McpAuth,
  path: string,
  init?: RequestInit,
) {
  const app = new Hono<{
    Variables: Variables & { mcpAuth: McpAuth };
  }>();
  app.use('*', async (c, next) => {
    c.set('authContext', auth.authContext);
    c.set('mcpAuth', auth);
    await next();
  });
  app.route('/custom-automations', customAutomationsRouter);

  const response = await app.request(
    `http://roomote.internal/custom-automations${path}`,
    init,
  );
  const rawPayload: unknown = await response.json();
  const payload =
    rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>)
      : { result: rawPayload };

  return response.ok
    ? toMcpToolResult(payload)
    : toolError({ status: response.status, ...payload });
}

function jsonRequest(method: 'POST' | 'PATCH', body: Record<string, unknown>) {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function invokeManageCustomAutomations(
  auth: McpAuth,
  params: ManageCustomAutomationsInput,
) {
  switch (params.action) {
    case 'list':
      return invokeCustomAutomationsApi(auth, '');
    case 'list_models':
      return invokeCustomAutomationsApi(auth, '/models');
    case 'resolve_schedule':
      return params.schedule
        ? invokeCustomAutomationsApi(
            auth,
            '/resolve-schedule',
            jsonRequest('POST', { schedule: params.schedule }),
          )
        : toolError({ error: 'schedule is required' });
    case 'create': {
      const required = ['name', 'prompt', 'schedule', 'environmentId'] as const;
      const missing = required.find((key) => !params[key]);
      if (missing) return toolError({ error: `${missing} is required` });
      return invokeCustomAutomationsApi(
        auth,
        '',
        jsonRequest('POST', {
          name: params.name,
          prompt: params.prompt,
          enabled: params.enabled ?? true,
          schedule: params.schedule,
          model: params.model,
          environmentId: params.environmentId,
          targetProvider: params.targetProvider,
          targetMode: params.targetMode,
          targetChannelId: params.targetChannelId,
          targetServiceUrl: params.targetServiceUrl,
        }),
      );
    }
    case 'update': {
      if (!params.automationId) {
        return toolError({ error: 'automationId is required for update' });
      }
      const body = Object.fromEntries(
        Object.entries({
          name: params.name,
          prompt: params.prompt,
          enabled: params.enabled,
          schedule: params.schedule,
          model: params.model,
          environmentId: params.environmentId,
          targetProvider: params.targetProvider,
          targetMode: params.targetMode,
          targetChannelId: params.targetChannelId,
          targetServiceUrl: params.targetServiceUrl,
        }).filter((entry) => entry[1] !== undefined),
      );
      return invokeCustomAutomationsApi(
        auth,
        `/${encodeURIComponent(params.automationId)}`,
        jsonRequest('PATCH', body),
      );
    }
    case 'delete':
    case 'run_now':
      if (!params.automationId) {
        return toolError({
          error: `automationId is required for ${params.action}`,
        });
      }
      return invokeCustomAutomationsApi(
        auth,
        `/${encodeURIComponent(params.automationId)}${params.action === 'run_now' ? '/run' : ''}`,
        { method: params.action === 'delete' ? 'DELETE' : 'POST' },
      );
  }
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
