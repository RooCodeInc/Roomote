import {
  isDeploymentExperimentEnabled,
  listIntegrationToolPolicies,
  listIntegrationToolUserPolicies,
} from '@roomote/db/server';
import { resolveGoverningIntegrationToolPolicies } from '@roomote/types';

export type ProxyToolApprovalBlock = 'reject' | 'needs_approval';

/**
 * Experiment-gated (`integrationToolApprovals`) enforcement of per-tool
 * approval policies at the integration proxy, the one boundary every caller
 * crosses. A Session enforces `ask` natively before the call ever gets here,
 * but a task's agent has a shell next to its MCP configuration, so nothing
 * inside the sandbox can be the boundary for a task.
 *
 * - `reject` blocks the tool for every caller.
 * - `ask` blocks it for task runs, which have no approval flow yet, so a
 *   gated call can never be handed to a task to run unasked. Session calls
 *   pass: their native ask was already decided by the Session owner.
 *
 * The stricter of the deployment policy and the acting user's personal
 * policy applies, within the layers that govern the integration. Returns no blocks while the experiment is off.
 */
export async function resolveProxyToolApprovalBlocks(input: {
  integrationId: string;
  /**
   * A custom server is governed by one layer only, matching where its
   * policies are edited: `deployment` for a shared server, `personal` for its
   * owner's. Their names can coincide. Unset (built-ins) takes both.
   */
  policyScope?: 'deployment' | 'personal';
  tokenType: 'run' | 'auth';
  /** Looked up only while the experiment is on. */
  resolveActingUserId: () => Promise<string | null>;
}): Promise<Map<string, ProxyToolApprovalBlock>> {
  const blocks = new Map<string, ProxyToolApprovalBlock>();
  if (!(await isDeploymentExperimentEnabled('integrationToolApprovals'))) {
    return blocks;
  }
  const actingUserId =
    input.policyScope === 'deployment'
      ? null
      : await input.resolveActingUserId();
  const [deploymentPolicies, userPolicies] = await Promise.all([
    input.policyScope === 'personal'
      ? Promise.resolve([])
      : listIntegrationToolPolicies(),
    actingUserId
      ? listIntegrationToolUserPolicies(actingUserId)
      : Promise.resolve([]),
  ]);
  const governing = resolveGoverningIntegrationToolPolicies({
    deploymentPolicies,
    userPolicies,
    scopeOf: () => input.policyScope,
  });
  for (const { integrationId, toolName, mode } of governing) {
    if (integrationId !== input.integrationId) continue;
    if (mode === 'reject') {
      blocks.set(toolName, 'reject');
    } else if (mode === 'ask' && input.tokenType === 'run') {
      blocks.set(toolName, 'needs_approval');
    }
  }
  return blocks;
}

export function describeProxyToolApprovalBlock(
  toolName: string,
  block: ProxyToolApprovalBlock,
): string {
  return block === 'reject'
    ? `Tool "${toolName}" is blocked by a tool approval policy.`
    : `Tool "${toolName}" needs approval before it runs, and tasks cannot request approval yet. Ask the user to run it from a Session instead.`;
}
