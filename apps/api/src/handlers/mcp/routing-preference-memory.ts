import { resolveBrainConnection } from '@roomote/sdk/server';
import {
  type RoutingPreferenceMemory,
  type RoutingPreferenceSignal,
} from '@roomote/types';
import { callMcpTool } from '@roomote/cloud-agents/server';
import { z } from 'zod';

const preferencePageSchema = z.object({
  frontmatter: z
    .object({
      environment_id: z.string().min(1),
      accepted_count: z.coerce.number().int().nonnegative().default(0),
      correction_count: z.coerce.number().int().nonnegative().default(0),
      last_selected_at: z.string().datetime(),
    })
    .passthrough(),
});

function routingPreferenceSlug(userId: string): string {
  return `routing/preferences/users/${Buffer.from(userId).toString('base64url')}`;
}

async function callBrainTool(options: {
  role: 'agent' | 'ingest';
  toolName: 'get_page' | 'put_page';
  args: Record<string, unknown>;
}): Promise<unknown | null> {
  const connection = await resolveBrainConnection(options.role);
  if (!connection) {
    return null;
  }

  return callMcpTool({
    url: `${connection.baseUrl.replace(/\/$/, '')}/mcp`,
    headers: { Authorization: `Bearer ${connection.token}` },
    toolName: options.toolName,
    args: options.args,
    toolCallId: `routing-preference:${options.toolName}`,
  });
}

function parseRoutingPreference(
  value: unknown,
): RoutingPreferenceMemory | null {
  const parsed = preferencePageSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  return {
    environmentId: parsed.data.frontmatter.environment_id,
    acceptedCount: parsed.data.frontmatter.accepted_count,
    correctionCount: parsed.data.frontmatter.correction_count,
    lastSelectedAt: parsed.data.frontmatter.last_selected_at,
  };
}

async function readRoutingPreference(
  userId: string,
  role: 'agent' | 'ingest',
): Promise<RoutingPreferenceMemory | null> {
  try {
    return parseRoutingPreference(
      await callBrainTool({
        role,
        toolName: 'get_page',
        args: { slug: routingPreferenceSlug(userId) },
      }),
    );
  } catch {
    // A missing page and an unavailable optional Brain both mean no preference.
    return null;
  }
}

export async function getRoutingPreferenceMemory(
  userId: string,
): Promise<RoutingPreferenceMemory | null> {
  return readRoutingPreference(userId, 'agent');
}

export async function recordRoutingPreferenceMemory(input: {
  userId: string;
  environmentId: string;
  signal: RoutingPreferenceSignal;
}): Promise<RoutingPreferenceMemory | null> {
  const connection = await resolveBrainConnection('ingest');
  if (!connection) {
    return null;
  }

  const existing = await readRoutingPreference(input.userId, 'ingest');
  const sameEnvironment = existing?.environmentId === input.environmentId;
  const preference: RoutingPreferenceMemory = {
    environmentId: input.environmentId,
    acceptedCount:
      (sameEnvironment ? existing.acceptedCount : 0) +
      (input.signal === 'accepted' ? 1 : 0),
    correctionCount:
      (sameEnvironment ? existing.correctionCount : 0) +
      (input.signal === 'corrected' ? 1 : 0),
    lastSelectedAt: new Date().toISOString(),
  };
  const content = [
    '---',
    `environment_id: ${JSON.stringify(preference.environmentId)}`,
    `accepted_count: ${preference.acceptedCount}`,
    `correction_count: ${preference.correctionCount}`,
    `last_selected_at: ${JSON.stringify(preference.lastSelectedAt)}`,
    'provenance: roomote-routing-preference',
    '---',
    '',
    '# Routing preference',
    '',
    `Preferred environment: ${preference.environmentId}`,
  ].join('\n');

  await callMcpTool({
    url: `${connection.baseUrl.replace(/\/$/, '')}/mcp`,
    headers: { Authorization: `Bearer ${connection.token}` },
    toolName: 'put_page',
    args: { slug: routingPreferenceSlug(input.userId), content },
    toolCallId: 'routing-preference:put_page',
  });

  return preference;
}
