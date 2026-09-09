import { createAuthToken } from '@roomote/auth';
import type { FastAgentTurnAdapter } from '@roomote/cloud-agents/server';
import {
  and,
  db,
  deploymentSettings,
  eq,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  environments,
  environmentVariables,
  fastAgentConversations,
  fastAgentParentEvents,
  githubInstallations,
  githubPendingInstallations,
  repositories,
  sourceControlConnectionRequests,
  users,
  ensureSessionForFastConversation,
  getSessionForFastConversation,
  resolveDeploymentEnvVar,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import {
  ALL_REPOSITORIES,
  buildSetupSourceControlStatus,
  fastAgentConversationSchema,
  NON_SECRET_SOURCE_CONTROL_ENV_VAR_NAMES,
  ROOMOTE_MCP_ID,
  type SourceControlProvider,
} from '@roomote/types';

export type SourceControlConnectionTarget = {
  provider?: SourceControlProvider;
  repositoryFullName?: string;
  environmentId?: string;
  capability: 'repository' | 'source_control_tool';
};
export type SourceControlConnectionTool = {
  integrationId: string;
  toolName: string;
};
type SourceControlOperation = SourceControlConnectionTarget & {
  tool?: SourceControlConnectionTool;
};
export type SourceControlReadiness = {
  status:
    | 'ready'
    | 'not_connected'
    | 'approval_pending'
    | 'sync_pending'
    | 'sync_failed'
    | 'repository_unavailable'
    | 'discovery_unavailable'
    | 'forbidden'
    | 'target_required';
  action:
    | 'none'
    | 'connect'
    | 'ask_admin'
    | 'check_status'
    | 'select_repository'
    | 'retry_discovery';
  provider?: SourceControlProvider;
};
/** Supplied by the runtime's broker, never from client input or OAuth state. */
export type SourceControlReadinessOptions = {
  /** An authoritative sync result supplied by a server-side provider adapter. */
  syncState?: 'pending' | 'failed';
  successfulSync?: { startedAt: string; repositoryFullNames: string[] };
  probeSourceControlTools?: (input: {
    actorUserId: string;
    provider: SourceControlProvider;
    tool: SourceControlConnectionTool;
    fresh: true;
  }) => Promise<boolean>;
};
export type SourceControlConnectionRequest =
  typeof sourceControlConnectionRequests.$inferSelect;
export type RequestSourceControlConnectionInput = SourceControlOperation & {
  conversationId: string;
  actorUserId: string;
  turnId: string;
};
export type SourceControlConnectionRequestView =
  SourceControlConnectionRequest & { url: string };
const active = ['pending', 'ready'] as const;
const lifetimeMs = 24 * 60 * 60 * 1000;
// Keep PostgreSQL's microsecond precision across processes and JSON persistence.
const sourceControlSyncClock = sql<string>`to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Strict opt-in, serialized with metadata updates inside admission transactions. */
export async function isSourceControlConnectionEnabled(
  executor: DatabaseOrTransaction = db,
): Promise<boolean> {
  const [settings] = await executor
    .select({ metadata: deploymentSettings.metadata })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, 'default'))
    .for('share');
  const metadata = settings?.metadata;
  return Boolean(
    metadata &&
    typeof metadata === 'object' &&
    'optional_source_control_enabled' in metadata &&
    metadata.optional_source_control_enabled === true,
  );
}

async function enforceRollout(tx: DatabaseOrTransaction): Promise<boolean> {
  if (await isSourceControlConnectionEnabled(tx)) return true;
  await tx
    .update(sourceControlConnectionRequests)
    .set({
      status: 'continued',
      updatedAt: new Date(),
      revision: sql`${sourceControlConnectionRequests.revision} + 1`,
    })
    .where(
      and(
        eq(sourceControlConnectionRequests.status, 'ready'),
        sql`exists (select 1 from ${fastAgentParentEvents} where ${fastAgentParentEvents.eventKey} = ${sourceControlConnectionRequests.continuationEventKey} and ${fastAgentParentEvents.deliveredAt} is not null)`,
      ),
    );
  const cancelled = await tx
    .update(sourceControlConnectionRequests)
    .set({
      status: 'cancelled',
      reason: 'feature_disabled',
      updatedAt: new Date(),
      revision: sql`${sourceControlConnectionRequests.revision} + 1`,
    })
    .where(inArray(sourceControlConnectionRequests.status, active))
    .returning({
      eventKey: sourceControlConnectionRequests.continuationEventKey,
    });
  await discardRetiredEvents(tx, cancelled);
  return false;
}

/** Also used by durable recovery so disabling never leaves an automatic resume parked. */
export async function enforceSourceControlConnectionRollout(
  executor: DatabaseOrTransaction = db,
): Promise<boolean> {
  return executor.transaction(enforceRollout);
}

async function probeSourceControlTools(input: {
  actorUserId: string;
  provider: SourceControlProvider;
  tool: SourceControlConnectionTool;
}): Promise<boolean> {
  // The built-in GitHub broker is currently the only provider-specific MCP catalog.
  if (input.provider !== 'github') return false;
  const { getRouterMcpServerPolicy, listMcpTools, resolveApiBaseUrl } =
    await import('@roomote/cloud-agents/server');
  const baseUrl = resolveApiBaseUrl();
  if (!baseUrl || !getRouterMcpServerPolicy('github').enabled) return false;
  const token = await createAuthToken({
    userId: input.actorUserId,
    timeoutMs: 60_000,
  });
  const tools = await listMcpTools({
    url: new URL('api/mcp-routing/github', `${baseUrl}/`).toString(),
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  return tools.some((tool) => tool.name === input.tool.toolName);
}

/** Dependency seam shared by web and all persisted parent-event surfaces. */
export function createSourceControlConnectionAdapter(
  options: SourceControlReadinessOptions = {},
  continuation?: { requestId: string; conversationId: string },
): Pick<
  FastAgentTurnAdapter,
  | 'getSourceControlReadiness'
  | 'requestSourceControlConnection'
  | 'supersedeSourceControlConnectionRequests'
> {
  // Turn-local correlation only: an exact attempted tool may be carried into
  // the subsequent request action, never reconstructed from provider support.
  const attemptedTools = new Map<string, SourceControlConnectionTool | null>();
  const operationKey = (
    actorUserId: string,
    target: SourceControlConnectionTarget,
  ) =>
    JSON.stringify([
      actorUserId,
      target.provider,
      target.repositoryFullName?.trim(),
      target.environmentId,
      target.capability,
    ]);
  return {
    getSourceControlReadiness: async ({ actorUserId, target, tool }) => {
      if (!(await enforceSourceControlConnectionRollout())) {
        // The old operation's own authorization still runs. Omitting this
        // adapter is not sufficient: Fast treats a missing preflight as denial.
        return { status: continuation ? 'forbidden' : 'ready' };
      }
      if (
        continuation &&
        !(await validateSourceControlConnectionContinuation(
          { ...continuation, forOperation: true },
          options,
        ))
      )
        return { status: 'forbidden' };
      const result = await getSourceControlReadiness(
        { actorUserId, ...target, tool },
        options,
      );
      if (tool && result.status !== 'ready') {
        const key = operationKey(actorUserId, target);
        const previous = attemptedTools.get(key);
        attemptedTools.set(
          key,
          previous === undefined ||
            (previous?.integrationId === tool.integrationId &&
              previous?.toolName === tool.toolName)
            ? tool
            : null,
        );
      }
      return result;
    },
    requestSourceControlConnection: async ({ target, ...context }) => {
      if (!(await enforceSourceControlConnectionRollout()))
        throw new Error('Source-control connection requests are disabled.');
      const tool =
        attemptedTools.get(operationKey(context.actorUserId, target)) ??
        undefined;
      const result = await getSourceControlReadiness(
        { actorUserId: context.actorUserId, ...target, tool },
        options,
      );
      if (result.status === 'ready') return { status: 'ready' };
      const request = await requestSourceControlConnection(
        { ...context, ...target, tool },
        options,
      );
      return {
        status: 'pending',
        requestId: request.id,
        connectionUrl: request.url,
      };
    },
    supersedeSourceControlConnectionRequests: async (input) => {
      await supersedeSourceControlConnectionRequests(input);
    },
  };
}

async function actor(executor: DatabaseOrTransaction, actorUserId: string) {
  const [user] = await executor
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.id, actorUserId), isNull(users.deletedAt)))
    .limit(1);
  return user;
}

function targetOf(
  request: SourceControlConnectionRequest,
): SourceControlOperation {
  return {
    capability: request.capability,
    ...(request.tool ? { tool: request.tool } : {}),
    ...(request.provider ? { provider: request.provider } : {}),
    ...(request.repositoryFullName
      ? { repositoryFullName: request.repositoryFullName }
      : {}),
    ...(request.environmentId ? { environmentId: request.environmentId } : {}),
  };
}

/** Deployment membership grants repository use, not connection administration. */
export async function getSourceControlReadiness(
  input: SourceControlOperation & { actorUserId: string },
  options: SourceControlReadinessOptions = {},
): Promise<SourceControlReadiness> {
  return readiness(db, input, options);
}

/** Capture before reading credentials. The lock is released before remote work. */
export async function getSourceControlSyncStartedAt(
  provider: SourceControlProvider,
  executor: DatabaseOrTransaction = db,
): Promise<string> {
  return executor.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`source-control-config:${provider}`}))`,
    );
    const [clock] = await tx.execute<{ startedAt: string }>(
      sql`select ${sourceControlSyncClock} as "startedAt"`,
    );
    return clock!.startedAt;
  });
}

