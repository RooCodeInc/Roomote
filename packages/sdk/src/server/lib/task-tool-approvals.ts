import {
  claimAutoApprovedIntegrationToolApproval,
  db,
  eq,
  expireIntegrationToolApproval,
  fingerprintIntegrationToolCall,
  getIntegrationToolApproval,
  getSessionForTask,
  insertAutoApprovedIntegrationToolApproval,
  insertIntegrationToolApproval,
  isDeploymentExperimentEnabled,
  listIntegrationToolPolicies,
  listIntegrationToolSessionOverrides,
  listIntegrationToolUserPolicies,
  taskRuns,
} from '@roomote/db/server';
import {
  resolveIntegrationToolAutoDecision,
  resolveIntegrationToolAutoState,
} from '@roomote/cloud-agents/server/integration-tool-auto-evaluation';
import {
  BRAIN_MCP_ID,
  compileTaskIntegrationToolApprovals,
  GBRAIN_READ_TOOL_NAMES,
  integrationToolModeIsAutoAssessed,
  isInternalMcpServer,
  resolveEffectiveIntegrationToolMode,
  resolveGoverningIntegrationToolPolicies,
  type IntegrationToolApprovalStatus,
  type IntegrationToolPolicyScope,
  type TaskIntegrationToolApprovals,
} from '@roomote/types';

/**
 * Experiment-gated (`integrationToolApprovals`) approvals for a task's agent.
 * A task belongs to one Session, so its asks are recorded on that Session,
 * decided by the Session owner on the same card, and honor the same session
 * overrides. The worker relays the agent's native ask here; the integration
 * proxy is what enforces the decision.
 */
async function resolveTaskApprovalSession(runId: number) {
  const run = await db.query.taskRuns.findFirst({
    columns: { taskId: true },
    where: eq(taskRuns.id, runId),
  });
  if (!run) return null;
  const session = await getSessionForTask(db, run.taskId);
  if (!session) return null;
  return {
    taskId: run.taskId,
    sessionId: session.id,
    ownerUserId:
      session.ownerKind === 'user' ? (session.ownerUserId ?? null) : null,
  };
}

type ResolveTaskServers = () => Promise<
  Record<string, { toolApprovalPolicyScope?: IntegrationToolPolicyScope }>
>;

/** The policies and session overrides that govern one task run's tools. */
async function resolveTaskGoverningPolicies(input: {
  actingUserId: string | undefined;
  resolveServers: ResolveTaskServers;
  sessionId: string | undefined;
}) {
  const servers = await input.resolveServers();
  const [deploymentPolicies, userPolicies, sessionOverrides] =
    await Promise.all([
      listIntegrationToolPolicies(),
      input.actingUserId
        ? listIntegrationToolUserPolicies(input.actingUserId)
        : Promise.resolve([]),
      input.sessionId
        ? listIntegrationToolSessionOverrides(input.sessionId)
        : Promise.resolve([]),
    ]);
  return {
    servers,
    policies: resolveGoverningIntegrationToolPolicies({
      deploymentPolicies,
      userPolicies,
      scopeOf: (integrationId) =>
        servers[integrationId]?.toolApprovalPolicyScope,
    }),
    sessionOverrides,
  };
}

/** The native rules for the servers a task run is about to mount. */
export async function resolveTaskIntegrationToolApprovals(input: {
  runId: number;
  actingUserId: string | undefined;
  /** Resolved only while the experiment is on. */
  resolveServers: ResolveTaskServers;
}): Promise<TaskIntegrationToolApprovals | undefined> {
  if (!(await isDeploymentExperimentEnabled('integrationToolApprovals'))) {
    return undefined;
  }
  const session = await resolveTaskApprovalSession(input.runId);
  const [{ servers, policies, sessionOverrides }, autoState] =
    await Promise.all([
      resolveTaskGoverningPolicies({
        actingUserId: input.actingUserId,
        resolveServers: input.resolveServers,
        sessionId: session?.sessionId,
      }),
      resolveIntegrationToolAutoState(),
    ]);
  return compileTaskIntegrationToolApprovals({
    serverNames: Object.keys(servers),
    policies,
    sessionOverrides,
    autoOn: autoState.mode === 'on',
    // The Brain's agent-facing tool set is a static allowlist, so the
    // compiler can drop exactly the native keys that are genuinely the
    // Brain's. `_roomote_http_integrations` needs no list: its flattened
    // keys start with `_`, which no governable server name can produce.
    internalToolNames: { [BRAIN_MCP_ID]: GBRAIN_READ_TOOL_NAMES },
  });
}

type TaskToolApprovalRequestResult =
  /** Nothing gates the call any more; let it run. */
  | { outcome: 'not_required' }
  /** Nobody can decide for this task, so the call cannot be approved. */
  | { outcome: 'unavailable' }
  /** The Session owner already chose not to be asked about this tool. */
  | { outcome: 'approved' }
  | { outcome: 'pending'; approvalId: string };

