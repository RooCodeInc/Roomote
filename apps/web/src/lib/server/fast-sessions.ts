import {
  ACP_UI_TOOL_OUTPUT_MAX_CHARS,
  sanitizeEnvelopeFields,
} from '@roomote/types';
import {
  and,
  asc,
  db,
  desc,
  eq,
  exists,
  fastAgentConversations,
  fastAgentMessages,
  llmUsageEvents,
  inArray,
  isNull,
  or,
  sql,
  taskRuns,
  tasks,
  users,
} from '@roomote/db/server';
import type { FastAgentMessage } from '@roomote/db';

import type { UserAuthSuccess } from '@/types';

type FastSessionAuth = Pick<UserAuthSuccess, 'userId' | 'isAdmin'>;

type FastSessionTaskSummary = {
  taskId: string;
  title: string;
};

export type FastSessionMessage = Pick<
  FastAgentMessage,
  | 'id'
  | 'eventId'
  | 'turnId'
  | 'turnSeq'
  | 'ts'
  | 'eventType'
  | 'role'
  | 'contentBlocks'
  | 'metadata'
  | 'payload'
  | 'source'
  | 'nativeSessionId'
  | 'nativeMessageId'
  | 'createdAt'
>;

const FAST_SESSION_TRANSCRIPT_MESSAGE_LIMIT = 1000;

const fastSessionSelection = {
  id: fastAgentConversations.id,
  userId: fastAgentConversations.userId,
  ownerName: users.name,
  ownerEmail: users.email,
  ownerImageUrl: users.imageUrl,
  title: fastAgentConversations.title,
  model: fastAgentConversations.model,
  reasoningEffort: fastAgentConversations.reasoningEffort,
  surface: fastAgentConversations.surface,
  workspaceId: fastAgentConversations.workspaceId,
  conversationId: fastAgentConversations.conversationId,
  currentReplyChannelId: fastAgentConversations.currentReplyChannelId,
  currentReplyThreadId: fastAgentConversations.currentReplyThreadId,
  replyTargetVerified: fastAgentConversations.replyTargetVerified,
  openCodeSessionId: fastAgentConversations.openCodeSessionId,
  messageCount: sql<number>`(
    select count(*)::int
    from ${fastAgentMessages}
    where ${fastAgentMessages.conversationId} = ${fastAgentConversations.id}
  )`,
  createdAt: fastAgentConversations.createdAt,
  updatedAt: fastAgentConversations.updatedAt,
};

function fastSessionScope(auth: FastSessionAuth) {
  if (auth.isAdmin) {
    return undefined;
  }

  // Shared-surface conversations (e.g. Slack channels/threads) are stamped
  // with the first participant's userId, but every participant's prompts are
  // persisted with their own userId in the message metadata — so a session is
  // visible to its owner and to anyone who spoke in it.
  return or(
    eq(fastAgentConversations.userId, auth.userId),
    exists(
      db
        .select({ one: sql`1` })
        .from(fastAgentMessages)
        .where(
          and(
            eq(fastAgentMessages.conversationId, fastAgentConversations.id),
            sql`${fastAgentMessages.metadata} ->> 'userId' = ${auth.userId}`,
          ),
        ),
    ),
  );
}

/** Light session lookup with the same visibility scope as the list/detail. */
export async function findAccessibleFastSession(
  auth: FastSessionAuth,
  sessionId: string,
) {
  const [session] = await db
    .select({
      id: fastAgentConversations.id,
      userId: fastAgentConversations.userId,
      title: fastAgentConversations.title,
      surface: fastAgentConversations.surface,
      workspaceId: fastAgentConversations.workspaceId,
      conversationId: fastAgentConversations.conversationId,
      model: fastAgentConversations.model,
      reasoningEffort: fastAgentConversations.reasoningEffort,
    })
    .from(fastAgentConversations)
    .where(
      and(eq(fastAgentConversations.id, sessionId), fastSessionScope(auth)),
    )
    .limit(1);

  return session ?? null;
}

