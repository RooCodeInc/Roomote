import {
  claimAutoApprovedIntegrationToolApproval,
  db,
  eq,
  expireIntegrationToolApproval,
  fingerprintIntegrationToolCall,
  getIntegrationToolApproval,
  findLatestTaskUserRequest,
  getSessionForTask,
  hasRejectedIntegrationToolInSession,
  insertAutoApprovedIntegrationToolApproval,
  insertAutoRejectedIntegrationToolApproval,
  insertIntegrationToolApproval,
  isIntegrationToolAutoSuspendedForSession,
  isSessionDelegatedTask,
  listIntegrationToolPolicies,
  listIntegrationToolSessionOverrides,
  listIntegrationToolUserPolicies,
  listRecentIntegrationToolApprovalOutcomes,
  resolveTaskIntegrationToolAutoContext,
  suspendIntegrationToolAutoForSession,
  taskRuns,
  trackedMessages,
} from '@roomote/db/server';
import { isSessionUserPresent } from '@roomote/redis';
import { listMcpTools } from '@roomote/cloud-agents/server';
import {
  describeIntegrationToolAutoDeny,
  resolveIntegrationToolAutoDecision,
  resolveIntegrationToolAutoState,
  type IntegrationToolAutoSessionContext,
} from '@roomote/cloud-agents/server/integration-tool-auto-evaluation';
import {
  compileTaskIntegrationToolApprovals,
  integrationToolModeIsAutoAssessed,
  resolveEffectiveIntegrationToolMode,
  resolveGoverningIntegrationToolPolicies,
  toIntegrationToolUserRequest,
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  getCommunicationTeamIdFromTaskPayload,
  getFastAgentParentFromPayload,
  integrationToolApprovalMessage,
  integrationToolApprovalButtons,
  integrationToolApprovalSlackBlocks,
  type IntegrationToolApprovalMetadata,
  type IntegrationToolApprovalStatus,
  type IntegrationToolPolicyScope,
  type TaskIntegrationToolApprovals,
} from '@roomote/types';
import { getCommunicationProviderAdapter } from './communication-providers';

async function publishTaskToolApproval(input: {
  payload: unknown;
  approval: IntegrationToolApprovalMetadata;
}) {
  const parent = getFastAgentParentFromPayload(input.payload);
  const parentConversation =
    parent?.conversation && 'replyTarget' in parent.conversation
      ? parent.conversation
      : undefined;
  const surface =
    getCommunicationProviderFromTaskPayload(input.payload) ??
    parentConversation?.surface;
  if (surface !== 'slack' && surface !== 'discord' && surface !== 'telegram')
    return;
  const channelId =
    getCommunicationChannelFromTaskPayload(input.payload) ??
    parentConversation?.replyTarget.channelId;
  const threadId =
    getCommunicationThreadIdFromTaskPayload(input.payload) ??
    parentConversation?.replyTarget.threadId;
  if (!channelId) return;
  const slackTeamId =
    surface === 'slack'
      ? (getCommunicationTeamIdFromTaskPayload(input.payload) ??
        parentConversation?.workspaceId)
      : undefined;
  if (surface === 'slack' && !slackTeamId) return;
  const provider = await getCommunicationProviderAdapter(surface, {
    slackTeamId,
  });
  if (!provider) return;
  const approval = input.approval;
  const text = integrationToolApprovalMessage(approval);
  const [claim] = await db
    .insert(trackedMessages)
    .values({
      surface,
      kind: 'tool_approval',
      dedupeKey: approval.approvalId,
      channelId,
      threadTs: threadId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: trackedMessages.id });
  if (!claim) return;
  try {
    const posted = await provider.postMessage({
      channelId,
      ...(threadId ? { threadId } : {}),
      text,
      ...(surface === 'slack'
        ? { blocks: integrationToolApprovalSlackBlocks(approval) }
        : { buttons: integrationToolApprovalButtons(approval.approvalId) }),
    });
    await db
      .update(trackedMessages)
      .set({ messageTs: posted.messageId })
      .where(eq(trackedMessages.id, claim.id));
  } catch (error) {
    await db.delete(trackedMessages).where(eq(trackedMessages.id, claim.id));
    throw error;
  }
}

const SESSION_PRESENCE_LOOKUP_TIMEOUT_MS = 2_000;
/**
 * An open session page renews its presence every 10 seconds, and a page that
 * just opened can briefly drop it. The owner counts as away only when a
 * second lookup, a full renewal later, still finds nobody.
 */