/** Must run inside the configuration-write transaction, before changing credentials. */
export async function requireSourceControlConnectionSync(
  provider: SourceControlProvider,
  executor: DatabaseOrTransaction = db,
) {
  await executor.transaction(async (tx) => {
    // Nested transaction locks survive until the caller's config transaction commits.
    const startedAt = await getSourceControlSyncStartedAt(provider, tx);
    // Match admission's metadata -> conversation -> request -> event lock order.
    if (!(await isSourceControlConnectionEnabled(tx))) return;
    const candidates = await tx
      .select({
        id: sourceControlConnectionRequests.id,
        conversationId: sourceControlConnectionRequests.conversationId,
      })
      .from(sourceControlConnectionRequests)
      .where(
        and(
          inArray(sourceControlConnectionRequests.status, active),
          or(
            eq(sourceControlConnectionRequests.provider, provider),
            isNull(sourceControlConnectionRequests.provider),
          ),
        ),
      )
      .orderBy(sourceControlConnectionRequests.conversationId);
    for (const candidate of candidates) {
      if (!(await lockConversation(tx, candidate.conversationId, true)))
        continue;
      const invalidated = await tx
        .update(sourceControlConnectionRequests)
        .set({
          status: sql`case when ${sourceControlConnectionRequests.status} = 'ready' then 'superseded' else ${sourceControlConnectionRequests.status} end`,
          syncAttempt: { provider, startedAt, state: 'pending' },
          reason: 'sync_pending',
          updatedAt: sql`clock_timestamp()`,
          revision: sql`${sourceControlConnectionRequests.revision} + 1`,
        })
        .where(
          and(
            eq(sourceControlConnectionRequests.id, candidate.id),
            inArray(sourceControlConnectionRequests.status, active),
          ),
        )
        .returning({
          eventKey: sourceControlConnectionRequests.continuationEventKey,
        });
      await discardRetiredEvents(tx, invalidated);
    }
  });
}

