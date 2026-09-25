import {
  buildManageCustomAutomationsRequest,
  compactManageCustomAutomationsResult,
  type ManageCustomAutomationsInput,
} from '@roomote/types';

import type { RoomoteConfig, ToolResult } from './types.js';
import { buildApiHeaders, fetchWithTimeout } from './api-client.js';
import { errorResult } from './tool-result.js';

export async function handleManageCustomAutomations(
  params: ManageCustomAutomationsInput,
  config: RoomoteConfig,
  launchCriteriaEnabled = true,
): Promise<ToolResult> {
  const built = buildManageCustomAutomationsRequest(params);
  if (!built.ok) return errorResult(built.error);

  const { method, body } = built.request;
  const path = `/api/mcp/custom-automations${built.request.path}`;

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
  const rawText = await response.text();
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawText) as unknown;
  } catch {
    if (!response.ok) {
      return errorResult(
        `Custom automation request failed (${response.status}): ${rawText}`,
      );
    }
    rawPayload = {};
  }
  const payload = compactManageCustomAutomationsResult(
    params.action,
    rawPayload,
    { includeLaunchCriteria: launchCriteriaEnabled },
  );
  if (!response.ok) {
    const message =
      typeof payload.error === 'string'
        ? payload.error
        : `Custom automation request failed (${response.status})`;
    return errorResult(message, { httpStatus: response.status, ...payload });
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export async function resolveCustomAutomationLaunchCriteriaEnabled(
  config: RoomoteConfig,
): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      `${config.platformApiUrl}/api/mcp/custom-automations/experiment`,
      { headers: buildApiHeaders(config) },
      {
        label: 'Failed to read custom automation capabilities',
        timeoutMs: 5_000,
      },
    );
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    return (
      payload !== null &&
      typeof payload === 'object' &&
      'launchCriteriaEnabled' in payload &&
      payload.launchCriteriaEnabled === true
    );
  } catch (error) {
    console.error(
      'Could not load custom automation capabilities; hiding launch criteria.',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
