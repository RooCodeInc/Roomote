import {
  ACP_ENVELOPE_EVENT_TYPES,
  ACP_UI_TOOL_OUTPUT_MAX_CHARS,
  extractAutomationTriggeredPromptText,
  extractAcpMessageText,
  getTextFromContentBlocks,
  parsePrReviewActionOffer,
  type PrReviewActionOfferStatus,
  sanitizeEnvelopeFields,
} from '@roomote/types';
import {
  and,
  asc,
  db,
  desc,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  llmUsageEvents,
  inArray,
  isNull,
  or,
  sessions,
  sql,
  taskArtifacts,
  taskRuns,
  tasks,
  users,
} from '@roomote/db/server';
import type { FastAgentMessage } from '@roomote/db';

import type { UserAuthSuccess } from '@/types';
import { currentEpochSeconds, signArtifactId } from './artifact-signature';
import { COMPOSER_SUGGESTION_HISTORY_LIMIT } from './composer-suggestion-history';
import {
  buildSessionTaskPreviews,
  getSessionPreviewProxyConfig,
  type SessionTaskPreview,
} from './session-task-previews';

type FastSessionAuth = Pick<UserAuthSuccess, 'userId' | 'isAdmin'>;

type FastSessionTaskSummary = {
  taskId: string;
  title: string;
  inferenceCostMicroUsd: number;
  artifacts: Array<{
    id: string;
    path: string;
    version: number;
    artifactType: string;
    contentType: string;
    size: number;
    createdAt: Date;
  }>;
  previews: SessionTaskPreview[];
  latestRun: {
    status: (typeof taskRuns.$inferSelect)['status'];
    taskPhase: (typeof taskRuns.$inferSelect)['taskPhase'];
  };
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
> & {
  userName?: string | null;
  userEmail?: string | null;
  userImageUrl?: string | null;
};

const fastSessionMessageSelection = {
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
  userName: sql<
    string | null
  >`coalesce(${fastAgentMessages.metadata} ->> 'userName', ${users.name})`,
  userEmail: sql<
    string | null
  >`coalesce(${fastAgentMessages.metadata} ->> 'userEmail', ${users.email})`,
  userImageUrl: sql<
    string | null
  >`coalesce(${fastAgentMessages.metadata} ->> 'userImageUrl', ${users.imageUrl})`,
};

const fastSessionMessageUserJoin = sql`${users.id}::text = ${fastAgentMessages.metadata} ->> 'userId'`;

const fastSessionTranscriptVisibilityWhere = sql`(
  coalesce(${fastAgentMessages.metadata} ->> 'visibleInTranscript', 'true') <> 'false'
  or (
    ${fastAgentMessages.eventType} = ${ACP_ENVELOPE_EVENT_TYPES.UserPrompt}
    and ${fastAgentMessages.metadata} ->> 'platformEventKind' = 'automation'
  )
)`;

/** Signed raw URLs are bucketed so a polling transcript stays byte-stable. */
const REPLY_IMAGE_SIGNATURE_WINDOW_SECONDS = 60 * 60;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The reply schema only requires strings, and web turns have no surface-side
 * artifact lookup, so a model-authored id can be anything. Keep only
 * UUID-shaped ids: `task_artifacts.id` is a uuid column and a malformed value
 * would make Postgres reject the whole lookup instead of dropping that id.
 */
function readReplyImageArtifactIds(payload: unknown): string[] {
  const ids = (payload as { imageArtifactIds?: unknown } | null)
    ?.imageArtifactIds;
  return Array.isArray(ids)
    ? ids.filter(
        (id): id is string => typeof id === 'string' && UUID_PATTERN.test(id),
      )
    : [];
}

/**
 * Fast replies reference the images they attach by artifact id (chat
 * surfaces post the files themselves). The web transcript renders
 * `payload.images` URLs, so resolve the ids here to signed raw URLs. Only
 * uploaded image artifacts from this Session's own tasks (or the Session
 * itself) qualify; anything else is dropped rather than signed.
 */
async function attachFastSessionReplyImages<
  T extends Pick<FastSessionMessage, 'payload'>,
>(sessionId: string, messages: T[]): Promise<T[]> {
  const requestedIds = new Set(
    messages.flatMap((message) => readReplyImageArtifactIds(message.payload)),
  );
  if (requestedIds.size === 0) {
    return messages;
  }

  const [conversation] = await db
    .select({
      legacyConversationIds: fastAgentConversations.legacyConversationIds,
    })
    .from(fastAgentConversations)
    .where(eq(fastAgentConversations.id, sessionId))
    .limit(1);
  const lookupIds = [sessionId, ...(conversation?.legacyConversationIds ?? [])];

  const allowed = await db
    .select({
      id: taskArtifacts.id,
      taskId: taskArtifacts.taskId,
      sessionId: taskArtifacts.sessionId,
      path: taskArtifacts.path,
      version: taskArtifacts.version,
    })
    .from(taskArtifacts)
    .where(
      and(
        inArray(taskArtifacts.id, [...requestedIds]),
        eq(taskArtifacts.uploaded, true),
        sql`${taskArtifacts.contentType} like 'image/%'`,
        or(
          inArray(
            taskArtifacts.taskId,
            db
              .select({ taskId: taskRuns.taskId })
              .from(taskRuns)
              .where(inArray(taskRuns.fastAgentSessionId, lookupIds)),
          ),
          inArray(
            taskArtifacts.sessionId,
            db
              .select({ id: sessions.id })
              .from(sessions)
              .where(inArray(sessions.fastConversationId, lookupIds)),
          ),
        ),
      ),
    );
  const allowedById = new Map(allowed.map((row) => [row.id, row]));
  if (allowedById.size === 0) {
    return messages;
  }

  const signatureTimestamp =
    Math.floor(currentEpochSeconds() / REPLY_IMAGE_SIGNATURE_WINDOW_SECONDS) *
    REPLY_IMAGE_SIGNATURE_WINDOW_SECONDS;

  return messages.map((message) => {
    // `imageArtifacts` carries the owner/path/version alongside each URL so
    // the transcript can open the image in the artifact viewer.
    const imageArtifacts = readReplyImageArtifactIds(message.payload).flatMap(
      (id) => {
        const artifact = allowedById.get(id);
        if (!artifact) return [];
        const owner = artifact.taskId
          ? { taskId: artifact.taskId }
          : artifact.sessionId
            ? { sessionId: artifact.sessionId }
            : null;
        if (!owner) return [];
        return [
          {
            url: `/api/artifacts/${id}/raw?sig=${signArtifactId(id, signatureTimestamp)}&ts=${signatureTimestamp}`,
            owner,
            path: artifact.path,
            version: artifact.version,
          },
        ];
      },
    );
    if (imageArtifacts.length === 0) {
      return message;
    }
    return {
      ...message,
      payload: {
        ...((message.payload as Record<string, unknown> | null) ?? {}),
        images: imageArtifacts.map((artifact) => artifact.url),
        imageArtifacts,
      },
    };
  });
}

export function buildFastSessionPrReviewDestinationKey(session: {
  surface: string;
  workspaceId: string;
  conversationId: string;
}): string {
  return JSON.stringify([
    session.surface,
    session.workspaceId,
    session.conversationId,
  ]);
}

export async function updateFastSessionPrReviewOfferStatus(
  sessionId: string,
  deliveryIds: string[],
  status: PrReviewActionOfferStatus,
): Promise<void> {
  if (deliveryIds.length === 0) return;

  await db
    .update(fastAgentMessages)
    .set({
      payload: sql`jsonb_set(coalesce(${fastAgentMessages.payload}, '{}'::jsonb), '{prReviewAction,status}', to_jsonb(${status}::text), true)`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(fastAgentMessages.conversationId, sessionId),
        inArray(
          sql<string>`${fastAgentMessages.payload} -> 'prReviewAction' ->> 'deliveryId'`,
          deliveryIds,
        ),
      ),
    );
}

export async function getFastSessionPrReviewOfferStatus(
  sessionId: string,
  deliveryId: string,
): Promise<PrReviewActionOfferStatus | null> {
  const [message] = await db
    .select({ payload: fastAgentMessages.payload })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, sessionId),
        sql`${fastAgentMessages.payload} -> 'prReviewAction' ->> 'deliveryId' = ${deliveryId}`,
      ),
    )
    .limit(1);
  return parsePrReviewActionOffer(message?.payload)?.status ?? null;
}

