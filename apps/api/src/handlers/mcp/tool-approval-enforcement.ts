import {
  isDeploymentExperimentEnabled,
  listIntegrationToolPolicies,
  listIntegrationToolUserPolicies,
} from '@roomote/db/server';
import {
  resolveStricterIntegrationToolPolicyMode,
  type IntegrationToolPolicyMode,
} from '@roomote/types';

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
 * policy applies. Returns no blocks while the experiment is off.
 */
export async function resolveProxyToolApprovalBlocks(input: {
  integrationId: string;
  tokenType: 'run' | 'auth';
  /** Looked up only while the experiment is on. */
  resolveActingUserId: () => Promise<string | null>;
}): Promise<Map<string, ProxyToolApprovalBlock>> {
  const blocks = new Map<string, ProxyToolApprovalBlock>();
  if (!(await isDeploymentExperimentEnabled('integrationToolApprovals'))) {
    return blocks;
  }
  const actingUserId = await input.resolveActingUserId();
  const [deploymentPolicies, userPolicies] = await Promise.all([
    listIntegrationToolPolicies(),
    actingUserId
      ? listIntegrationToolUserPolicies(actingUserId)
      : Promise.resolve([]),
  ]);
  const modes = new Map<string, IntegrationToolPolicyMode | undefined>();
  for (const policy of [...deploymentPolicies, ...userPolicies]) {
    if (policy.integrationId !== input.integrationId) continue;
    modes.set(
      policy.toolName,
      resolveStricterIntegrationToolPolicyMode(
        modes.get(policy.toolName),
        policy.mode,
      ),
    );
  }
  for (const [toolName, mode] of modes) {
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
    ? `Tool "${toolName}" is blocked by this deployment's tool approval policy.`
    : `Tool "${toolName}" needs approval before it runs, and tasks cannot request approval yet. Ask the user to run it from a Session instead.`;
}
