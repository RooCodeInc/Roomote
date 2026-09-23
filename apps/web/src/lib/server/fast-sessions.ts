import {
  ACP_ENVELOPE_EVENT_TYPES,
  ACP_UI_TOOL_OUTPUT_MAX_CHARS,
  extractAutomationTriggeredPromptText,
  extractAcpMessageText,
  getTextFromContentBlocks,
  hasLeadingIntegrationSavedBlock,
  stripLeadingIntegrationSavedBlock,
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
  fastAgentParentEvents,
  gt,
  llmUsageEvents,
  inArray,
  isNull,
  or,
  privateFastSessionAccess,
  sessions,
  sql,
  taskArtifacts,
  taskRuns,
  tasks,
  users,
} from '@roomote/db/server';
import type { FastAgentMessage } from '@roomote/db';
import { getRetryableFailedStartRunIds } from '@roomote/cloud-agents/server';

import type { UserAuthSuccess } from '@/types';
import { getTaskMessageReference } from '@/lib/task-message-reference';
import { currentEpochSeconds, signArtifactId } from './artifact-signature';
import { COMPOSER_SUGGESTION_HISTORY_LIMIT } from './composer-suggestion-history';
import { customAutomationFastSessionAccess } from './custom-automation-session-access';
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
    canRetryFailedStart: boolean;
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

