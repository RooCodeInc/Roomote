import {
  and,
  count,
  db,
  desc,
  deriveSessionStatus,
  eq,
  exists,
  fastAgentMessages,
  gte,
  ilike,
  inArray,
  isNull,
  llmUsageEvents,
  lt,
  or,
  sessionParticipants,
  sessionPins,
  sessions,
  sessionTasks,
  sql,
  taskArtifacts,
  taskPullRequests,
  taskRuns,
  tasks,
  users,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import { getFastSessionById } from './fast-sessions';

type SessionAuth = Pick<UserAuthSuccess, 'userId' | 'isAdmin'>;
export type SessionScope = 'all' | 'tasks' | 'reviews' | 'automations';

type SessionListInput = {
  scope?: SessionScope;
  status?: 'active' | 'needs_input' | 'blocked' | 'ready';
  user?: string | null;
  repository?: string | null;
  environment?: string | null;
  pullRequest?: string | null;
  source?: string | null;
  model?: string | null;
  period?: number | 'all';
  q?: string | null;
  before?: string | null;
  limit?: number;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function sessionScope(auth: SessionAuth) {
  if (auth.isAdmin) return undefined;
  return or(
    eq(sessions.ownerUserId, auth.userId),
    exists(
      db
        .select({ one: sql`1` })
        .from(sessionParticipants)
        .where(
          and(
            eq(sessionParticipants.sessionId, sessions.id),
            eq(sessionParticipants.userId, auth.userId),
          ),
        ),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(fastAgentMessages)
        .where(
          and(
            eq(fastAgentMessages.conversationId, sessions.fastConversationId),
            sql`${fastAgentMessages.metadata} ->> 'userId' = ${auth.userId}`,
          ),
        ),
    ),
  );
}

function encodeCursor(row: { activityAt: number; id: string }): string {
  return `${row.activityAt}:${row.id}`;
}

function decodeCursor(cursor?: string | null) {
  if (!cursor) return null;
  const separator = cursor.indexOf(':');
  const activityAt = Number(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  return separator > 0 && Number.isFinite(activityAt) && id
    ? { activityAt, id }
    : null;
}

function taskExistsCondition(condition?: ReturnType<typeof eq>) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(sessionTasks)
      .innerJoin(tasks, eq(tasks.id, sessionTasks.taskId))
      .where(
        and(
          eq(sessionTasks.sessionId, sessions.id),
          isNull(tasks.deletedAt),
          condition,
        ),
      ),
  );
}

function listConditions(auth: SessionAuth, input: SessionListInput) {
  const cursor = decodeCursor(input.before);
  const scope = input.scope ?? 'all';
  const query = input.q?.trim();
  const period = input.period ?? 'all';
  const pullRequestNumber = Number(input.pullRequest);

  return and(
    sessionScope(auth),
    eq(sessions.visibility, 'visible'),
    isNull(sessions.archivedAt),
    input.status ? eq(sessions.cachedStatus, input.status) : undefined,
    input.user ? eq(sessions.ownerUserId, input.user) : undefined,
    input.source
      ? eq(sessions.sourceSurface, input.source as never)
      : undefined,
    period === 'all'
      ? undefined
      : gte(
          sessions.activityAt,
          Math.floor(Date.now() / 1000) - period * 24 * 60 * 60,
        ),
    cursor
      ? or(
          lt(sessions.activityAt, cursor.activityAt),
          and(
            eq(sessions.activityAt, cursor.activityAt),
            lt(sessions.id, cursor.id),
          ),
        )
      : undefined,
    scope === 'tasks' ? taskExistsCondition() : undefined,
    scope === 'reviews'
      ? taskExistsCondition(eq(tasks.workflow, 'pr_review'))
      : undefined,
    scope === 'automations' ? eq(sessions.ownerKind, 'automation') : undefined,
    input.repository
      ? taskExistsCondition(eq(tasks.repositoryName, input.repository))
      : undefined,
    input.environment
      ? exists(
          db
            .select({ one: sql`1` })
            .from(sessionTasks)
            .innerJoin(taskRuns, eq(taskRuns.taskId, sessionTasks.taskId))
            .where(
              and(
                eq(sessionTasks.sessionId, sessions.id),
                sql`${taskRuns.payload} ->> 'environmentId' = ${input.environment}`,
              ),
            ),
        )
      : undefined,
    input.model ? taskExistsCondition(eq(tasks.model, input.model)) : undefined,
    input.pullRequest && Number.isFinite(pullRequestNumber)
      ? exists(
          db
            .select({ one: sql`1` })
            .from(sessionTasks)
            .innerJoin(
              taskPullRequests,
              eq(taskPullRequests.taskId, sessionTasks.taskId),
            )
            .where(
              and(
                eq(sessionTasks.sessionId, sessions.id),
                eq(taskPullRequests.prNumber, pullRequestNumber),
              ),
            ),
        )
      : undefined,
    query
      ? or(
          ilike(sessions.title, `%${query.replaceAll('%', '\\%')}%`),
          exists(
            db
              .select({ one: sql`1` })
              .from(sessionTasks)
              .innerJoin(tasks, eq(tasks.id, sessionTasks.taskId))
              .where(
                and(
                  eq(sessionTasks.sessionId, sessions.id),
                  or(
                    ilike(tasks.title, `%${query.replaceAll('%', '\\%')}%`),
                    ilike(
                      tasks.repositoryName,
                      `%${query.replaceAll('%', '\\%')}%`,
                    ),
                  ),
                ),
              ),
          ),
        )
      : undefined,
  );
}

const baseSelection = {
  id: sessions.id,
  title: sessions.title,
  ownerKind: sessions.ownerKind,
  ownerUserId: sessions.ownerUserId,
  ownerAutomation: sessions.ownerAutomation,
  ownerName: users.name,
  ownerEmail: users.email,
  ownerImageUrl: users.imageUrl,
  sourceSurface: sessions.sourceSurface,
  sourceTrigger: sessions.sourceTrigger,
  fastConversationId: sessions.fastConversationId,
  visibility: sessions.visibility,
  activityAt: sessions.activityAt,
  cachedStatus: sessions.cachedStatus,
  archivedAt: sessions.archivedAt,
  createdAt: sessions.createdAt,
  updatedAt: sessions.updatedAt,
};

async function hydrateSessionRows(
  auth: SessionAuth,
  rows: Array<
    typeof sessions.$inferSelect & {
      ownerName: string | null;
      ownerEmail: string | null;
      ownerImageUrl: string | null;
    }
  >,
) {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [
    linkedTasks,
    participants,
    usage,
    legacyTaskUsage,
    legacyFastUsage,
    externalFastActivity,
    pins,
  ] = await Promise.all([
    db
      .select({
        sessionId: sessionTasks.sessionId,
        taskId: tasks.id,
        title: tasks.title,
        workflow: tasks.workflow,
        state: tasks.state,
        repositoryName: tasks.repositoryName,
        model: tasks.model,
        activityAt: tasks.activityAt,
      })
      .from(sessionTasks)
      .innerJoin(tasks, eq(tasks.id, sessionTasks.taskId))
      .where(
        and(inArray(sessionTasks.sessionId, ids), isNull(tasks.deletedAt)),
      ),
    db
      .select({
        sessionId: sessionParticipants.sessionId,
        userId: sessionParticipants.userId,
        role: sessionParticipants.role,
        lastReadEventAt: sessionParticipants.lastReadEventAt,
        lastReadEventId: sessionParticipants.lastReadEventId,
      })
      .from(sessionParticipants)
      .where(inArray(sessionParticipants.sessionId, ids)),
    db
      .select({
        sessionId: llmUsageEvents.sessionId,
        costMicroUsd: sql<number>`coalesce(sum(${llmUsageEvents.costMicroUsd}), 0)::bigint`,
      })
      .from(llmUsageEvents)
      .where(inArray(llmUsageEvents.sessionId, ids))
      .groupBy(llmUsageEvents.sessionId),
    db
      .select({
        sessionId: sessionTasks.sessionId,
        costMicroUsd: sql<number>`coalesce(sum(${llmUsageEvents.costMicroUsd}), 0)::bigint`,
      })
      .from(sessionTasks)
      .innerJoin(llmUsageEvents, eq(llmUsageEvents.taskId, sessionTasks.taskId))
      .where(
        and(
          inArray(sessionTasks.sessionId, ids),
          isNull(llmUsageEvents.sessionId),
        ),
      )
      .groupBy(sessionTasks.sessionId),
    db
      .select({
        sessionId: sessions.id,
        costMicroUsd: sql<number>`(
          select coalesce(sum(legacy_usage.cost_micro_usd), 0)::bigint
          from task_inference_usage_events legacy_usage
          where legacy_usage.session_id is null
            and legacy_usage.harness_session_id in (
              select distinct ${fastAgentMessages.nativeSessionId}
              from ${fastAgentMessages}
              where ${fastAgentMessages.conversationId} = ${sessions.fastConversationId}
                and ${fastAgentMessages.nativeSessionId} is not null
            )
        )`,
      })
      .from(sessions)
      .where(inArray(sessions.id, ids)),
    db
      .select({
        sessionId: sessions.id,
        eventAt: sql<number>`coalesce(max(${fastAgentMessages.ts}), 0)::bigint`,
      })
      .from(sessions)
      .innerJoin(
        fastAgentMessages,
        eq(fastAgentMessages.conversationId, sessions.fastConversationId),
      )
      .where(
        and(
          inArray(sessions.id, ids),
          or(
            sql`${fastAgentMessages.metadata} ->> 'userId' IS NULL`,
            sql`${fastAgentMessages.metadata} ->> 'userId' <> ${auth.userId}`,
          ),
        ),
      )
      .groupBy(sessions.id),
    db
      .select({ sessionId: sessionPins.sessionId })
      .from(sessionPins)
      .where(
        and(
          eq(sessionPins.userId, auth.userId),
          inArray(sessionPins.sessionId, ids),
        ),
      ),
  ]);

  const pinned = new Set(pins.map((pin) => pin.sessionId));
  return rows.map((row) => {
    const tasksForSession = linkedTasks.filter(
      (task) => task.sessionId === row.id,
    );
    const sessionParticipantsRows = participants.filter(
      (participant) => participant.sessionId === row.id,
    );
    const cursor = sessionParticipantsRows.find(
      (participant) => participant.userId === auth.userId,
    );
    const latestTaskEventAt = tasksForSession.reduce(
      (latest, task) => Math.max(latest, task.activityAt * 1000),
      0,
    );
    const latestExternalEventAt = Math.max(
      latestTaskEventAt,
      Number(
        externalFastActivity.find((event) => event.sessionId === row.id)
          ?.eventAt ?? 0,
      ),
    );
    return {
      ...row,
      tasks: tasksForSession,
      executionCount: tasksForSession.length,
      participants: sessionParticipantsRows,
      inferenceCostMicroUsd:
        Number(
          usage.find((event) => event.sessionId === row.id)?.costMicroUsd ?? 0,
        ) +
        Number(
          legacyTaskUsage.find((event) => event.sessionId === row.id)
            ?.costMicroUsd ?? 0,
        ) +
        Number(
          legacyFastUsage.find((event) => event.sessionId === row.id)
            ?.costMicroUsd ?? 0,
        ),
      unread: latestExternalEventAt > Number(cursor?.lastReadEventAt ?? 0),
      pinned: pinned.has(row.id),
    };
  });
}

export async function getSessions(auth: SessionAuth, input: SessionListInput) {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const rows = await db
    .select(baseSelection)
    .from(sessions)
    .leftJoin(users, eq(users.id, sessions.ownerUserId))
    .where(listConditions(auth, input))
    .orderBy(desc(sessions.activityAt), desc(sessions.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    sessions: await hydrateSessionRows(auth, page),
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

export async function findAccessibleSession(
  auth: SessionAuth,
  sessionId: string,
) {
  const [session] = await db
    .select(baseSelection)
    .from(sessions)
    .leftJoin(users, eq(users.id, sessions.ownerUserId))
    .where(and(eq(sessions.id, sessionId), sessionScope(auth)))
    .limit(1);
  return session ?? null;
}

async function getSessionTasks(sessionId: string) {
  const linked = await db
    .select({
      sessionId: sessionTasks.sessionId,
      taskId: tasks.id,
      attachedAt: sessionTasks.attachedAt,
      origin: sessionTasks.origin,
      title: tasks.title,
      workflow: tasks.workflow,
      state: tasks.state,
      goalStatus: tasks.goalStatus,
      repositoryName: tasks.repositoryName,
      model: tasks.model,
      activityAt: tasks.activityAt,
    })
    .from(sessionTasks)
    .innerJoin(tasks, eq(tasks.id, sessionTasks.taskId))
    .where(and(eq(sessionTasks.sessionId, sessionId), isNull(tasks.deletedAt)))
    .orderBy(sessionTasks.attachedAt);

  return Promise.all(
    linked.map(async (task) => {
      const [latestRun, artifacts, pullRequests, usage] = await Promise.all([
        db.query.taskRuns.findFirst({
          where: eq(taskRuns.taskId, task.taskId),
          orderBy: desc(taskRuns.id),
          columns: {
            id: true,
            status: true,
            taskPhase: true,
            error: true,
            result: true,
          },
        }),
        db
          .select({
            id: taskArtifacts.id,
            path: taskArtifacts.path,
            artifactType: taskArtifacts.artifactType,
            contentType: taskArtifacts.contentType,
            size: taskArtifacts.size,
          })
          .from(taskArtifacts)
          .where(eq(taskArtifacts.taskId, task.taskId))
          .orderBy(desc(taskArtifacts.createdAt)),
        db
          .select({
            id: taskPullRequests.id,
            url: taskPullRequests.prUrl,
            number: taskPullRequests.prNumber,
            title: taskPullRequests.prTitle,
            repository: taskPullRequests.repository,
            status: taskPullRequests.status,
          })
          .from(taskPullRequests)
          .where(eq(taskPullRequests.taskId, task.taskId)),
        db
          .select({
            costMicroUsd: sql<number>`coalesce(sum(${llmUsageEvents.costMicroUsd}), 0)::bigint`,
          })
          .from(llmUsageEvents)
          .where(eq(llmUsageEvents.taskId, task.taskId)),
      ]);
      const result = latestRun?.result;
      const latestOutput =
        result && typeof result === 'object'
          ? String(
              (result as Record<string, unknown>).summary ??
                (result as Record<string, unknown>).message ??
                '',
            )
              .trim()
              .slice(0, 240) || null
          : null;
      return {
        ...task,
        latestRun: latestRun ?? null,
        latestOutput,
        inferenceCostMicroUsd: Number(usage[0]?.costMicroUsd ?? 0),
        artifacts,
        pullRequests,
      };
    }),
  );
}

export async function getSessionById(auth: SessionAuth, sessionId: string) {
  const session = await findAccessibleSession(auth, sessionId);
  if (!session) return null;
  const [hydrated] = await hydrateSessionRows(auth, [session]);
  const sessionTaskDetails = await getSessionTasks(sessionId);
  const liveStatus = deriveSessionStatus({
    conversationResponding:
      Boolean(session.fastConversationId) && session.cachedStatus === 'active',
    tasks: sessionTaskDetails.map((task) => ({
      state: task.state,
      taskPhase: task.latestRun?.taskPhase ?? null,
      goalStatus: task.goalStatus,
    })),
  });
  return { ...hydrated!, tasks: sessionTaskDetails, status: liveStatus };
}

export async function getSessionTimeline(
  auth: SessionAuth,
  sessionId: string,
  since = 0,
) {
  const session = await findAccessibleSession(auth, sessionId);
  if (!session) return null;
  const taskRows = await getSessionTasks(sessionId);
  const fast = session.fastConversationId
    ? await getFastSessionById(auth, session.fastConversationId)
    : null;
  const timelineTasks = taskRows.map((task) => ({
    taskId: task.taskId,
    title: task.title,
    workflow: task.workflow,
    state: task.state,
    goalStatus: task.goalStatus,
    repositoryName: task.repositoryName,
    activityAt: task.activityAt,
    attachedAt: task.attachedAt,
    origin: task.origin,
  }));
  const events = [
    ...(fast?.messages ?? []).map((message) => ({
      id: `fast:${message.eventId}`,
      at: message.ts,
      type: 'message' as const,
      own: message.metadata?.userId === auth.userId,
      message,
    })),
    ...timelineTasks.flatMap((task) => [
      {
        id: `task:${task.taskId}:delegated`,
        at: task.attachedAt.getTime(),
        type: 'task_delegated' as const,
        own: false,
        task,
      },
      {
        id: `task:${task.taskId}:${task.state}`,
        at: task.activityAt * 1000,
        type: 'task_state' as const,
        own: false,
        task,
      },
    ]),
  ]
    .filter((event) => event.at > since)
    .sort(
      (left, right) => left.at - right.at || left.id.localeCompare(right.id),
    );
  return { events, cursor: events.at(-1)?.at ?? since };
}

export async function getSessionForTask(auth: SessionAuth, taskId: string) {
  const [row] = await db
    .select({ sessionId: sessions.id, title: sessions.title })
    .from(sessionTasks)
    .innerJoin(sessions, eq(sessions.id, sessionTasks.sessionId))
    .where(and(eq(sessionTasks.taskId, taskId), sessionScope(auth)))
    .limit(1);
  return row ?? null;
}

export async function updateSessionMetadata(
  auth: SessionAuth,
  sessionId: string,
  changes: { title?: string; archivedAt?: Date | null },
) {
  const [updated] = await db
    .update(sessions)
    .set({ ...changes, updatedAt: new Date() })
    .where(
      and(
        eq(sessions.id, sessionId),
        auth.isAdmin ? undefined : eq(sessions.ownerUserId, auth.userId),
      ),
    )
    .returning();
  return updated ?? null;
}

export async function listSessionPins(auth: SessionAuth) {
  return db
    .select({
      sessionId: sessionPins.sessionId,
      updatedAt: sessionPins.updatedAt,
    })
    .from(sessionPins)
    .innerJoin(sessions, eq(sessions.id, sessionPins.sessionId))
    .where(and(eq(sessionPins.userId, auth.userId), sessionScope(auth)))
    .orderBy(desc(sessionPins.updatedAt));
}

export async function setSessionPinned(
  auth: SessionAuth,
  input: { sessionId: string; pinned: boolean },
) {
  if (!input.pinned) {
    await db
      .delete(sessionPins)
      .where(
        and(
          eq(sessionPins.sessionId, input.sessionId),
          eq(sessionPins.userId, auth.userId),
        ),
      );
    return { success: true as const, pinned: false };
  }
  if (!(await findAccessibleSession(auth, input.sessionId))) {
    return { success: false as const, error: 'session_not_found' as const };
  }
  const [existing] = await db
    .select({ id: sessionPins.id })
    .from(sessionPins)
    .where(
      and(
        eq(sessionPins.sessionId, input.sessionId),
        eq(sessionPins.userId, auth.userId),
      ),
    );
  if (existing) return { success: true as const, pinned: true };
  const [total] = await db
    .select({ value: count() })
    .from(sessionPins)
    .where(eq(sessionPins.userId, auth.userId));
  if ((total?.value ?? 0) >= 5) {
    return { success: false as const, error: 'pin_limit_reached' as const };
  }
  await db.insert(sessionPins).values({
    sessionId: input.sessionId,
    userId: auth.userId,
  });
  return { success: true as const, pinned: true };
}