const FAST_SESSION_TRANSCRIPT_MESSAGE_LIMIT = 1000;

const fastSessionSelection = {
  id: fastAgentConversations.id,
  userId: fastAgentConversations.userId,
  ownerAutomation: fastAgentConversations.ownerAutomation,
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

function fastSessionScope(_auth: FastSessionAuth) {
  // Sessions follow the same visibility rules as tasks: every authenticated
  // user of the deployment can read every conversation and its transcript.
  return undefined;
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
      ownerAutomation: fastAgentConversations.ownerAutomation,
      title: fastAgentConversations.title,
      surface: fastAgentConversations.surface,
      workspaceId: fastAgentConversations.workspaceId,
      conversationId: fastAgentConversations.conversationId,
      model: fastAgentConversations.model,
      reasoningEffort: fastAgentConversations.reasoningEffort,
    })
    .from(fastAgentConversations)
    .leftJoin(
      sessions,
      eq(sessions.fastConversationId, fastAgentConversations.id),
    )
    .where(
      and(
        or(
          eq(fastAgentConversations.id, sessionId),
          eq(sessions.id, sessionId),
        ),
        fastSessionScope(auth),
      ),
    )
    .limit(1);

  return session ?? null;
}

export async function getFastSessionDisplayTitle(
  fastConversationId: string,
  fallbackTitle: string | null,
): Promise<string | null> {
  const [session] = await db
    .select({ title: sessions.title })
    .from(sessions)
    .where(eq(sessions.fastConversationId, fastConversationId))
    .limit(1);
  return session?.title ?? fallbackTitle;
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
        status: taskRuns.status,
        taskPhase: taskRuns.taskPhase,
        machineDomain: taskRuns.machineDomain,
        machineDomains: taskRuns.machineDomains,
        initialPaths: taskRuns.initialPaths,
        primaryPortName: taskRuns.primaryPortName,
        sleepRequestedAt: taskRuns.sleepRequestedAt,
        snapshotRequestedAt: taskRuns.snapshotRequestedAt,
        snapshotCreatedAt: taskRuns.snapshotCreatedAt,
        snapshotFailedAt: taskRuns.snapshotFailedAt,
        snapshotId: taskRuns.snapshotId,
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

  const rows = await db
    .with(latestRunPerTask)
    .select({
      taskId: latestRunPerTask.taskId,
      title: latestRunPerTask.title,
      latestRunId: latestRunPerTask.latestRunId,
      status: latestRunPerTask.status,
      taskPhase: latestRunPerTask.taskPhase,
      machineDomain: latestRunPerTask.machineDomain,
      machineDomains: latestRunPerTask.machineDomains,
      initialPaths: latestRunPerTask.initialPaths,
      primaryPortName: latestRunPerTask.primaryPortName,
      sleepRequestedAt: latestRunPerTask.sleepRequestedAt,
      snapshotRequestedAt: latestRunPerTask.snapshotRequestedAt,
      snapshotCreatedAt: latestRunPerTask.snapshotCreatedAt,
      snapshotFailedAt: latestRunPerTask.snapshotFailedAt,
      snapshotId: latestRunPerTask.snapshotId,
      inferenceCostMicroUsd: sql<number>`coalesce(sum(${llmUsageEvents.costMicroUsd}), 0)::bigint`,
    })
    .from(latestRunPerTask)
    .leftJoin(
      llmUsageEvents,
      eq(llmUsageEvents.taskId, latestRunPerTask.taskId),
    )
    .groupBy(
      latestRunPerTask.taskId,
      latestRunPerTask.title,
      latestRunPerTask.latestRunId,
      latestRunPerTask.status,
      latestRunPerTask.taskPhase,
      latestRunPerTask.machineDomain,
      latestRunPerTask.machineDomains,
      latestRunPerTask.initialPaths,
      latestRunPerTask.primaryPortName,
      latestRunPerTask.sleepRequestedAt,
      latestRunPerTask.snapshotRequestedAt,
      latestRunPerTask.snapshotCreatedAt,
      latestRunPerTask.snapshotFailedAt,
      latestRunPerTask.snapshotId,
    )
    .orderBy(desc(latestRunPerTask.latestRunId));

  const taskIds = rows.map((row) => row.taskId);
  const previewConfig = taskIds.length
    ? await getSessionPreviewProxyConfig()
    : null;
  const artifactRows = taskIds.length
    ? await db
        .select({
          taskId: taskArtifacts.taskId,
          id: taskArtifacts.id,
          path: taskArtifacts.path,
          version: taskArtifacts.version,
          artifactType: taskArtifacts.artifactType,
          contentType: taskArtifacts.contentType,
          size: taskArtifacts.size,
          createdAt: taskArtifacts.createdAt,
        })
        .from(taskArtifacts)
        .where(
          and(
            inArray(taskArtifacts.taskId, taskIds),
            eq(taskArtifacts.uploaded, true),
          ),
        )
        .orderBy(desc(taskArtifacts.createdAt))
    : [];

  return rows.map((row) => ({
    taskId: row.taskId,
    title: row.title,
    inferenceCostMicroUsd: Number(row.inferenceCostMicroUsd),
    artifacts: artifactRows
      .filter((artifact) => artifact.taskId === row.taskId)
      .map(({ taskId: _taskId, ...artifact }) => artifact),
    previews: previewConfig
      ? buildSessionTaskPreviews(
          row.taskId,
          { ...row, id: row.latestRunId },
          previewConfig,
        )
      : [],
    latestRun: {
      status: row.status,
      taskPhase: row.taskPhase,
    },
  }));
}