export type FastSessionQueuedMessage = {
  id: string;
  clientMessageId: string;
  /** Sender; only they may withdraw the message before delivery. */
  userId?: string;
  text: string;
  images?: string[];
  timestamp: number;
  optimistic?: boolean;
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
  or (
    ${fastAgentMessages.eventType} = ${ACP_ENVELOPE_EVENT_TYPES.UserPrompt}
    and ${fastAgentMessages.metadata} ->> 'turnSource' = 'platform_event'
    and ${fastAgentMessages.metadata} ->> 'platformEventKind' = 'delegated_task'
  )
)`;

const fastSessionQueuedFollowUpWhere = and(
  isNull(fastAgentParentEvents.deliveredAt),
  isNull(fastAgentParentEvents.discardedAt),
  isNull(fastAgentParentEvents.admission),
  sql`${fastAgentParentEvents.event} ->> 'type' = 'human_follow_up'`,
  sql`${fastAgentParentEvents.event} ->> 'webFollowUp' = 'true'`,
);

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
  privacy: fastAgentConversations.privacy,
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
  // Ordinary conversations remain deployment-collaborative by ID.
  return customAutomationFastSessionAccess(auth);
}

/** Action lookup: custom automation ownership remains required. */
export async function findAccessibleFastSession(
  auth: FastSessionAuth,
  sessionId: string,
) {
  return findFastSession(sessionId, fastSessionScope(auth));
}

/** Shared direct links stay collaborative; private reads require the owner. */
export async function findReadableFastSession(
  auth: FastSessionAuth,
  sessionId: string,
) {
  if (!auth.userId) return null;
  return findFastSession(sessionId, privateFastSessionAccess(auth));
}

async function findFastSession(
  sessionId: string,
  accessCondition?: ReturnType<typeof fastSessionScope>,
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
        accessCondition,
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
  const session = await findReadableFastSession(auth, sessionId);
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
        payloadKind: taskRuns.payloadKind,
        payload: taskRuns.payload,
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
      payloadKind: latestRunPerTask.payloadKind,
      payload: latestRunPerTask.payload,
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
      latestRunPerTask.payloadKind,
      latestRunPerTask.payload,
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

  const retryableFailedStartRunIds = await getRetryableFailedStartRunIds(
    rows.map((row) => ({
      id: row.latestRunId,
      status: row.status,
      payloadKind: row.payloadKind,
      payload: row.payload,
    })),
  );
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
      canRetryFailedStart: retryableFailedStartRunIds.has(row.latestRunId),
    },
  }));
}

async function attachFastSessionTaskTitles(messages: FastSessionMessage[]) {
  const references = messages.map((message) =>
    getTaskMessageReference(message.payload),
  );
  const taskIds = [
    ...new Set(references.flatMap((ref) => (ref?.taskId ? [ref.taskId] : []))),
  ];
  if (!taskIds.length) return messages;

  // Match task-by-ID access: this database is org-scoped; deleted tasks are hidden.
  const rows = await db
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(and(inArray(tasks.id, taskIds), isNull(tasks.deletedAt)));
  const titles = new Map(rows.map((task) => [task.id, task.title]));
  return messages.map((message, index) => {
    const taskId = references[index]?.taskId;
    if (!taskId) return message;
    return {
      ...message,
      payload: {
        ...message.payload,
        taskTitle: titles.get(taskId)?.trim() || null,
      },
    };
  });
}

function parseFastSessionQueuedMessage(row: {
  id: string;
  event: Record<string, unknown>;
  createdAt: Date;
}): FastSessionQueuedMessage | null {
  const clientMessageId = row.event.currentMessageId;
  const text = row.event.question;
  const userId = row.event.userId;
  const images = Array.isArray(row.event.images)
    ? row.event.images.filter(
        (image): image is string => typeof image === 'string',
      )
    : undefined;
  const attachmentTexts = Array.isArray(row.event.attachmentTexts)
    ? row.event.attachmentTexts.filter(
        (text): text is string => typeof text === 'string' && text.length > 0,
      )
    : undefined;

  if (
    typeof clientMessageId !== 'string' ||
    clientMessageId.length === 0 ||
    typeof text !== 'string' ||
    (text.length === 0 && !images?.length && !attachmentTexts?.length)
  ) {
    return null;
  }

  return {
    id: row.id,
    clientMessageId,
    ...(typeof userId === 'string' && userId.length > 0 ? { userId } : {}),
    text: text || (attachmentTexts?.length ? '(queued attachment)' : ''),
    ...(images && images.length > 0 ? { images } : {}),
    timestamp: row.createdAt.getTime(),
  };
}

async function getFastSessionQueuedMessages(
  sessionId: string,
): Promise<FastSessionQueuedMessage[]> {
  const rows = await db
    .select({
      id: fastAgentParentEvents.id,
      event: fastAgentParentEvents.event,
      createdAt: fastAgentParentEvents.createdAt,
    })
    .from(fastAgentParentEvents)
    .where(
      and(
        eq(fastAgentParentEvents.conversationId, sessionId),
        fastSessionQueuedFollowUpWhere,
      ),
    )
    .orderBy(
      asc(fastAgentParentEvents.createdAt),
      asc(fastAgentParentEvents.id),
    );

  return rows.flatMap((row) => {
    const message = parseFastSessionQueuedMessage(row);
    return message ? [message] : [];
  });
}

export async function hasFastSessionQueuedMessages(
  sessionId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: fastAgentParentEvents.id })
    .from(fastAgentParentEvents)
    .where(
      and(
        eq(fastAgentParentEvents.conversationId, sessionId),
        fastSessionQueuedFollowUpWhere,
      ),
    )
    .limit(1);

  return Boolean(row);
}

type FastSessionQueuedMessageWithdrawal =
  | 'withdrawn'
  | 'not_queued'
  | 'forbidden';

/**
 * Withdraw a web follow-up that is still waiting in the Session queue. Only
 * its sender may withdraw it, and only before any delivery path has taken
 * it. Both paths mark the row with a conditional write before the agent can
 * see the message (the queue worker starts an attempt, native steering
 * claims it), and each skips a row already withdrawn, so this write and
 * theirs exclude each other: `withdrawn` means the message will not be
 * delivered, and a message already being delivered reports `not_queued`.
 */
export async function withdrawFastSessionQueuedMessage(params: {
  sessionId: string;
  clientMessageId: string;
  userId: string;
}): Promise<FastSessionQueuedMessageWithdrawal> {
  const queuedMessageWhere = and(
    eq(fastAgentParentEvents.conversationId, params.sessionId),
    fastSessionQueuedFollowUpWhere,
    sql`${fastAgentParentEvents.event} ->> 'currentMessageId' = ${params.clientMessageId}`,
  );
  const [queued] = await db
    .select({
      id: fastAgentParentEvents.id,
      senderUserId: sql<
        string | null
      >`${fastAgentParentEvents.event} ->> 'userId'`,
    })
    .from(fastAgentParentEvents)
    .where(queuedMessageWhere)
    .limit(1);
  if (!queued) return 'not_queued';
  if (queued.senderUserId !== params.userId) return 'forbidden';

  const now = new Date();
  const withdrawn = await db
    .update(fastAgentParentEvents)
    .set({
      discardedAt: now,
      lastError: 'Withdrawn by its sender before delivery.',
      updatedAt: now,
    })
    .where(
      and(
        eq(fastAgentParentEvents.id, queued.id),
        queuedMessageWhere,
        // The queue worker counts an attempt before delivering; an attempt
        // that failed and is parked for a later retry is idle again.
        or(
          eq(fastAgentParentEvents.attempts, 0),
          gt(fastAgentParentEvents.retryAt, now),
        ),
        // Native steering claims the rows it is about to deliver and clears
        // the claim only when it hands them back undelivered. A lapsed claim
        // still blocks: its owner may be mid-delivery or gone, and the queue
        // delivers the row after the lease either way.
        isNull(fastAgentParentEvents.claimedUntil),
        // A prompt that already persisted is in the transcript and will
        // still be delivered, even after an interrupted steer released it.
        sql`not exists (
          select 1 from ${fastAgentMessages}
          where ${fastAgentMessages.conversationId} = ${params.sessionId}
            and ${fastAgentMessages.eventId} = ${`${params.clientMessageId}:user`}
        )`,
      ),
    )
    .returning({ id: fastAgentParentEvents.id });
  return withdrawn.length > 0 ? 'withdrawn' : 'not_queued';
}

function prepareFastSessionMessageRow<
  T extends Pick<
    FastSessionMessage,
    'eventId' | 'role' | 'eventType' | 'contentBlocks' | 'metadata' | 'payload'
  >,
>(row: T): T | null {
  const sanitized = sanitizeEnvelopeFields(
    row.eventType,
    row.contentBlocks,
    (row.metadata as Record<string, unknown> | null) ?? null,
    (row.payload as Record<string, unknown> | null) ?? null,
    { maxOutputChars: ACP_UI_TOOL_OUTPUT_MAX_CHARS },
  );

  if (
    row.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt &&
    sanitized.metadata?.visibleInTranscript !== false
  ) {
    // The turn Roomote sends after the owner saves an integration key starts
    // with one `<integration_saved>` block; the transcript shows only the text
    // after it. Only that exact leading envelope is recognized, so a block
    // quoted or pasted anywhere else in a human message stays as written.
    const text = getTextFromContentBlocks(sanitized.contentBlocks) ?? '';
    if (hasLeadingIntegrationSavedBlock(text)) {
      return {
        ...row,
        contentBlocks: [
          { type: 'text', text: stripLeadingIntegrationSavedBlock(text) },
          ...sanitized.contentBlocks.filter((block) => block.type !== 'text'),
        ],
        metadata: sanitized.metadata,
        payload: sanitized.payload ?? {},
      };
    }
  }

  if (sanitized.metadata?.visibleInTranscript === false) {
    if (
      row.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt &&
      sanitized.metadata.turnSource === 'platform_event' &&
      sanitized.metadata.platformEventKind === 'delegated_task'
    ) {
      // Project only the literal child report, never the internal event wrapper
      // or arbitrary event fields. The persisted model input stays hidden.
      const match = /^<platform_event>(.*)<\/platform_event>$/su.exec(
        (getTextFromContentBlocks(sanitized.contentBlocks) ?? '').trim(),
      );
      if (!match?.[1]) return null;
      let event: Record<string, unknown> | null;
      try {
        event = JSON.parse(match[1]) as Record<string, unknown> | null;
      } catch {
        return null;
      }
      if (
        event?.type !== 'child_message' ||
        typeof event.taskId !== 'string' ||
        !event.taskId.trim() ||
        typeof event.runId !== 'number' ||
        !Number.isSafeInteger(event.runId) ||
        event.runId <= 0 ||
        typeof event.messageId !== 'string' ||
        !event.messageId.trim() ||
        typeof event.purpose !== 'string' ||
        !['ack', 'progress', 'closeout', 'clarification'].includes(
          event.purpose,
        ) ||
        typeof event.message !== 'string' ||
        !event.message.trim()
      ) {
        return null;
      }
      const receipt = sanitizeEnvelopeFields(
        ACP_ENVELOPE_EVENT_TYPES.ToolResult,
        [{ type: 'text', text: event.message }],
        { visibleInTranscript: true, toolCallId: row.eventId },
        {
          toolName: 'receive_task_report',
          toolCallId: row.eventId,
          status: 'completed',
          rawInput: {
            taskId: event.taskId,
            runId: event.runId,
            messageId: event.messageId,
            purpose: event.purpose,
          },
          output: event.message,
        },
        { maxOutputChars: ACP_UI_TOOL_OUTPUT_MAX_CHARS },
      );
      return {
        ...row,
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
        role: 'tool',
        contentBlocks: receipt.contentBlocks,
        metadata: receipt.metadata,
        payload: receipt.payload ?? {},
      };
    }
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
  queuedMessages: FastSessionQueuedMessage[];
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
  const queuedMessages = await getFastSessionQueuedMessages(sessionId);

  return {
    messages: await attachFastSessionTaskTitles(messages),
    queuedMessages,
    cursor,
  };
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
    text: visibleSuggestableText(
      extractAcpMessageText(
        row.contentBlocks,
        (row.payload as Record<string, unknown> | null) ?? null,
      ) ?? null,
    ),
  }));
}

export async function getFastSessionById(
  auth: FastSessionAuth,
  sessionId: string,
) {
  if (!auth.userId) return null;
  const [session] = await db
    .select(fastSessionSelection)
    .from(fastAgentConversations)
    .leftJoin(users, eq(fastAgentConversations.userId, users.id))
    .where(
      and(
        eq(fastAgentConversations.id, sessionId),
        privateFastSessionAccess(auth),
      ),
    )
    .limit(1);

  if (!session) {
    return null;
  }

  const rows: FastSessionMessage[] = [];
  let before: ReturnType<typeof sql> | undefined;
  // Hidden platform events can fail projection; count only validated rows
  // toward the window, without loading an unbounded backlog into memory.
  while (rows.length <= FAST_SESSION_TRANSCRIPT_MESSAGE_LIMIT) {
    const batch = await db
      .select({
        ...fastSessionMessageSelection,
        // Preserve Postgres microseconds for keyset ties instead of a JS Date.
        cursorCreatedAt: sql<string>`${fastAgentMessages.createdAt}::text`,
      })
      .from(fastAgentMessages)
      .leftJoin(users, fastSessionMessageUserJoin)
      .where(
        and(
          eq(fastAgentMessages.conversationId, session.id),
          fastSessionTranscriptVisibilityWhere,
          before,
        ),
      )
      .orderBy(
        desc(fastAgentMessages.ts),
        desc(fastAgentMessages.turnSeq),
        desc(fastAgentMessages.createdAt),
        desc(fastAgentMessages.id),
      )
      .limit(FAST_SESSION_TRANSCRIPT_MESSAGE_LIMIT + 1);

    for (const { cursorCreatedAt: _cursorCreatedAt, ...row } of batch) {
      const prepared = prepareFastSessionMessageRow(row);
      if (prepared) rows.push(prepared);
      if (rows.length > FAST_SESSION_TRANSCRIPT_MESSAGE_LIMIT) break;
    }
    if (batch.length <= FAST_SESSION_TRANSCRIPT_MESSAGE_LIMIT) break;
    const last = batch[batch.length - 1]!;
    before = sql`(${fastAgentMessages.ts}, ${fastAgentMessages.turnSeq}, ${fastAgentMessages.createdAt}, ${fastAgentMessages.id})
      < (${last.ts}, ${last.turnSeq}, ${last.cursorCreatedAt}::timestamp, ${last.id}::uuid)`;
  }

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

  const messages = await attachFastSessionReplyImages(
    session.id,
    await attachFastSessionTaskTitles(windowed.reverse()),
  );
  const queuedMessages = await getFastSessionQueuedMessages(session.id);

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
    queuedMessages,
    hasOlderMessages,
    directInferenceCostMicroUsd,
    inferenceCostMicroUsd: directInferenceCostMicroUsd,
  };
}

function visibleSuggestableText(text: string | null): string | null {
  return text && hasLeadingIntegrationSavedBlock(text)
    ? stripLeadingIntegrationSavedBlock(text)
    : text;
}