/**
 * Fast conversations predate the unified Session tables. Their delegated tasks
 * are linked directly from task runs, rather than through session_tasks.
 */
export async function getFastSessionTasks(
  auth: FastSessionAuth,
  sessionId: string,
): Promise<FastSessionTaskSummary[] | null> {
  const session = await findAccessibleFastSession(auth, sessionId);
  if (!session) return null;

  const [conversation] = await db
    .select({
      legacyConversationIds: fastAgentConversations.legacyConversationIds,
    })
    .from(fastAgentConversations)
    .where(eq(fastAgentConversations.id, session.id))
    .limit(1);
  const lookupIds = [
    session.id,
    ...(conversation?.legacyConversationIds ?? []),
  ];
  const latestRunPerTask = db.$with('latest_fast_session_task_runs').as(
    db
      .selectDistinctOn([taskRuns.taskId], {
        taskId: taskRuns.taskId,
        title: tasks.title,
        latestRunId: taskRuns.id,
      })
      .from(taskRuns)
      .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
      .where(
        and(
          inArray(taskRuns.fastAgentSessionId, lookupIds),
          isNull(tasks.deletedAt),
        ),
      )
      .orderBy(taskRuns.taskId, desc(taskRuns.id)),
  );

  return db
    .with(latestRunPerTask)
    .select({
      taskId: latestRunPerTask.taskId,
      title: latestRunPerTask.title,
    })
    .from(latestRunPerTask)
    .orderBy(desc(latestRunPerTask.latestRunId));
}

function sanitizeFastSessionMessageRow<
  T extends Pick<
    FastSessionMessage,
    'eventType' | 'contentBlocks' | 'metadata' | 'payload'
  >,
>(row: T): T {
  const sanitized = sanitizeEnvelopeFields(
    row.eventType,
    row.contentBlocks,
    (row.metadata as Record<string, unknown> | null) ?? null,
    (row.payload as Record<string, unknown> | null) ?? null,
    { maxOutputChars: ACP_UI_TOOL_OUTPUT_MAX_CHARS },
  );

  return {
    ...row,
    contentBlocks: sanitized.contentBlocks,
    metadata: sanitized.metadata,
    payload: sanitized.payload ?? {},
  };
}

/**
 * Rows created or rewritten after `sinceMs` (epoch millis of the row
 * updatedAt), sanitized for the client. Rows mutate in place (tool results
 * replace their call slot), so consumers merge by eventId, not append.
 */
export async function getFastSessionMessagesSince(
  sessionId: string,
  sinceMs: number,
): Promise<{
  messages: FastSessionMessage[];
  cursor: number;
}> {
  const rows = await db
    .select({
      id: fastAgentMessages.id,
      eventId: fastAgentMessages.eventId,
      turnId: fastAgentMessages.turnId,
      turnSeq: fastAgentMessages.turnSeq,
      ts: fastAgentMessages.ts,
      eventType: fastAgentMessages.eventType,
      role: fastAgentMessages.role,
      contentBlocks: fastAgentMessages.contentBlocks,
      metadata: fastAgentMessages.metadata,
      payload: fastAgentMessages.payload,
      source: fastAgentMessages.source,
      nativeSessionId: fastAgentMessages.nativeSessionId,
      nativeMessageId: fastAgentMessages.nativeMessageId,
      createdAt: fastAgentMessages.createdAt,
      // Millisecond Dates truncate Postgres microsecond timestamps, which
      // would replay the newest row on every poll — keep the cursor as a
      // fractional epoch-millisecond float instead.
      updatedAtMs: sql<number>`extract(epoch from ${fastAgentMessages.updatedAt}) * 1000`,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, sessionId),
        sql`coalesce(${fastAgentMessages.metadata} ->> 'visibleInTranscript', 'true') <> 'false'`,
        sql`extract(epoch from ${fastAgentMessages.updatedAt}) * 1000 > ${sinceMs}`,
      ),
    )
    .orderBy(
      asc(fastAgentMessages.ts),
      asc(fastAgentMessages.turnSeq),
      asc(fastAgentMessages.createdAt),
      asc(fastAgentMessages.id),
    );

  let cursor = sinceMs;
  const messages = rows.map(({ updatedAtMs, ...row }) => {
    cursor = Math.max(cursor, Number(updatedAtMs));
    return sanitizeFastSessionMessageRow(row);
  });

  return { messages, cursor };
}