/** Record one native ask from a task's agent. */
export async function requestTaskToolApproval(input: {
  runId: number;
  integrationId: string;
  toolName: string;
  nativeRequestId: string;
  args?: unknown;
  /** What the user last asked for; Auto mode checks the call against it. */
  userRequest?: string;
  /** Whose personal policies apply, and what the run mounts: they decide who answers. */
  actingUserId?: string;
  resolveServers?: ResolveTaskServers;
}): Promise<TaskToolApprovalRequestResult> {
  if (!(await isDeploymentExperimentEnabled('integrationToolApprovals'))) {
    return { outcome: 'not_required' };
  }
  // Internal MCPs never gate: the call runs without recording an approval,
  // same as a tool with no governing policy.
  if (isInternalMcpServer(input.integrationId)) {
    return { outcome: 'not_required' };
  }
  const session = await resolveTaskApprovalSession(input.runId);
  if (!session?.ownerUserId) return { outcome: 'unavailable' };
  const context = { sessionId: session.sessionId, userId: session.ownerUserId };
  const call = {
    taskId: session.taskId,
    integrationId: input.integrationId,
    toolName: input.toolName,
    nativeRequestId: input.nativeRequestId,
    argsFingerprint: fingerprintIntegrationToolCall({
      integrationId: input.integrationId,
      toolName: input.toolName,
      args: input.args ?? null,
    }),
    argsSummary: input.args ?? null,
  };
  // Who answers is decided here, from the governing policies, never from
  // what the worker says: the agent shares a sandbox with the worker.
  const { policies, sessionOverrides } = await resolveTaskGoverningPolicies({
    actingUserId: input.actingUserId,
    resolveServers: input.resolveServers ?? (async () => ({})),
    sessionId: session.sessionId,
  });
  const isThisTool = (entry: { integrationId: string; toolName: string }) =>
    entry.integrationId === input.integrationId &&
    entry.toolName === input.toolName;
  const policyMode = policies.find(isThisTool)?.mode;
  const overrideForSession = sessionOverrides.find(isThisTool)?.mode;
  const effectiveMode = resolveEffectiveIntegrationToolMode({
    policyMode,
    sessionOverrideMode: overrideForSession,
  });
  const allowedForSession =
    overrideForSession === 'allow' || effectiveMode === 'always_allow';
  // Auto mode assesses a call to a default tool only; a tool someone made a
  // choice about is theirs to decide. Any failure on this path asks a person.
  const auto = integrationToolModeIsAutoAssessed({
    policyMode,
    sessionOverrideMode: overrideForSession,
  })
    ? await resolveIntegrationToolAutoDecision({
        integrationId: input.integrationId,
        toolName: input.toolName,
        args: input.args,
        userRequest: input.userRequest,
        userId: session.ownerUserId,
        taskId: session.taskId,
      }).catch(() => ({ action: 'ask' as const, mode: 'failed' as const }))
    : undefined;
  // A default tool asked while Auto is off (a stale native rule) runs as it
  // always has; a failed assessment asks a person instead.
  if (auto?.mode === 'off') return { outcome: 'not_required' };
  if (allowedForSession) {
    // Same reservation-and-claim audit path as a Session's own agent.
    const reservation = await insertAutoApprovedIntegrationToolApproval(
      context,
      call,
    );
    const claimed = await claimAutoApprovedIntegrationToolApproval({
      approvalId: reservation.approvalId,
      requesterUserId: session.ownerUserId,
    });
    return claimed ? { outcome: 'approved' } : { outcome: 'not_required' };
  }
  if (auto?.action === 'approve') {
    // Left `approved` rather than claimed here: for a task the integration
    // proxy is what consumes the approval, for this exact call, once.
    await insertAutoApprovedIntegrationToolApproval(context, {
      ...call,
      decidedBy: 'model',
      autoEvaluation: auto.evaluation,
    });
    return { outcome: 'approved' };
  }
  const approval = await insertIntegrationToolApproval(context, {
    ...call,
    ...(auto?.mode === 'on' ? { autoEvaluation: auto.evaluation } : {}),
  });
  return { outcome: 'pending', approvalId: approval.approvalId };
}

/** The worker's poll while the Session owner decides. */
export async function getTaskToolApprovalStatus(input: {
  runId: number;
  approvalId: string;
}): Promise<IntegrationToolApprovalStatus | 'not_found'> {
  const session = await resolveTaskApprovalSession(input.runId);
  const row = await getIntegrationToolApproval(input.approvalId);
  if (!session || !row || row.taskId !== session.taskId) return 'not_found';
  if (row.status === 'pending' && row.expiresAt.getTime() <= Date.now()) {
    await expireIntegrationToolApproval(row.id);
    return 'expired';
  }
  return row.status;
}
