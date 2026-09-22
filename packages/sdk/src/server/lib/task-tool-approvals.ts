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
import { recordIntegrationToolAutoEvaluationInBackground } from '@roomote/cloud-agents/server/integration-tool-auto-evaluation';
import {
  compileTaskIntegrationToolApprovals,
  isInternalMcpServer,
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

/** What the task run mounts, with each custom server's policy scope. */
type ResolveTaskServers = () => Promise<
  Record<string, { toolApprovalPolicyScope?: IntegrationToolPolicyScope }>
>;

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
  const servers = await input.resolveServers();
  const session = await resolveTaskApprovalSession(input.runId);
  const [deploymentPolicies, userPolicies, sessionOverrides] =
    await Promise.all([
      listIntegrationToolPolicies(),
      input.actingUserId
        ? listIntegrationToolUserPolicies(input.actingUserId)
        : Promise.resolve([]),
      session
        ? listIntegrationToolSessionOverrides(session.sessionId)
        : Promise.resolve([]),
    ]);
  return compileTaskIntegrationToolApprovals({
    serverNames: Object.keys(servers),
    policies: resolveGoverningIntegrationToolPolicies({
      deploymentPolicies,
      userPolicies,
      scopeOf: (integrationId) =>
        servers[integrationId]?.toolApprovalPolicyScope,
    }),
    sessionOverrides,
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
  /** Whose personal policies apply; see `resolveTaskIntegrationToolApprovals`. */
  actingUserId?: string;
  /** Only needed to tell whether the tool is in `auto` mode. */
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
  const overrides = await listIntegrationToolSessionOverrides(
    session.sessionId,
  );
  const allowedForSession = overrides.some(
    (override) =>
      override.mode === 'allow' &&
      override.integrationId === input.integrationId &&
      override.toolName === input.toolName,
  );
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
  const approval = await insertIntegrationToolApproval(context, call);
  // Auto is a preview: the owner is still asked, and the decision model's
  // view of the call is recorded beside their answer. None of it is awaited,
  // so nothing about it, not even finding out whether the tool is in Auto
  // mode, can fail or delay the ask.
  void isAutoTool(input)
    .then((auto) => {
      if (!auto) return;
      recordIntegrationToolAutoEvaluationInBackground(approval.approvalId, {
        integrationId: input.integrationId,
        toolName: input.toolName,
        args: input.args,
        userId: session.ownerUserId,
        taskId: session.taskId,
      });
    })
    .catch((error) => {
      console.warn(
        `[Tool approvals] Could not tell whether ${input.integrationId}/${input.toolName} is in Auto mode: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  return { outcome: 'pending', approvalId: approval.approvalId };
}

/**
 * Whether the mode governing this tool for the task is `auto`. A custom
 * server is governed by one policy layer, which only the mounted
 * configuration knows (a name can exist in both scopes, and which one is
 * mounted depends on more than the name), so the scope comes from the same
 * resolver the task's rules are compiled from. It is only resolved when some
 * layer has an Auto policy for the tool at all.
 */
async function isAutoTool(input: {
  integrationId: string;
  toolName: string;
  actingUserId?: string;
  resolveServers?: ResolveTaskServers;
}): Promise<boolean> {
  const isThisTool = (policy: { integrationId: string; toolName: string }) =>
    policy.integrationId === input.integrationId &&
    policy.toolName === input.toolName;
  const [deploymentPolicies, userPolicies] = await Promise.all([
    listIntegrationToolPolicies(),
    input.actingUserId
      ? listIntegrationToolUserPolicies(input.actingUserId)
      : Promise.resolve([]),
  ]);
  if (
    ![...deploymentPolicies, ...userPolicies].some(
      (policy) => policy.mode === 'auto' && isThisTool(policy),
    )
  ) {
    return false;
  }
  const server = (await input.resolveServers?.())?.[input.integrationId];
  // Not mounted, or nothing to say which layer governs it: no evaluation.
  if (!server) return false;
  return resolveGoverningIntegrationToolPolicies({
    deploymentPolicies,
    userPolicies,
    scopeOf: () => server.toolApprovalPolicyScope,
  }).some((policy) => policy.mode === 'auto' && isThisTool(policy));
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
