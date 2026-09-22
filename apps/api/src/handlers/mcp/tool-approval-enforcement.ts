import {
  claimTaskIntegrationToolCall,
  db,
  fingerprintIntegrationToolCall,
  getSessionForTask,
  isDeploymentExperimentEnabled,
  listIntegrationToolPolicies,
  listIntegrationToolSessionOverrides,
  listIntegrationToolUserPolicies,
} from '@roomote/db/server';
import {
  integrationToolModeAsks,
  isInternalMcpServer,
  resolveEffectiveIntegrationToolMode,
  resolveGoverningIntegrationToolPolicies,
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
 * - `reject` blocks the tool for every caller, and hides it.
 * - `ask` holds a task run's call until the Session owner has approved that
 *   exact call (`claimProxyTaskToolCall`). The task's agent asks natively, but
 *   the approval is only real because it is claimed here. Session calls pass:
 *   their native ask was already decided by the Session owner.
 *
 * A task belongs to one Session, whose overrides apply to it as they do to
 * the Session's own agent: "don't ask again this session" lifts an `ask`, and
 * a session `ask` gates a tool the policies leave alone.
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
  /** The run token's task, for its Session's overrides. */
  resolveTaskId?: () => Promise<string | null>;
}): Promise<Map<string, ProxyToolApprovalBlock>> {
  const blocks = new Map<string, ProxyToolApprovalBlock>();
  if (!(await isDeploymentExperimentEnabled('integrationToolApprovals'))) {
    return blocks;
  }
  // Roomote's own MCP and other internal servers are outside approval
  // control entirely; their tools always pass.
  if (isInternalMcpServer(input.integrationId)) {
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
  const policyModes = new Map<string, IntegrationToolPolicyMode>();
  for (const { integrationId, toolName, mode } of governing) {
    if (integrationId === input.integrationId) policyModes.set(toolName, mode);
  }
  const overrideModes = new Map<string, 'allow' | 'ask'>();
  if (input.tokenType === 'run') {
    const taskId = await input.resolveTaskId?.();
    const session = taskId ? await getSessionForTask(db, taskId) : null;
    const overrides = session
      ? await listIntegrationToolSessionOverrides(session.id)
      : [];
    for (const { integrationId, toolName, mode } of overrides) {
      if (integrationId === input.integrationId) {
        overrideModes.set(toolName, mode);
      }
    }
  }
  for (const toolName of new Set([
    ...policyModes.keys(),
    ...overrideModes.keys(),
  ])) {
    const mode = resolveEffectiveIntegrationToolMode({
      policyMode: policyModes.get(toolName),
      sessionOverrideMode: overrideModes.get(toolName),
    });
    if (mode === 'reject') {
      blocks.set(toolName, 'reject');
    } else if (integrationToolModeAsks(mode) && input.tokenType === 'run') {
      blocks.set(toolName, 'needs_approval');
    }
  }
  return blocks;
}

/**
 * Whether the Session owner approved this exact call for this task. Consumes
 * the approval, so one decision runs one call.
 */
export async function claimProxyTaskToolCall(input: {
  taskId: string | null;
  integrationId: string;
  toolName: string;
  args: unknown;
}): Promise<boolean> {
  if (!input.taskId) return false;
  return claimTaskIntegrationToolCall({
    taskId: input.taskId,
    argsFingerprint: fingerprintIntegrationToolCall({
      integrationId: input.integrationId,
      toolName: input.toolName,
      args: input.args ?? null,
    }),
  });
}

export function describeProxyToolApprovalBlock(
  toolName: string,
  block: ProxyToolApprovalBlock,
): string {
  return block === 'reject'
    ? `Tool "${toolName}" is disabled by a tool approval policy.`
    : `Tool "${toolName}" needs approval before it runs, and this call has not been approved.`;
}
