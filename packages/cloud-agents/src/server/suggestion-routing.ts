import { z } from 'zod';

import {
  generateTrackedNonTaskObject,
  NON_TASK_INFERENCE_SURFACES,
} from './non-task-provider-usage';

const MAX_SUGGESTION_ROUTING_ROUTES = 8;
const MIN_ROUTE_PLANNER_CONFIDENCE = 0.6;
const SLACK_CHANNEL_ID_REGEX = /^[CGD][A-Z0-9]+$/i;

export type SuggestionRoutingPreviewRoute = {
  groupLabel: string;
  slackChannelName: string;
  guidance: string;
};

export type SuggestionRoutePlanRoute = {
  groupLabel: string;
  channelId: string;
  channelName: string;
  routeInstructions: string;
  confidence: number;
};

const suggestionRoutingValidationSchema = z
  .object({
    isValid: z.boolean(),
    confidence: z.number().nullable().optional(),
    issues: z.array(z.string().trim().min(1)).max(8).default([]),
    routes: z
      .array(
        z.object({
          groupLabel: z.string().trim().min(1),
          slackChannelName: z.string().trim().min(1),
          guidance: z.string().trim().min(1),
        }),
      )
      .max(MAX_SUGGESTION_ROUTING_ROUTES)
      .default([]),
  })
  .strict();

