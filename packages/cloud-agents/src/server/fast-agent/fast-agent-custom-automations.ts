import { createAuthToken } from '@roomote/auth';
import { z } from 'zod';

import { resolveApiBaseUrl } from '../shared-utils';

const FAST_AGENT_CUSTOM_AUTOMATIONS_API_PATH = '/api/mcp/custom-automations';

export const fastAgentCustomAutomationArgsSchema = z.object({
  action: z.enum([
    'list',
    'list_models',
    'resolve_schedule',
    'create',
    'update',
    'delete',
    'run_now',
  ]),
  automationId: z.string().trim().min(1).optional(),
  name: z.string().optional(),
  prompt: z.string().optional(),
  enabled: z.boolean().optional(),
  schedule: z.string().optional(),
  model: z.string().nullable().optional(),
  environmentId: z.string().optional(),
  targetProvider: z
    .enum(['slack', 'discord', 'teams', 'telegram'])
    .nullable()
    .optional(),
  targetMode: z.enum(['channel', 'direct_message']).optional(),
  targetChannelId: z.string().optional(),
  targetServiceUrl: z.string().optional(),
});

export type FastAgentCustomAutomationArgs = z.infer<
  typeof fastAgentCustomAutomationArgsSchema
>;

type FastAgentCustomAutomationResult = Record<string, unknown>;

export type FastAgentCustomAutomationApiContext = {
  apiBaseUrl?: string;
  getAuthToken?: () => Promise<string>;
  userId: string;
};

function buildRequest(args: FastAgentCustomAutomationArgs):
  | {
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      path: string;
      body?: Record<string, unknown>;
    }
  | { error: string } {
  if (args.action === 'list') {
    return { method: 'GET', path: FAST_AGENT_CUSTOM_AUTOMATIONS_API_PATH };
  }
  if (args.action === 'list_models') {
    return {
      method: 'GET',
      path: `${FAST_AGENT_CUSTOM_AUTOMATIONS_API_PATH}/models`,
    };
  }
  if (args.action === 'resolve_schedule') {
    if (!args.schedule?.trim()) return { error: 'schedule is required' };
    return {
      method: 'POST',
      path: `${FAST_AGENT_CUSTOM_AUTOMATIONS_API_PATH}/resolve-schedule`,
      body: { schedule: args.schedule },
    };
  }
  if (args.action === 'create' || args.action === 'update') {
    if (args.action === 'update' && !args.automationId) {
      return { error: 'automationId is required for update' };
    }
    return {
      method: args.action === 'create' ? 'POST' : 'PATCH',
      path:
        args.action === 'create'
          ? FAST_AGENT_CUSTOM_AUTOMATIONS_API_PATH
          : `${FAST_AGENT_CUSTOM_AUTOMATIONS_API_PATH}/${encodeURIComponent(args.automationId!)}`,
      body: Object.fromEntries(
        Object.entries({
          name: args.name,
          prompt: args.prompt,
          enabled: args.enabled,
          schedule: args.schedule,
          model: args.model,
          environmentId: args.environmentId,
          targetProvider: args.targetProvider,
          targetMode: args.targetMode,
          targetChannelId: args.targetChannelId,
          targetServiceUrl: args.targetServiceUrl,
        }).filter((entry) => entry[1] !== undefined),
      ),
    };
  }

  if (!args.automationId) {
    return { error: `automationId is required for ${args.action}` };
  }
  return {
    method: args.action === 'delete' ? 'DELETE' : 'POST',
    path: `${FAST_AGENT_CUSTOM_AUTOMATIONS_API_PATH}/${encodeURIComponent(args.automationId)}${args.action === 'run_now' ? '/run' : ''}`,
  };
}

export async function manageFastAgentCustomAutomations(
  context: FastAgentCustomAutomationApiContext,
  input: FastAgentCustomAutomationArgs,
): Promise<FastAgentCustomAutomationResult> {
  const args = fastAgentCustomAutomationArgsSchema.parse(input);
  const request = buildRequest(args);
  if ('error' in request) return { success: false, error: request.error };

  const apiBaseUrl = resolveApiBaseUrl(context.apiBaseUrl);
  if (!apiBaseUrl) {
    return { success: false, error: 'Custom automation API is unavailable.' };
  }

  try {
    const authToken =
      (await context.getAuthToken?.()) ??
      (await createAuthToken({
        userId: context.userId,
        timeoutMs: 2 * 60_000,
      }));
    const url = new URL(request.path.replace(/^\/+/, ''), `${apiBaseUrl}/`);
    const response = await fetch(url, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${authToken}`,
        ...(request.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    });
    const result = (await response.json()) as unknown;
    if (result && typeof result === 'object') {
      return result as FastAgentCustomAutomationResult;
    }
    return {
      success: false,
      error: 'Custom automation API returned an unexpected response.',
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to call the custom automation API.',
    };
  }
}