export async function getFastSessionById(
  auth: FastSessionAuth,
  sessionId: string,
) {
  const [session] = await db
    .select(fastSessionSelection)
    .from(fastAgentConversations)
    .innerJoin(users, eq(fastAgentConversations.userId, users.id))
    .where(
      and(eq(fastAgentConversations.id, sessionId), fastSessionScope(auth)),
    )
    .limit(1);

  if (!session) {
    return null;
  }

  const rows = await db
    .select({
      id: fastAgentMessages.id,
      eventId: fastAgentMessages.eventId,
      turnId: fastAgentMessages.turnId,
      turnSeq: fastAgentMessages.turnSeq,
      ts: fastAgentMessages.ts,
      eventType: fastAgentMessages.eventType,
      role: fastAgentMessages.role,
      contentBlocks: fastAgentMessages.contentBlocks,
      metadata: fastAgentMessages.metadata,
      payload: fastAgentMessages.payload,
      source: fastAgentMessages.source,
      nativeSessionId: fastAgentMessages.nativeSessionId,
      nativeMessageId: fastAgentMessages.nativeMessageId,
      createdAt: fastAgentMessages.createdAt,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, session.id),
        sql`coalesce(${fastAgentMessages.metadata} ->> 'visibleInTranscript', 'true') <> 'false'`,
      ),
    )
    .orderBy(
      desc(fastAgentMessages.ts),
      desc(fastAgentMessages.turnSeq),
      desc(fastAgentMessages.createdAt),
      desc(fastAgentMessages.id),
    )
    .limit(FAST_SESSION_TRANSCRIPT_MESSAGE_LIMIT + 1);

  const hasOlderMessages = rows.length > FAST_SESSION_TRANSCRIPT_MESSAGE_LIMIT;
  let windowed = rows.slice(0, FAST_SESSION_TRANSCRIPT_MESSAGE_LIMIT);
  if (hasOlderMessages) {
    // The window boundary can land mid-turn; drop the partial turn at the old
    // end so the transcript starts on a turn boundary. If a single turn fills
    // the whole window, keep it partial rather than rendering nothing — the
    // truncation notice already tells the reader the transcript is incomplete.
    const boundaryTurnId = rows[FAST_SESSION_TRANSCRIPT_MESSAGE_LIMIT]!.turnId;
    let end = windowed.length;
    while (end > 0 && windowed[end - 1]!.turnId === boundaryTurnId) {
      end -= 1;
    }
    if (end > 0) {
      windowed = windowed.slice(0, end);
    }
  }

  // Sanitize at the read boundary, matching the task transcript path: the DB
  // stores full payloads, but oversized tool output is truncated before it is
  // serialized into the RSC payload.
  const messages = windowed
    .reverse()
    .map((row): FastSessionMessage => sanitizeFastSessionMessageRow(row));

  // Fast usage events carry the OpenCode session id; a conversation can span
  // several (cold rebuilds), so sum across every session id the transcript
  // references plus the current one.
  const [usage] = await db
    .select({
      costMicroUsd: sql<number>`coalesce(sum(${llmUsageEvents.costMicroUsd}), 0)::bigint`,
    })
    .from(llmUsageEvents)
    .where(
      sql`${llmUsageEvents.harnessSessionId} in (
        select distinct ${fastAgentMessages.nativeSessionId}
        from ${fastAgentMessages}
        where ${fastAgentMessages.conversationId} = ${session.id}
          and ${fastAgentMessages.nativeSessionId} is not null
        union
        select ${session.openCodeSessionId}::text
      )`,
    );

  return {
    ...session,
    messages,
    hasOlderMessages,
    inferenceCostMicroUsd: Number(usage?.costMicroUsd ?? 0),
  };
}