const suggestionRoutePlanSchema = z
  .object({
    issues: z.array(z.string().trim().min(1)).max(8).default([]),
    routes: z
      .array(
        z.object({
          groupLabel: z.string().trim().min(1),
          channelId: z.string().trim().min(1),
          routeInstructions: z.string().trim().min(1),
          confidence: z.number().min(0).max(1),
        }),
      )
      .max(MAX_SUGGESTION_ROUTING_ROUTES)
      .default([]),
    fallbackInstructions: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

const SUGGESTION_ROUTING_VALIDATION_SYSTEM_PROMPT = `
You validate grouped Slack routing instructions for the "Suggest Ideas" automation.

Accept only instructions that clearly define:
- at least one named idea group
- a Slack destination channel for each named group
- concise guidance describing what belongs in that group

Reject instructions when they:
- fail to name a destination Slack channel
- reference a Slack destination that is not in the available channel list
- contain conflicting or ambiguous channel mappings
- map the same group label to multiple Slack channels
- are too vague to separate grouped ideas from the default manager-channel fallback
- are mostly generic writing advice or prioritization without routing

Channel names should be returned exactly as the admin wrote them, normalized to the #channel form when possible.
Each group label must appear at most once.

Return structured output only.
`.trim();

const SUGGESTION_ROUTE_PLAN_SYSTEM_PROMPT = `
You plan grouped Slack destinations for the "Suggest Ideas" automation.

Use the provided routing instructions, available Slack channels, and manager fallback channel.

Rules:
- Only return channel IDs from the provided channel list.
- Build grouped routes only when the mapping from idea cluster to Slack channel is clear.
- Each route must use a unique group label.
- Keep each route focused on one idea cluster with concise instructions that a suggestion-generation model can follow.
- Use the manager fallback only for uncategorized or ambiguous ideas. Put that guidance in fallbackInstructions.
- If no grouped routes are reliable, return an empty routes array and explain why in issues.
- Never invent channel IDs or channels that are not in the provided list.

Return structured output only.
`.trim();

function normalizeConfidence(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeGroupLabelKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSlackChannelNameKey(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const channelName = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  const normalized = channelName.trim().toLowerCase();

  return normalized || null;
}

function normalizeSlackChannelId(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed || !SLACK_CHANNEL_ID_REGEX.test(trimmed)) {
    return null;
  }

  return trimmed.toUpperCase();
}

function normalizeAvailableChannels(
  availableChannels: Array<{ id: string; name: string }>,
): Array<{ id: string; name: string }> {
  const channelsById = new Map<string, { id: string; name: string }>();

  for (const channel of availableChannels) {
    const normalizedId = normalizeSlackChannelId(channel.id);
    const normalizedName = normalizeSlackChannelNameKey(channel.name);

    if (!normalizedId || !normalizedName) {
      continue;
    }

    if (!channelsById.has(normalizedId)) {
      channelsById.set(normalizedId, {
        id: normalizedId,
        name: normalizedName,
      });
    }
  }

  return [...channelsById.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function buildSuggestionRoutingValidationPrompt(input: {
  routingInstructions: string;
  availableChannels: Array<{ id: string; name: string }>;
}): string {
  const channelLines = input.availableChannels
    .map((channel) => `- ${channel.id} | #${channel.name}`)
    .join('\n');

  return [
    'Routing instructions:',
    input.routingInstructions.trim(),
    '',
    'Available Slack channels:',
    channelLines || '- No Slack channels available',
  ].join('\n');
}

function resolveAvailableChannel(
  input: string,
  params: {
    channelById: Map<string, { id: string; name: string }>;
    channelByName: Map<string, { id: string; name: string }>;
  },
): { id: string; name: string } | null {
  const normalizedChannelId = normalizeSlackChannelId(input);

  if (normalizedChannelId) {
    return params.channelById.get(normalizedChannelId) ?? null;
  }

  const normalizedChannelName = normalizeSlackChannelNameKey(input);

  if (!normalizedChannelName) {
    return null;
  }

  return params.channelByName.get(normalizedChannelName) ?? null;
}

export async function validateSuggestionRoutingInstructions(input: {
  routingInstructions: string;
  availableChannels: Array<{ id: string; name: string }>;
  userId?: string | null;
}): Promise<{
  isValid: boolean;
  confidence: number | null;
  issues: string[];
  routes: SuggestionRoutingPreviewRoute[];
}> {
  const availableChannels = normalizeAvailableChannels(input.availableChannels);
  const channelById = new Map(
    availableChannels.map((channel) => [channel.id, channel]),
  );
  const channelByName = new Map(
    availableChannels.map((channel) => [channel.name, channel]),
  );
  const { object } = await generateTrackedNonTaskObject({
    userId: input.userId,
    surface: NON_TASK_INFERENCE_SURFACES.suggestionRoutingValidation,
    maxOutputTokens: 768,
    schema: suggestionRoutingValidationSchema,
    system: SUGGESTION_ROUTING_VALIDATION_SYSTEM_PROMPT,
    prompt: buildSuggestionRoutingValidationPrompt({
      routingInstructions: input.routingInstructions,
      availableChannels,
    }),
  });

  const issues = [...object.issues];
  const routes: SuggestionRoutingPreviewRoute[] = [];
  const routedChannelIdsByGroupLabel = new Map<string, string>();
  let hasRouteValidationFailure = false;

  for (const route of object.routes) {
    const groupLabel = route.groupLabel.trim();
    const channelInput = route.slackChannelName.trim();
    const guidance = route.guidance.trim();
    const groupLabelKey = normalizeGroupLabelKey(groupLabel);
    const resolvedChannel = resolveAvailableChannel(channelInput, {
      channelById,
      channelByName,
    });

    if (!resolvedChannel) {
      issues.push(
        `Could not resolve Slack channel ${channelInput} from the channels available to Roomote.`,
      );
      hasRouteValidationFailure = true;
      continue;
    }

    const existingChannelId = routedChannelIdsByGroupLabel.get(groupLabelKey);

    if (existingChannelId) {
      if (existingChannelId === resolvedChannel.id) {
        continue;
      }

      issues.push(
        `Each routed group label can only map to one Slack channel. Duplicate group: ${groupLabel}.`,
      );
      hasRouteValidationFailure = true;
      continue;
    }

    routedChannelIdsByGroupLabel.set(groupLabelKey, resolvedChannel.id);
    routes.push({
      groupLabel,
      slackChannelName: `#${resolvedChannel.name}`,
      guidance,
    });
  }
  const isValid =
    object.isValid && routes.length > 0 && !hasRouteValidationFailure;

  return {
    isValid,
    confidence: normalizeConfidence(object.confidence),
    issues,
    routes,
  };
}

function buildSuggestionRoutePlanningPrompt(input: {
  routingInstructions: string;
  availableChannels: Array<{ id: string; name: string }>;
  managerFallbackChannel: { id: string; name: string | null };
  repositoryCoverage: Array<{
    repositoryFullName: string;
    workspaceReadiness: 'environment_backed' | 'bare_repo';
    targetEnvironmentId?: string;
  }>;
}): string {
  const channelLines = input.availableChannels
    .map((channel) => `- ${channel.id} | #${channel.name}`)
    .join('\n');
  const coverageLines = input.repositoryCoverage
    .map((coverage) =>
      coverage.targetEnvironmentId
        ? `- ${coverage.repositoryFullName} (${coverage.workspaceReadiness}, environment ${coverage.targetEnvironmentId})`
        : `- ${coverage.repositoryFullName} (${coverage.workspaceReadiness})`,
    )
    .join('\n');

  return [
    'Routing instructions:',
    input.routingInstructions.trim(),
    '',
    `Manager fallback channel: ${input.managerFallbackChannel.id} | ${
      input.managerFallbackChannel.name
        ? `#${input.managerFallbackChannel.name}`
        : '(name unavailable)'
    }`,
    '',
    'Available Slack channels:',
    channelLines,
    '',
    'Repository coverage summary:',
    coverageLines || '- No repository coverage provided',
  ].join('\n');
}

export async function planSuggestionRoutes(input: {
  routingInstructions: string;
  availableChannels: Array<{ id: string; name: string }>;
  managerFallbackChannel: { id: string; name: string | null };
  repositoryCoverage: Array<{
    repositoryFullName: string;
    workspaceReadiness: 'environment_backed' | 'bare_repo';
    targetEnvironmentId?: string;
  }>;
  userId?: string | null;
}): Promise<{
  fallbackChannelId: string | null;
  fallbackChannelName: string | null;
  fallbackInstructions: string | null;
  issues: string[];
  routes: SuggestionRoutePlanRoute[];
}> {
  const channels = normalizeAvailableChannels(input.availableChannels);
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));

  const { object } = await generateTrackedNonTaskObject({
    userId: input.userId,
    surface: NON_TASK_INFERENCE_SURFACES.suggestionRoutePlanning,
    maxOutputTokens: 1024,
    schema: suggestionRoutePlanSchema,
    system: SUGGESTION_ROUTE_PLAN_SYSTEM_PROMPT,
    prompt: buildSuggestionRoutePlanningPrompt(input),
  });

  const acceptedRoutes: SuggestionRoutePlanRoute[] = [];
  const routedChannelIdsByGroupLabel = new Map<string, string>();
  const issues = [...object.issues];

  for (const route of object.routes) {
    if (route.confidence < MIN_ROUTE_PLANNER_CONFIDENCE) {
      continue;
    }

    const channel = channelById.get(route.channelId);

    if (!channel) {
      continue;
    }

    const groupLabel = route.groupLabel.trim();
    const groupLabelKey = normalizeGroupLabelKey(groupLabel);
    const existingChannelId = routedChannelIdsByGroupLabel.get(groupLabelKey);

    if (existingChannelId) {
      if (existingChannelId !== channel.id) {
        issues.push(
          `Ignored duplicate grouped route for ${groupLabel} because each routed group can only map to one Slack channel.`,
        );
      }
      continue;
    }

    routedChannelIdsByGroupLabel.set(groupLabelKey, channel.id);
    acceptedRoutes.push({
      groupLabel,
      channelId: channel.id,
      channelName: channel.name,
      routeInstructions: route.routeInstructions.trim(),
      confidence: route.confidence,
    });
  }

  return {
    fallbackChannelId: input.managerFallbackChannel.id,
    fallbackChannelName: input.managerFallbackChannel.name,
    fallbackInstructions: object.fallbackInstructions?.trim() || null,
    issues,
    routes: acceptedRoutes,
  };
}
