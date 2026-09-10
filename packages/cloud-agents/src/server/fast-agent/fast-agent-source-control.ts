import { ROOMOTE_MCP_ID } from '@roomote/types';
import { z } from 'zod';

import type {
  FastAgentSourceControlTarget,
  FastAgentTurnAdapter,
} from './fast-agent-conversation';

export const sourceControlConnectionArgsSchema = z.object({
  target: z.object({
    provider: z
      .enum(['github', 'gitlab', 'gitea', 'ado', 'bitbucket'])
      .optional(),
    repositoryFullName: z.string().trim().min(1).max(500).optional(),
    environmentId: z.string().trim().min(1).max(200).optional(),
    capability: z.enum(['repository', 'source_control_tool']),
  }),
});

/** Covers both on-demand provider tools and the natively mounted Roomote tool. */
export function getFastSourceControlToolTarget(call: {
  integrationId: string;
  toolName: string;
  args: Record<string, unknown>;
}): FastAgentSourceControlTarget | undefined {
  const provider =
    sourceControlConnectionArgsSchema.shape.target.shape.provider.safeParse(
      call.integrationId,
    );
  if (
    !provider.success &&
    !(
      call.integrationId === ROOMOTE_MCP_ID &&
      call.toolName === 'manage_source_control'
    )
  )
    return undefined;

  const explicitProvider =
    sourceControlConnectionArgsSchema.shape.target.shape.provider.safeParse(
      call.args.sourceControlProvider,
    );
  const repositoryFullName =
    typeof call.args.repositoryFullName === 'string'
      ? call.args.repositoryFullName
      : typeof call.args.owner === 'string' &&
          typeof call.args.repo === 'string'
        ? `${call.args.owner}/${call.args.repo}`
        : undefined;
  return {
    capability: 'source_control_tool',
    ...(provider.success
      ? { provider: provider.data }
      : explicitProvider.success
        ? { provider: explicitProvider.data }
        : {}),
    ...(repositoryFullName ? { repositoryFullName } : {}),
  };
}

export async function preflightFastSourceControl(
  adapter: FastAgentTurnAdapter,
  actorUserId: string,
  target: FastAgentSourceControlTarget,
  tool?: { integrationId: string; toolName: string },
) {
  // Trusted continuations must still be checked after rollout is disabled.
  if (
    !adapter.sourceControlConnectionEnabled &&
    !adapter.forceFreshSourceControlDiscovery
  )
    return undefined;
  const readiness = await adapter
    .getSourceControlReadiness?.({
      actorUserId,
      target,
      ...(tool ? { tool } : {}),
    })
    .catch(() => undefined);
  if (readiness?.status === 'ready') return undefined;
  const status = readiness?.status ?? 'discovery_unavailable';
  return {
    success: false as const,
    readiness: { status },
    error:
      status === 'discovery_unavailable'
        ? 'Source-control capability could not be verified. Retry discovery; reconnecting is not required by this result.'
        : status === 'target_required'
          ? 'Clarify the repository or environment needed for this operation.'
          : status === 'forbidden'
            ? 'The current actor is not permitted to perform this source-control operation.'
            : 'The required source-control access is not ready. Use request_source_control_connection for the current target before continuing.',
  };
}