async function readiness(
  executor: DatabaseOrTransaction,
  input: SourceControlOperation & { actorUserId: string },
  options: SourceControlReadinessOptions,
  discoveryChecked = false,
): Promise<SourceControlReadiness> {
  const user = await actor(executor, input.actorUserId);
  if (!user) return { status: 'forbidden', action: 'none' };
  if (
    input.repositoryFullName &&
    (/[\\<>?#:\u0000-\u001f]/.test(input.repositoryFullName) ||
      input.repositoryFullName.trim().split('/').length < 2 ||
      input.repositoryFullName
        .trim()
        .split('/')
        .some((part) => !part || part === '.' || part === '..'))
  )
    return { status: 'target_required', action: 'select_repository' };
  if (input.environmentId === ALL_REPOSITORIES && !input.repositoryFullName) {
    const inventory = await executor
      .select({
        fullName: repositories.fullName,
        provider: repositories.sourceControlProvider,
      })
      .from(repositories)
      .where(
        and(
          eq(repositories.isActive, true),
          input.provider
            ? eq(repositories.sourceControlProvider, input.provider)
            : undefined,
        ),
      );
    if (!inventory.length)
      return { status: 'target_required', action: 'select_repository' };
    for (const repository of inventory) {
      const result = await readiness(
        executor,
        {
          actorUserId: input.actorUserId,
          capability: input.capability,
          tool: input.tool,
          repositoryFullName: repository.fullName,
          provider: repository.provider,
        },
        options,
      );
      if (result.status !== 'ready') return result;
    }
    return { status: 'ready', action: 'none' };
  }
  if (input.environmentId && input.environmentId !== ALL_REPOSITORIES) {
    const [environment] = await executor
      .select()
      .from(environments)
      .where(eq(environments.id, input.environmentId))
      .limit(1);
    if (!environment) return { status: 'forbidden', action: 'none' };
    // No-repository environments need no source-control connection.
    for (const repository of environment.config.repositories ?? []) {
      const result = await readiness(
        executor,
        {
          actorUserId: input.actorUserId,
          capability: input.capability,
          tool: input.tool,
          provider: input.provider,
          repositoryFullName: repository.repository,
        },
        options,
      );
      if (result.status !== 'ready') return result;
    }
    if (!input.repositoryFullName && input.capability === 'repository')
      return { status: 'ready', action: 'none' };
  }
  const rows = await executor
    .select({
      repository: repositories,
      suspendedAt: githubInstallations.suspendedAt,
      installationId: githubInstallations.id,
    })
    .from(repositories)
    .leftJoin(
      githubInstallations,
      eq(repositories.installationId, githubInstallations.id),
    )
    .where(
      and(
        eq(repositories.isActive, true),
        input.provider
          ? eq(repositories.sourceControlProvider, input.provider)
          : undefined,
        input.repositoryFullName
          ? eq(repositories.fullName, input.repositoryFullName.trim())
          : undefined,
      ),
    );
  const usable = rows.filter(
    (row) =>
      (!options.successfulSync ||
        options.successfulSync.repositoryFullNames.includes(
          row.repository.fullName,
        )) &&
      (row.repository.sourceControlProvider !== 'github' ||
        (row.installationId && !row.suspendedAt)),
  );
  if (
    !input.repositoryFullName &&
    !input.environmentId &&
    input.capability === 'repository'
  ) {
    return { status: 'target_required', action: 'select_repository' };
  }
  if (input.repositoryFullName && rows.length > 1)
    return { status: 'target_required', action: 'select_repository' };
  if (
    !input.provider &&
    new Set(usable.map((row) => row.repository.sourceControlProvider)).size > 1
  )
    return { status: 'target_required', action: 'select_repository' };
  const provider =
    input.provider ?? usable[0]?.repository.sourceControlProvider;
  if (!provider)
    return {
      status: input.repositoryFullName
        ? 'repository_unavailable'
        : 'target_required',
      action: 'select_repository',
    };
  const connectAction = user.role === 'admin' ? 'connect' : 'ask_admin';
  if (provider === 'github') {
    const installations = await executor
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(isNull(githubInstallations.suspendedAt))
      .limit(1);
    if (!installations.length) {
      const pending = await executor
        .select({ id: githubPendingInstallations.id })
        .from(githubPendingInstallations)
        .limit(1);
      return {
        status: pending.length ? 'approval_pending' : 'not_connected',
        action: pending.length ? 'check_status' : connectAction,
        provider,
      };
    }
  } else {
    const saved = await executor
      .select({ key: environmentVariables.name })
      .from(environmentVariables);
    const nonSecrets = Object.fromEntries(
      await Promise.all(
        NON_SECRET_SOURCE_CONTROL_ENV_VAR_NAMES.map(async (name) => [
          name,
          (await resolveDeploymentEnvVar(name)) ?? '',
        ]),
      ),
    );
    const config = buildSetupSourceControlStatus({
      runtimeEnv: process.env,
      persistedEnvVarNames: saved.map((entry) => entry.key),
      persistedEnvVarValues: nonSecrets,
    });
    if (
      !config.providers.find((entry) => entry.provider === provider)
        ?.configSatisfied
    )
      return { status: 'not_connected', action: connectAction, provider };
  }
  if (options.syncState)
    return {
      status: options.syncState === 'failed' ? 'sync_failed' : 'sync_pending',
      action: 'check_status',
      provider,
    };
  if (!usable.length)
    return {
      status: input.repositoryFullName
        ? 'repository_unavailable'
        : 'sync_pending',
      action: 'check_status',
      provider,
    };
  if (input.capability === 'source_control_tool') {
    if (
      input.tool?.integrationId === ROOMOTE_MCP_ID &&
      input.tool.toolName === 'manage_source_control'
    )
      return { status: 'ready', action: 'none', provider };
    if (!input.tool || input.tool.integrationId !== provider)
      return {
        status: 'discovery_unavailable',
        action: 'retry_discovery',
        provider,
      };
    if (discoveryChecked) return { status: 'ready', action: 'none', provider };
    // Repository support is not evidence that a provider has a reachable tool catalog.
    const available = await (
      options.probeSourceControlTools ?? probeSourceControlTools
    )({
      actorUserId: input.actorUserId,
      provider,
      tool: input.tool,
      fresh: true,
    }).catch(() => false);
    if (!available)
      return {
        status: 'discovery_unavailable',
        action: 'retry_discovery',
        provider,
      };
    // A remote probe may outlive an actor or repository revocation.
    return readiness(executor, input, options, true);
  }
  return { status: 'ready', action: 'none', provider };
}

async function lockConversation(
  tx: DatabaseOrTransaction,
  conversationId: string,
  optional = false,
) {
  const [conversation] = await tx
    .select()
    .from(fastAgentConversations)
    .where(eq(fastAgentConversations.id, conversationId))
    .for('update');
  if (!conversation && !optional) throw new Error('Session not found.');
  return conversation;
}

async function expire(tx: DatabaseOrTransaction, conversationId: string) {
  const expired = await tx
    .update(sourceControlConnectionRequests)
    .set({
      status: 'expired',
      updatedAt: new Date(),
      revision: sql`${sourceControlConnectionRequests.revision} + 1`,
    })
    .where(
      and(
        eq(sourceControlConnectionRequests.conversationId, conversationId),
        inArray(sourceControlConnectionRequests.status, active),
        lte(sourceControlConnectionRequests.expiresAt, new Date()),
      ),
    )
    .returning({
      eventKey: sourceControlConnectionRequests.continuationEventKey,
    });
  await discardRetiredEvents(tx, expired);
}

async function discardRetiredEvents(
  tx: DatabaseOrTransaction,
  requests: { eventKey: string | null }[],
) {
  const keys = requests.flatMap((request) =>
    request.eventKey ? [request.eventKey] : [],
  );
  if (!keys.length) return;
  await tx
    .update(fastAgentParentEvents)
    .set({
      discardedAt: new Date(),
      lastError: 'Connection request is no longer active.',
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(fastAgentParentEvents.eventKey, keys),
        isNull(fastAgentParentEvents.deliveredAt),
        isNull(fastAgentParentEvents.discardedAt),
      ),
    );
}

async function view(
  tx: DatabaseOrTransaction,
  request: SourceControlConnectionRequest,
): Promise<SourceControlConnectionRequestView> {
  const session = await getSessionForFastConversation(
    tx,
    request.conversationId,
  );
  if (!session) throw new Error('Session not found.');
  return {
    ...request,
    url: `/sessions/${encodeURIComponent(session.id)}?connectionRequest=${encodeURIComponent(request.id)}`,
  };
}

export async function requestSourceControlConnection(
  input: RequestSourceControlConnectionInput,
  options: SourceControlReadinessOptions = {},
): Promise<SourceControlConnectionRequestView> {
  if (!input.turnId.trim()) throw new Error('An originating turn is required.');
  const result = await db.transaction(async (tx) => {
    if (!(await enforceRollout(tx))) return null;
    await lockConversation(tx, input.conversationId);
    if (!(await actor(tx, input.actorUserId))) throw new Error('Forbidden.');
    const session = await ensureSessionForFastConversation(
      tx,
      input.conversationId,
    );
    if (session.archivedAt) throw new Error('Session is archived.');
    await expire(tx, input.conversationId);
    const [existing] = await tx
      .select()
      .from(sourceControlConnectionRequests)
      .where(
        and(
          eq(
            sourceControlConnectionRequests.conversationId,
            input.conversationId,
          ),
          inArray(sourceControlConnectionRequests.status, active),
        ),
      );
    if (existing) {
      if (
        existing.actorUserId !== input.actorUserId ||
        existing.turnId !== input.turnId ||
        existing.capability !== input.capability ||
        existing.provider !== (input.provider ?? null) ||
        existing.repositoryFullName !==
          (input.repositoryFullName?.trim() ?? null) ||
        existing.environmentId !== (input.environmentId ?? null) ||
        existing.tool?.integrationId !== input.tool?.integrationId ||
        existing.tool?.toolName !== input.tool?.toolName
      ) {
        throw new Error(
          'An active connection request already exists for this Session.',
        );
      }
      return view(tx, existing);
    }
    const result = await readiness(tx, input, options);
    if (result.status === 'forbidden' || result.status === 'target_required')
      throw new Error(
        'A permitted, unambiguous source-control target is required.',
      );
    const [request] = await tx
      .insert(sourceControlConnectionRequests)
      .values({
        conversationId: input.conversationId,
        actorUserId: input.actorUserId,
        turnId: input.turnId,
        provider: input.provider,
        repositoryFullName: input.repositoryFullName?.trim(),
        environmentId: input.environmentId,
        capability: input.capability,
        tool: input.tool,
        reason: result.status,
        syncAttempt:
          options.syncState && input.provider
            ? sql`jsonb_build_object('provider', ${input.provider}::text, 'startedAt', ${sourceControlSyncClock}, 'state', ${options.syncState}::text)`
            : null,
        expiresAt: new Date(Date.now() + lifetimeMs),
      })
      .returning();
    return view(tx, request!);
  });
  if (!result)
    throw new Error('Source-control connection requests are disabled.');
  return result;
}

export async function getSourceControlConnectionRequest(input: {
  requestId: string;
  actorUserId: string;
  conversationId?: string;
}): Promise<SourceControlConnectionRequestView | null> {
  if (!(await actor(db, input.actorUserId))) throw new Error('Forbidden.');
  const [found] = await db
    .select()
    .from(sourceControlConnectionRequests)
    .where(
      and(
        eq(sourceControlConnectionRequests.id, input.requestId),
        input.conversationId
          ? eq(
              sourceControlConnectionRequests.conversationId,
              input.conversationId,
            )
          : undefined,
      ),
    );
  if (!found) return null;
  return db.transaction(async (tx) => {
    await enforceRollout(tx);
    await lockConversation(tx, found.conversationId);
    await expire(tx, found.conversationId);
    const [request] = await tx
      .select()
      .from(sourceControlConnectionRequests)
      .where(eq(sourceControlConnectionRequests.id, found.id));
    return request ? view(tx, request) : null;
  });
}

export async function cancelSourceControlConnectionRequest(input: {
  requestId: string;
  actorUserId: string;
  conversationId?: string;
}): Promise<SourceControlConnectionRequestView | null> {
  const found = await getSourceControlConnectionRequest(input);
  if (!found) return null;
  return db.transaction(async (tx) => {
    await lockConversation(tx, found.conversationId);
    const user = await actor(tx, input.actorUserId);
    if (!user || (found.actorUserId !== user.id && user.role !== 'admin'))
      throw new Error('Forbidden.');
    await expire(tx, found.conversationId);
    const [current] = await tx
      .select()
      .from(sourceControlConnectionRequests)
      .where(eq(sourceControlConnectionRequests.id, found.id));
    if (!current) return null;
    if (current.status === 'ready' && current.executionStartedAt)
      throw new Error(
        'Continuation has started; use Session cancellation to stop running work.',
      );
    const [cancelled] = await tx
      .update(sourceControlConnectionRequests)
      .set({
        status: 'cancelled',
        updatedAt: new Date(),
        revision: sql`${sourceControlConnectionRequests.revision} + 1`,
      })
      .where(
        and(
          eq(sourceControlConnectionRequests.id, current.id),
          inArray(sourceControlConnectionRequests.status, active),
        ),
      )
      .returning();
    if (cancelled)
      await discardRetiredEvents(tx, [
        { eventKey: cancelled.continuationEventKey },
      ]);
    return view(tx, cancelled ?? current);
  });
}

/** Call at substantive human-turn admission, not status polling. */
export async function supersedeSourceControlConnectionRequests(
  input: { conversationId: string; actorUserId: string; turnId: string },
  executor: DatabaseOrTransaction = db,
): Promise<number> {
  return executor.transaction(async (tx) => {
    if (!(await enforceRollout(tx))) return 0;
    if (!(await actor(tx, input.actorUserId))) throw new Error('Forbidden.');
    const rows = await tx
      .update(sourceControlConnectionRequests)
      .set({
        status: 'superseded',
        updatedAt: new Date(),
        revision: sql`${sourceControlConnectionRequests.revision} + 1`,
      })
      .where(
        and(
          eq(
            sourceControlConnectionRequests.conversationId,
            input.conversationId,
          ),
          ne(sourceControlConnectionRequests.turnId, input.turnId),
          inArray(sourceControlConnectionRequests.status, active),
        ),
      )
      .returning({
        eventKey: sourceControlConnectionRequests.continuationEventKey,
      });
    await discardRetiredEvents(tx, rows);
    return rows.length;
  });
}

/** Sync/callback entry point. Readiness and event admission commit together. */
export async function reconcileSourceControlConnectionRequests(
  input: {
    provider?: SourceControlProvider;
    conversationId?: string;
    requestId?: string;
    completedByUserId?: string;
    attemptRevision?: number;
  } = {},
  options: SourceControlReadinessOptions = {},
): Promise<{ ready: number }> {
  if (
    input.completedByUserId &&
    (await actor(db, input.completedByUserId))?.role !== 'admin'
  )
    throw new Error('Forbidden.');
  const candidates = await db
    .select()
    .from(sourceControlConnectionRequests)
    .where(
      and(
        inArray(sourceControlConnectionRequests.status, active),
        input.provider
          ? or(
              eq(sourceControlConnectionRequests.provider, input.provider),
              isNull(sourceControlConnectionRequests.provider),
            )
          : undefined,
        input.conversationId
          ? eq(
              sourceControlConnectionRequests.conversationId,
              input.conversationId,
            )
          : undefined,
        input.requestId
          ? eq(sourceControlConnectionRequests.id, input.requestId)
          : undefined,
      ),
    );
  const {
    admitSourceControlConnectionReadyEvent,
    wakeFastAgentParentEventNow,
  } = await import('./fast-agent-parent-event-queue');
  let ready = 0;
  for (const candidate of candidates) {
    const wakeup = await db.transaction(async (tx) => {
      if (!(await enforceRollout(tx))) return null;
      const conversation = await lockConversation(
        tx,
        candidate.conversationId,
        true,
      );
      if (!conversation) return null;
      await expire(tx, conversation.id);
      const [request] = await tx
        .select()
        .from(sourceControlConnectionRequests)
        .where(eq(sourceControlConnectionRequests.id, candidate.id))
        .for('update');
      if (!request) return null;
      if (
        input.attemptRevision !== undefined &&
        request.revision !== input.attemptRevision
      )
        return null;
      if (request.status === 'ready' && request.continuationEventKey) {
        const [event] = await tx
          .select({ deliveredAt: fastAgentParentEvents.deliveredAt })
          .from(fastAgentParentEvents)
          .where(
            eq(fastAgentParentEvents.eventKey, request.continuationEventKey),
          )
          .limit(1);
        if (event?.deliveredAt)
          await settleSourceControlConnectionRequest(
            { requestId: request.id, conversationId: request.conversationId },
            tx,
          );
        return null;
      }
      if (request.status !== 'pending') return null;
      const session = await getSessionForFastConversation(tx, conversation.id);
      if (!session || session.archivedAt) return null;
      const syncProvider =
        input.provider ?? request.syncAttempt?.provider ?? request.provider;
      if (options.syncState && syncProvider) {
        const [clock] = await tx.execute<{ startedAt: string }>(
          sql`select ${sourceControlSyncClock} as "startedAt"`,
        );
        await tx
          .update(sourceControlConnectionRequests)
          .set({
            syncAttempt:
              request.syncAttempt?.state === 'authorizing' ||
              request.syncAttempt?.state === 'syncing'
                ? request.syncAttempt
                : {
                    provider: syncProvider,
                    startedAt:
                      options.syncState === 'failed'
                        ? clock!.startedAt
                        : (request.syncAttempt?.startedAt ?? clock!.startedAt),
                    state: options.syncState,
                  },
            reason:
              options.syncState === 'failed' ? 'sync_failed' : 'sync_pending',
          })
          .where(eq(sourceControlConnectionRequests.id, request.id));
        return null;
      }
      if (request.syncAttempt) {
        const attempt = request.syncAttempt;
        const proof = options.successfulSync;
        const [freshness] = proof
          ? await tx.execute<{ fresh: boolean }>(
              sql`select ${proof.startedAt}::timestamptz >= ${attempt.startedAt}::timestamptz as fresh`,
            )
          : [];
        const synchronized =
          input.provider === attempt.provider &&
          proof &&
          freshness?.fresh &&
          (
            await readiness(
              tx,
              {
                ...targetOf(request),
                actorUserId: request.actorUserId,
                provider: attempt.provider,
                // Verify inventory independently of remote catalog discovery,
                // preserving provider-only tool requests without inventing a repo target.
                tool:
                  request.capability === 'source_control_tool'
                    ? {
                        integrationId: ROOMOTE_MCP_ID,
                        toolName: 'manage_source_control',
                      }
                    : undefined,
              },
              options,
            )
          ).status === 'ready';
        if (
          synchronized &&
          (attempt.state === 'authorizing' || attempt.state === 'syncing')
        ) {
          // GitHub may deliver inventory while the browser callback is in flight.
          // Retain proof, but let the authenticated callback finish before admission.
          await tx
            .update(sourceControlConnectionRequests)
            .set({
              syncAttempt: {
                ...attempt,
                successfulSync: proof!,
              },
            })
            .where(eq(sourceControlConnectionRequests.id, request.id));
          return null;
        }
        if (!synchronized) {
          await tx
            .update(sourceControlConnectionRequests)
            .set({
              reason:
                attempt.state === 'failed' ? 'sync_failed' : 'sync_pending',
            })
            .where(eq(sourceControlConnectionRequests.id, request.id));
          return null;
        }
        await tx
          .update(sourceControlConnectionRequests)
          .set({ syncAttempt: null })
          .where(eq(sourceControlConnectionRequests.id, request.id));
      }
      const result = await readiness(
        tx,
        { ...targetOf(request), actorUserId: request.actorUserId },
        options,
      );
      if (request.expiresAt.getTime() <= Date.now()) {
        await expire(tx, conversation.id);
        return null;
      }
      if (
        input.completedByUserId &&
        (await actor(tx, input.completedByUserId))?.role !== 'admin'
      )
        throw new Error('Forbidden.');
      await tx
        .update(sourceControlConnectionRequests)
        .set({ reason: result.status, updatedAt: new Date() })
        .where(eq(sourceControlConnectionRequests.id, request.id));
      if (result.status !== 'ready') return null;
      const address = fastAgentConversationSchema.safeParse({
        surface: conversation.surface,
        workspaceId: conversation.workspaceId,
        conversationId: conversation.conversationId,
        ...(conversation.currentReplyChannelId
          ? {
              replyTarget: {
                channelId: conversation.currentReplyChannelId,
                threadId: conversation.currentReplyThreadId ?? undefined,
                serviceUrl: conversation.currentReplyServiceUrl ?? undefined,
              },
            }
          : {}),
      });
      if (!address.success || !conversation.replyTargetVerified) return null;
      const admitted = await admitSourceControlConnectionReadyEvent(tx, {
        parent: { sessionId: conversation.id, conversation: address.data },
        requestId: request.id,
      });
      await tx
        .update(sourceControlConnectionRequests)
        .set({
          status: 'ready',
          continuationEventKey: admitted.eventKey,
          completedByUserId: input.completedByUserId,
          revision: sql`${sourceControlConnectionRequests.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(sourceControlConnectionRequests.id, request.id));
      return { conversationId: conversation.id, eventKey: admitted.eventKey };
    });
    if (wakeup) {
      ready++;
      // PostgreSQL recovery owns retries after a failed Redis wakeup.
      await wakeFastAgentParentEventNow(wakeup).catch(() => {});
    }
  }
  return { ready };
}

/** Called under the existing Fast turn lock; DB locking linearizes cancellation. */
export async function validateSourceControlConnectionContinuation(
  input: { requestId: string; conversationId: string; forOperation?: boolean },
  options: SourceControlReadinessOptions = {},
): Promise<SourceControlConnectionRequest | null> {
  return db.transaction(async (tx) => {
    if (!(await enforceRollout(tx))) return null;
    if (!(await lockConversation(tx, input.conversationId, true))) return null;
    await expire(tx, input.conversationId);
    const [request] = await tx
      .select()
      .from(sourceControlConnectionRequests)
      .where(
        and(
          eq(sourceControlConnectionRequests.id, input.requestId),
          eq(
            sourceControlConnectionRequests.conversationId,
            input.conversationId,
          ),
        ),
      )
      .for('update');
    if (!request || request.status !== 'ready' || request.syncAttempt)
      return null;
    if (!input.forOperation) {
      if (!request.continuationEventKey) return null;
      const [event] = await tx
        .select()
        .from(fastAgentParentEvents)
        .where(
          and(
            eq(fastAgentParentEvents.eventKey, request.continuationEventKey),
            eq(fastAgentParentEvents.conversationId, input.conversationId),
          ),
        )
        .limit(1);
      if (
        !event ||
        event.deliveredAt ||
        event.discardedAt ||
        event.event.type !== 'connection_ready' ||
        event.event.requestId !== request.id
      )
        return null;
    }
    const session = await getSessionForFastConversation(
      tx,
      input.conversationId,
    );
    if (!session || session.archivedAt) {
      await settleSourceControlConnectionRequest(
        { ...input, status: 'superseded' },
        tx,
      );
      return null;
    }
    const result = await readiness(
      tx,
      { ...targetOf(request), actorUserId: request.actorUserId },
      options,
    );
    if (request.expiresAt.getTime() <= Date.now()) {
      await expire(tx, input.conversationId);
      return null;
    }
    if (result.status !== 'ready') {
      await tx
        .update(sourceControlConnectionRequests)
        .set({
          status: 'superseded',
          reason: result.status,
          updatedAt: new Date(),
          revision: sql`${sourceControlConnectionRequests.revision} + 1`,
        })
        .where(eq(sourceControlConnectionRequests.id, request.id));
      return null;
    }
    const [claimed] = await tx
      .update(sourceControlConnectionRequests)
      .set({
        executionStartedAt: request.executionStartedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sourceControlConnectionRequests.id, request.id))
      .returning();
    return claimed!;
  });
}

export async function settleSourceControlConnectionRequest(
  input: {
    requestId: string;
    conversationId: string;
    status?: 'continued' | 'superseded';
  },
  executor: DatabaseOrTransaction = db,
): Promise<void> {
  await executor
    .update(sourceControlConnectionRequests)
    .set({
      status: input.status ?? 'continued',
      updatedAt: new Date(),
      revision: sql`${sourceControlConnectionRequests.revision} + 1`,
    })
    .where(
      and(
        eq(sourceControlConnectionRequests.id, input.requestId),
        eq(
          sourceControlConnectionRequests.conversationId,
          input.conversationId,
        ),
        eq(sourceControlConnectionRequests.status, 'ready'),
      ),
    );
}