function prepareFastSessionMessageRow<
  T extends Pick<
    FastSessionMessage,
    'eventType' | 'contentBlocks' | 'metadata' | 'payload'
  >,
>(row: T): T | null {
  const sanitized = sanitizeEnvelopeFields(
    row.eventType,
    row.contentBlocks,
    (row.metadata as Record<string, unknown> | null) ?? null,
    (row.payload as Record<string, unknown> | null) ?? null,
    { maxOutputChars: ACP_UI_TOOL_OUTPUT_MAX_CHARS },
  );

  if (sanitized.metadata?.visibleInTranscript === false) {
    const prompt = extractAutomationTriggeredPromptText(
      getTextFromContentBlocks(sanitized.contentBlocks) ?? '',
    );
    if (
      row.eventType !== ACP_ENVELOPE_EVENT_TYPES.UserPrompt ||
      sanitized.metadata.platformEventKind !== 'automation' ||
      !prompt
    ) {
      return null;
    }

    return {
      ...row,
      contentBlocks: [{ type: 'text', text: prompt }],
      metadata: { ...sanitized.metadata, visibleInTranscript: true },
      payload: {},
    };
  }

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
      ...fastSessionMessageSelection,
      // Millisecond Dates truncate Postgres microsecond timestamps, which
      // would replay the newest row on every poll — keep the cursor as a
      // fractional epoch-millisecond float instead.
      updatedAtMs: sql<number>`extract(epoch from ${fastAgentMessages.updatedAt}) * 1000`,
    })
    .from(fastAgentMessages)
    .leftJoin(users, fastSessionMessageUserJoin)
    .where(
      and(
        eq(fastAgentMessages.conversationId, sessionId),
        fastSessionTranscriptVisibilityWhere,
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
  const messages = await attachFastSessionReplyImages(
    sessionId,
    rows.flatMap(({ updatedAtMs, ...row }) => {
      cursor = Math.max(cursor, Number(updatedAtMs));
      const prepared = prepareFastSessionMessageRow(row);
      return prepared ? [prepared] : [];
    }),
  );

  return { messages, cursor };
}

/**
 * The newest persisted user/assistant conversation reduced to the minimal
 * shape the composer-suggestion prompt is built from. Bounded in SQL so long
 * sessions never load their full transcript; tool events never leave the DB.
 */
export async function getFastSessionSuggestableMessages(
  sessionId: string,
): Promise<
  Array<{
    id: string;
    eventType: string;
    role: string | null;
    text: string | null;
  }>
> {
  const rows = await db
    .select({
      id: fastAgentMessages.id,
      eventType: fastAgentMessages.eventType,
      role: fastAgentMessages.role,
      contentBlocks: fastAgentMessages.contentBlocks,
      payload: fastAgentMessages.payload,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, sessionId),
        inArray(fastAgentMessages.eventType, [
          ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
          ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        ]),
        sql`coalesce(${fastAgentMessages.metadata} ->> 'visibleInTranscript', 'true') <> 'false'`,
      ),
    )
    .orderBy(
      desc(fastAgentMessages.ts),
      desc(fastAgentMessages.turnSeq),
      desc(fastAgentMessages.createdAt),
      desc(fastAgentMessages.id),
    )
    .limit(COMPOSER_SUGGESTION_HISTORY_LIMIT);

  return rows.reverse().map((row) => ({
    id: row.id,
    eventType: row.eventType,
    role: row.role,
    text:
      extractAcpMessageText(
        row.contentBlocks,
        (row.payload as Record<string, unknown> | null) ?? null,
      ) ?? null,
  }));
}

