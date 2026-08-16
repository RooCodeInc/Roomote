import { createAuthToken } from '@roomote/auth';
import { Env, isBrainConfigured } from '@roomote/env';
import {
  ROUTING_PREFERENCE_GET_TOOL,
  ROUTING_PREFERENCE_RECORD_TOOL,
  type RoutingPreferenceSignal,
} from '@roomote/types';
import { z } from 'zod';

import { resolveApiBaseUrl } from '../shared-utils';
import { callMcpTool } from '../mcp-tool-client';
import type { RoutingEnvironmentPreference } from './types';

const routingPreferenceResponseSchema = z.object({
  preference: z
    .object({
      environmentId: z.string().min(1),
      acceptedCount: z.number().int().nonnegative(),
      correctionCount: z.number().int().nonnegative(),
      lastSelectedAt: z.string().datetime(),
    })
    .nullable(),
});

const ROUTING_PREFERENCE_TIMEOUT_MS = 500;

export function normalizeRoutingPreferenceEnvironmentId(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  if (
    !normalized ||
    normalized === 'all_repositories' ||
    normalized === '__all_repositories__' ||
    normalized.startsWith('repo:')
  ) {
    return null;
  }

  if (normalized.startsWith('env:')) {
    return normalized.slice('env:'.length).trim() || null;
  }

  return normalized;
}

async function withRoutingPreferenceTimeout<T>(
  operation: () => Promise<T>,
): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(resolve, ROUTING_PREFERENCE_TIMEOUT_MS, null);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function callRoutingPreferenceTool(options: {
  userId: string;
  apiBaseUrl?: string;
  toolName:
    | typeof ROUTING_PREFERENCE_GET_TOOL
    | typeof ROUTING_PREFERENCE_RECORD_TOOL;
  args?: Record<string, unknown>;
}): Promise<unknown | null> {
  const apiBaseUrl = resolveApiBaseUrl(options.apiBaseUrl);
  if (!apiBaseUrl) {
    return null;
  }

  const authToken = await createAuthToken({
    userId: options.userId,
    timeoutMs: 2 * 60_000,
  });

  return callMcpTool({
    url: `${apiBaseUrl}/api/mcp-routing/roomote`,
    headers: { Authorization: `Bearer ${authToken}` },
    toolName: options.toolName,
    args: options.args,
    toolCallId: `router-mcp:roomote:${options.toolName}`,
  });
}

export async function getRoutingPreference(options: {
  userId: string;
  apiBaseUrl?: string;
}): Promise<RoutingEnvironmentPreference | null> {
  if (!isBrainConfigured(Env)) {
    return null;
  }

  try {
    const parsed = routingPreferenceResponseSchema.safeParse(
      await withRoutingPreferenceTimeout(() =>
        callRoutingPreferenceTool({
          ...options,
          toolName: ROUTING_PREFERENCE_GET_TOOL,
        }),
      ),
    );

    if (!parsed.success || !parsed.data.preference) {
      return null;
    }

    return {
      ...parsed.data.preference,
      lastSelectedAt: new Date(parsed.data.preference.lastSelectedAt),
    };
  } catch (error) {
    console.warn(
      `[RoutingPreference] Brain read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export async function recordRoutingPreference(options: {
  userId: string;
  apiBaseUrl?: string;
  environmentId: string;
  signal: RoutingPreferenceSignal;
}): Promise<void> {
  if (!isBrainConfigured(Env)) {
    return;
  }

  try {
    await withRoutingPreferenceTimeout(() =>
      callRoutingPreferenceTool({
        userId: options.userId,
        apiBaseUrl: options.apiBaseUrl,
        toolName: ROUTING_PREFERENCE_RECORD_TOOL,
        args: {
          environmentId: options.environmentId,
          signal: options.signal,
        },
      }),
    );
  } catch (error) {
    console.warn(
      `[RoutingPreference] Brain write failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