const SESSION_PRESENCE_RECHECK_MS = 11_000;

async function isTaskSessionOwnerPresent(input: {
  sessionId: string;
  userId: string;
  sourceSurface: string | null | undefined;
}): Promise<boolean> {
  if (
    input.sourceSurface === 'slack' ||
    input.sourceSurface === 'discord' ||
    input.sourceSurface === 'teams' ||
    input.sourceSurface === 'telegram'
  ) {
    return true;
  }
  if (await lookUpTaskSessionOwnerPresence(input)) return true;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, SESSION_PRESENCE_RECHECK_MS);
    timer.unref?.();
  });
  return lookUpTaskSessionOwnerPresence(input);
}

async function lookUpTaskSessionOwnerPresence(input: {
  sessionId: string;
  userId: string;
}): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      isSessionUserPresent({
        sessionId: input.sessionId,
        userId: input.userId,
      }),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => {
          console.warn(
            `[Task tool approvals] Presence lookup timed out for Session ${input.sessionId}; asking defensively.`,
          );
          resolve(true);
        }, SESSION_PRESENCE_LOOKUP_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } catch (error) {
    console.warn(
      `[Task tool approvals] Presence lookup failed for Session ${input.sessionId}; asking defensively: ${error instanceof Error ? error.message : String(error)}`,
    );
    return true;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Per-tool approvals for a task's agent.
 * A task belongs to one Session, so its asks are recorded on that Session,
 * decided by the Session owner on the same card, and honor the same session
 * overrides. The worker relays the agent's native ask here; the integration
 * proxy is what enforces the decision.
 */
async function resolveTaskApprovalSession(runId: number) {
  const run = await db.query.taskRuns.findFirst({
    columns: { taskId: true, payload: true },
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
    sourceSurface: session.sourceSurface,
    payload: run.payload,
  };
}

type ResolveTaskServers = () => Promise<
  Record<
    string,
    {
      url?: string;
      headers?: Record<string, string>;
      toolApprovalPolicyScope?: IntegrationToolPolicyScope;
    }
  >
>;

const TOOL_DESCRIPTION_TTL_MS = 10 * 60_000;
const TOOL_DESCRIPTION_LOOKUP_TIMEOUT_MS = 5_000;
/** How long a failed listing stands before it is tried again. */
const TOOL_DESCRIPTION_RETRY_MS = 60_000;
const TOOL_DESCRIPTION_CACHE_LIMIT = 500;
const toolDescriptionsByRunServer = new Map<
  string,
  { expiresAt: number; descriptions: Promise<Map<string, string>> }
>();

/** This API's integration proxy, reached as the task's worker reaches it. */
type TaskIntegrationProxyAccess = {
  /** The origin the worker's request arrived on. */
  origin: string;
  /** The worker's own `Authorization` header. */
  authorization: string;
};

const INTEGRATION_PROXY_PATH_PREFIX = '/api/mcp/';

/**
 * A server the task reaches through this API's integration proxy. The task's
 * token is sent nowhere else: a server mounted any other way is not listed.
 */
function isOwnIntegrationProxyUrl(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === origin &&
      parsed.pathname.startsWith(INTEGRATION_PROXY_PATH_PREFIX)
    );
  } catch {
    return false;
  }
}

/**
 * What a server says one of a task's tools does, as Auto is shown it for a
 * call by the session's own agent. A run's server is listed once and kept
 * for a while. A listing that fails or is slow leaves the call judged on its
 * name and arguments alone, and is not tried again for a minute.
 */