export async function getFastSessionById(
  auth: FastSessionAuth,
  sessionId: string,
) {
  const [session] = await db
    .select(fastSessionSelection)
    .from(fastAgentConversations)
    .leftJoin(users, eq(fastAgentConversations.userId, users.id))
    .where(
      and(eq(fastAgentConversations.id, sessionId), fastSessionScope(auth)),
    )
    .limit(1);

  if (!session) {
    return null;
  }

  const rows = await db
    .select(fastSessionMessageSelection)
    .from(fastAgentMessages)
    .leftJoin(users, fastSessionMessageUserJoin)
    .where(
      and(
        eq(fastAgentMessages.conversationId, session.id),
        fastSessionTranscriptVisibilityWhere,
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
  const messages = await attachFastSessionReplyImages(
    session.id,
    windowed.reverse().flatMap((row): FastSessionMessage[] => {
      const prepared = prepareFastSessionMessageRow(row);
      return prepared ? [prepared] : [];
    }),
  );

  // Fast usage events carry the OpenCode session id; a conversation can span
  // several (cold rebuilds), so sum across every session id the transcript
  // references plus the current one.
  const [directUsage] = await db
    .select({
      costMicroUsd: sql<number>`coalesce(sum(${llmUsageEvents.costMicroUsd}), 0)::bigint`,
    })
    .from(llmUsageEvents)
    .where(
      and(
        isNull(llmUsageEvents.taskId),
        sql`${llmUsageEvents.harnessSessionId} in (
          select distinct ${fastAgentMessages.nativeSessionId}
          from ${fastAgentMessages}
          where ${fastAgentMessages.conversationId} = ${session.id}
            and ${fastAgentMessages.nativeSessionId} is not null
          union
          select ${session.openCodeSessionId}::text
        )`,
      ),
    );

  const directInferenceCostMicroUsd = Number(directUsage?.costMicroUsd ?? 0);

  return {
    ...session,
    messages,
    hasOlderMessages,
    directInferenceCostMicroUsd,
    inferenceCostMicroUsd: directInferenceCostMicroUsd,
  };
}
