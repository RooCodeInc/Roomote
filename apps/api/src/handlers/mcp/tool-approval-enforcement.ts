import {
  claimTaskIntegrationToolCall,
  db,
  findLatestFastConversationUserRequest,
  findLatestTaskUserRequest,
  fingerprintIntegrationToolCall,
  getSessionForTask,
  isDeploymentExperimentEnabled,
  listIntegrationToolPolicies,
  listIntegrationToolSessionOverrides,
  listIntegrationToolUserPolicies,
} from '@roomote/db/server';
import {
  INTEGRATION_TOOL_FAST_CONVERSATION_HEADER,
  integrationToolModeIsAutoAssessed,
  resolveEffectiveIntegrationToolMode,
  resolveGoverningIntegrationToolPolicies,
  type IntegrationToolPolicyMode,
} from '@roomote/types';
import {
  recordIntegrationToolShadowEvaluationInBackground,
  resolveIntegrationToolAutoState,
} from '@roomote/cloud-agents/server/integration-tool-auto-evaluation';

export type ProxyToolApprovalBlock = 'reject' | 'needs_approval' | 'allow';

export type ProxyToolApprovals = {
  /** Per-tool blocks from stored choices and session overrides. */
  blocks: Map<string, ProxyToolApprovalBlock>;
  /**
   * What a tool with no entry in `blocks` gets. `needs_approval` while Auto
   * mode is on and the caller is a task: every default tool call must then
   * claim an approval, whether a person's or the model's.
   */
  defaultBlock?: 'needs_approval';
  /** Whether a call to a default tool should be shadow-assessed. */
  shadowDefaultTools: boolean;
};

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
}): Promise<ProxyToolApprovals> {
  const blocks = new Map<string, ProxyToolApprovalBlock>();
  const result: ProxyToolApprovals = { blocks, shadowDefaultTools: false };
  if (!(await isDeploymentExperimentEnabled('integrationToolApprovals'))) {
    return result;
  }
  const autoState = await resolveIntegrationToolAutoState();
  result.shadowDefaultTools = autoState.mode === 'shadow';
  if (autoState.mode === 'on' && input.tokenType === 'run') {
    result.defaultBlock = 'needs_approval';
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
    } else if (mode === 'ask' && input.tokenType === 'run') {
      blocks.set(toolName, 'needs_approval');
    } else if (
      result.defaultBlock &&
      !integrationToolModeIsAutoAssessed({
        policyMode: policyModes.get(toolName),
        sessionOverrideMode: overrideModes.get(toolName),
      })
    ) {
      // A person's choice to run this tool: no approval to claim.
      blocks.set(toolName, 'allow');
    }
  }
  return result;
}

/** How the proxy treats one named tool call. */
export function resolveProxyToolApprovalBlock(
  approvals: ProxyToolApprovals,
  toolName: string,
): ProxyToolApprovalBlock | 'allow' | undefined {
  return approvals.blocks.get(toolName) ?? approvals.defaultBlock;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Fast conversation a Session's integration call names, if any. */
export function readFastConversationIdHeader(headers: Headers): string | null {
  const value = headers.get(INTEGRATION_TOOL_FAST_CONVERSATION_HEADER)?.trim();
  return value && UUID_PATTERN.test(value) ? value : null;
}

/**
 * Shadow-assess a call to a default tool; never awaited. A call is assessed
 * against what its user last asked: the task's latest prompt for a task, or
 * the caller's own latest prompt in the Fast conversation it names.
 */
export function shadowProxyToolCall(
  approvals: ProxyToolApprovals,
  input: {
    integrationId: string;
    toolName: string;
    args: unknown;
    userId: string | null;
    taskId: string | null;
    fastConversationId?: string | null;
  },
): void {
  if (!approvals.shadowDefaultTools || approvals.blocks.has(input.toolName)) {
    return;
  }
  const { fastConversationId, ...call } = input;
  const { taskId, userId } = call;
  const resolveUserRequest = taskId
    ? () => findLatestTaskUserRequest(taskId)
    : fastConversationId && userId
      ? () =>
          findLatestFastConversationUserRequest({
            conversationId: fastConversationId,
            userId,
          })
      : undefined;
  recordIntegrationToolShadowEvaluationInBackground({
    ...call,
    ...(resolveUserRequest ? { resolveUserRequest } : {}),
  });
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
    : block === 'needs_approval'
      ? `Tool "${toolName}" needs approval before it runs, and this call has not been approved.`
      : `Tool "${toolName}" is allowed.`;
}