async function resolveTaskToolDescription(input: {
  runId: number;
  integrationId: string;
  toolName: string;
  server: { url?: string; headers?: Record<string, string> } | undefined;
  integrationProxy: TaskIntegrationProxyAccess | undefined;
}): Promise<string | undefined> {
  const url = input.server?.url;
  const proxy = input.integrationProxy;
  if (!url || !proxy || !isOwnIntegrationProxyUrl(url, proxy.origin)) {
    return undefined;
  }
  const key = `${input.runId}:${input.integrationId}`;
  const now = Date.now();
  let cached = toolDescriptionsByRunServer.get(key);
  if (!cached || cached.expiresAt <= now) {
    for (const [staleKey, entry] of toolDescriptionsByRunServer) {
      if (
        entry.expiresAt <= now ||
        toolDescriptionsByRunServer.size >= TOOL_DESCRIPTION_CACHE_LIMIT
      ) {
        toolDescriptionsByRunServer.delete(staleKey);
      }
    }
    const descriptions = listMcpTools({
      url,
      headers: {
        ...input.server?.headers,
        authorization: proxy.authorization,
      },
      signal: AbortSignal.timeout(TOOL_DESCRIPTION_LOOKUP_TIMEOUT_MS),
    }).then(
      (tools) =>
        new Map(
          tools.flatMap((tool) =>
            tool.description ? [[tool.name, tool.description] as const] : [],
          ),
        ),
    );
    const entry = { expiresAt: now + TOOL_DESCRIPTION_TTL_MS, descriptions };
    cached = entry;
    toolDescriptionsByRunServer.set(key, entry);
    // A failed listing is tried again, but not on every call: a server that
    // cannot be listed would otherwise hold up each of the task's asks.
    descriptions.catch(() => {
      entry.expiresAt = Math.min(
        entry.expiresAt,
        Date.now() + TOOL_DESCRIPTION_RETRY_MS,
      );
    });
  }
  return cached.descriptions
    .then((descriptions) => descriptions.get(input.toolName))
    .catch(() => undefined);
}

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
  resolveServers: ResolveTaskServers;
}): Promise<TaskIntegrationToolApprovals | undefined> {
  const session = await resolveTaskApprovalSession(input.runId);
  const [{ servers, policies, sessionOverrides }, autoState] =
    await Promise.all([
      resolveTaskGoverningPolicies({
        actingUserId: input.actingUserId,
        resolveServers: input.resolveServers,
        sessionId: session?.sessionId,
      }),
      resolveIntegrationToolAutoState({ sessionId: session?.sessionId }),
    ]);
  return compileTaskIntegrationToolApprovals({
    serverNames: Object.keys(servers),
    policies,
    sessionOverrides,
    autoOn: autoState.mode === 'on',
  });
}

/**
 * What Auto judges a task's call against: the same things it is shown for a
 * call by the session's own agent. A lookup that fails removes context; it
 * cannot authorize a call by itself, and a failed rejection lookup counts as
 * a rejection, so Auto asks.
 */
async function resolveTaskAutoContext(input: {
  sessionId: string;
  taskId: string;
  ownerUserId: string;
  integrationId: string;
  toolName: string;
  reportedUserRequest: string | undefined;
}): Promise<{
  userRequest: string | undefined;
  sessionContext: IntegrationToolAutoSessionContext | undefined;
  readContent: string | undefined;
}> {
  const decided = {
    sessionId: input.sessionId,
    userId: input.ownerUserId,
    taskId: input.taskId,
  };
  const [context, explicitApprovalOutcomes, toolRejectedInSession] =
    await Promise.all([
      resolveTaskIntegrationToolAutoContext({
        sessionId: input.sessionId,
        taskId: input.taskId,
      }).catch(() => undefined),
      listRecentIntegrationToolApprovalOutcomes(decided).catch(() => []),
      hasRejectedIntegrationToolInSession({
        ...decided,
        integrationId: input.integrationId,
        toolName: input.toolName,
      }).catch(() => true),
    ]);
  const userRequest =
    context?.userRequest ??
    toIntegrationToolUserRequest(input.reportedUserRequest) ??
    (await findLatestTaskUserRequest(input.taskId).catch(() => undefined));
  return {
    userRequest,
    sessionContext: {
      recentUserMessages: context?.recentUserMessages ?? [],
      explicitApprovalOutcomes,
      ...(context?.agentMessageRepliedTo
        ? { agentMessageRepliedTo: context.agentMessageRepliedTo }
        : {}),
      ...(toolRejectedInSession ? { toolRejectedInSession } : {}),
      // Left out when the lookup failed: without the task's results there is
      // nothing to check an identifier against.
      ...(context ? { recentToolResults: context.recentToolResults } : {}),
    },
    readContent: context?.readContent,
  };
}

type TaskToolApprovalRequestResult =
  /** Nothing gates the call any more; let it run. */
  | { outcome: 'not_required' }
  /** Nobody can decide for this task, so the call cannot be approved. */
  | { outcome: 'unavailable' }
  /** The Session owner already chose not to be asked about this tool. */
  | { outcome: 'approved' }
  /** Auto mode blocked the call; the reason goes back to the model. */
  | { outcome: 'denied'; reason: string }
  /**
   * The call could not be assessed, so Auto stopped for the session; the
   * call did not run and later calls ask the owner.
   */
  | { outcome: 'paused' }
  | { outcome: 'pending'; approvalId: string };

