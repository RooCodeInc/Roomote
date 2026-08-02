import type { RoomoteConfig, ToolResult } from './types.js';
import {
  buildApiHeaders,
  fetchWithTimeout,
  parseApiError,
} from './api-client.js';
import { errorResult } from './tool-result.js';

type ManageCustomAutomationsParams = {
  action:
    | 'list'
    | 'resolve_schedule'
    | 'create'
    | 'update'
    | 'delete'
    | 'run_now';
  automationId?: string;
  name?: string;
  prompt?: string;
  enabled?: boolean;
  schedule?: string;
  environmentId?: string;
  targetProvider?: 'slack' | 'discord' | 'teams' | 'telegram' | null;
  targetChannelId?: string;
  targetServiceUrl?: string;
};

export async function handleManageCustomAutomations(
  params: ManageCustomAutomationsParams,
  config: RoomoteConfig,
): Promise<ToolResult> {
  let path = '/api/mcp/custom-automations';
  let method = 'GET';
  let body: Record<string, unknown> | undefined;

  if (params.action === 'resolve_schedule') {
    if (!params.schedule) return errorResult('schedule is required');
    path += '/resolve-schedule';
    method = 'POST';
    body = { schedule: params.schedule };
  } else if (params.action === 'create' || params.action === 'update') {
    const required = ['name', 'prompt', 'schedule', 'environmentId'] as const;
    if (params.action === 'create') {
      const missing = required.find((key) => !params[key]);
      if (missing) return errorResult(`${missing} is required`);
    }
    if (params.action === 'update' && !params.automationId) {
      return errorResult('automationId is required for update');
    }
    path +=
      params.action === 'update'
        ? `/${encodeURIComponent(params.automationId!)}`
        : '';
    method = params.action === 'update' ? 'PATCH' : 'POST';
    body = Object.fromEntries(
      Object.entries({
        name: params.name,
        prompt: params.prompt,
        enabled:
          params.action === 'create'
            ? (params.enabled ?? true)
            : params.enabled,
        schedule: params.schedule,
        environmentId: params.environmentId,
        targetProvider: params.targetProvider,
        targetChannelId: params.targetChannelId,
        targetServiceUrl: params.targetServiceUrl,
      }).filter((entry) => entry[1] !== undefined),
    );
  } else if (params.action === 'delete' || params.action === 'run_now') {
    if (!params.automationId) {
      return errorResult(`automationId is required for ${params.action}`);
    }
    path += `/${encodeURIComponent(params.automationId)}`;
    if (params.action === 'run_now') path += '/run';
    method = params.action === 'delete' ? 'DELETE' : 'POST';
  }

  const response = await fetchWithTimeout(
    `${config.platformApiUrl}${path}`,
    {
      method,
      headers: buildApiHeaders(config, {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      }),
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    { label: 'Failed to manage custom automations' },
  );
  if (!response.ok) {
    return errorResult(
      `Custom automation request failed (${response.status}): ${await parseApiError(response)}`,
    );
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(await response.json(), null, 2),
      },
    ],
  };
}