/** Record one native ask from a task's agent. */
export async function requestTaskToolApproval(input: {
  runId: number;
  integrationId: string;
  toolName: string;
  nativeRequestId: string;
  args?: unknown;
  /**
   * The prompt the task's agent is working on, as its worker reports it. It
   * stands in only when the server finds no request for the task itself.
   */
  userRequest?: string;
  /** Whose personal policies apply, and what the run mounts: they decide who answers. */
  actingUserId?: string;
  resolveServers?: ResolveTaskServers;
  /** How to list a mounted server's tools, for their descriptions. */
  integrationProxy?: TaskIntegrationProxyAccess;
}): Promise<TaskToolApprovalRequestResult> {
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
  const { servers, policies, sessionOverrides } =
    await resolveTaskGoverningPolicies({
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
  // choice about is theirs to decide. A risky or unavailable assessment asks
  // the Session owner when present and is denied when they are away.
  const autoCandidate = integrationToolModeIsAutoAssessed({
    policyMode,
    sessionOverrideMode: overrideForSession,
  });
  // After Auto stopped for the session its default tools ask the owner,
  // unless Auto has since been turned off, when they run as they always have.
  const autoSuspended =
    autoCandidate &&
    (await isIntegrationToolAutoSuspendedForSession(session.sessionId));
  if (
    autoSuspended &&
    (await resolveIntegrationToolAutoState({ sessionId: session.sessionId }))
      .mode !== 'on'
  ) {
    return { outcome: 'not_required' };
  }
  const autoAssessed = autoCandidate && !autoSuspended;
  const [autoContext, toolDescription] = autoAssessed
    ? await Promise.all([
        resolveTaskAutoContext({
          sessionId: session.sessionId,
          taskId: session.taskId,
          ownerUserId: session.ownerUserId,
          integrationId: input.integrationId,
          toolName: input.toolName,
          reportedUserRequest: input.userRequest,
        }),
        resolveTaskToolDescription({
          runId: input.runId,
          integrationId: input.integrationId,
          toolName: input.toolName,
          server: servers[input.integrationId],
          integrationProxy: input.integrationProxy,
        }),
      ])
    : [undefined, undefined];
  const auto =
    autoAssessed && autoContext
      ? await resolveIntegrationToolAutoDecision({
          integrationId: input.integrationId,
          toolName: input.toolName,
          ...(toolDescription ? { toolDescription } : {}),
          args: input.args,
          userRequest: autoContext.userRequest,
          sessionContext: autoContext.sessionContext,
          readContent: autoContext.readContent,
          isSessionLaunchedTask: (taskId) =>
            isSessionDelegatedTask(session.sessionId, taskId),
          userId: session.ownerUserId,
          taskId: session.taskId,
          sessionId: session.sessionId,
        }).catch(() => ({
          action: 'ask' as const,
          mode: 'on' as const,
          evaluation: {
            recommendation: 'ask' as const,
            unavailable: 'error' as const,
            evaluatedAt: new Date().toISOString(),
          },
        }))
      : undefined;
  // A default tool asked while Auto is off (a stale native rule) runs as it
  // always has.
  if (auto?.mode === 'off') return { outcome: 'not_required' };
  if (auto?.evaluation.unavailable) {
    // The call could not be assessed: stop Auto for the session rather than
    // ask about (or deny) every call while assessment is down.
    await suspendIntegrationToolAutoForSession(session.sessionId);
    await insertAutoRejectedIntegrationToolApproval(context, {
      ...call,
      autoEvaluation: auto.evaluation,
    });
    return { outcome: 'paused' };
  }
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
  if (auto?.action === 'ask') {
    const ownerPresent = await isTaskSessionOwnerPresent({
      sessionId: session.sessionId,
      userId: session.ownerUserId,
      sourceSurface: session.sourceSurface,
    });
    if (!ownerPresent) {
      // Born-terminal audit row; no card is shown while the owner is away.
      await insertAutoRejectedIntegrationToolApproval(context, {
        ...call,
        autoEvaluation: auto.evaluation,
      });
      return {
        outcome: 'denied',
        reason: describeIntegrationToolAutoDeny(auto.evaluation),
      };
    }
  }
  const approval = await insertIntegrationToolApproval(context, {
    ...call,
    ...(auto?.action === 'ask' ? { autoEvaluation: auto.evaluation } : {}),
  });
  await publishTaskToolApproval({ payload: session.payload, approval }).catch(
    (error) => {
      console.warn(
        `[Task tool approvals] Could not post approval notification: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
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
