import type { ModelMessage } from 'ai';
import {
  and,
  type CreateFastAgentMessage,
  db,
  desc,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  fastAgentParentEvents,
  ensureSessionForFastConversation,
  advanceSessionNotifiedCursor,
  attachFastConversationToSession,
  advanceSessionReadCursor,
  getSessionForFastConversation,
  gt,
  isNotNull,
  isNull,
  lt,
  or,
  sessions,
  sql,
  touchSessionActivity,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  fastAgentConversationSchema,
} from '@roomote/types';

import { FAST_RESPONDING_LEASE_MS } from './fast-agent-constants';
import {
  FAST_AGENT_REACTION_INPUT_TYPE,
  type FastAgentConversation,
} from './fast-agent-conversation';

export type FastAgentConversationRecord = {
  id: string;
  userId: string;
  title: string | null;
  conversation: FastAgentConversation;
  /**
   * Durable visible history for cold starts and provider retries. OpenCode,
   * not this field, owns the live warm transcript.
   */
  compatibilityMessages: ModelMessage[];
  /** Last successfully completed native session; validated before cold resume. */
  openCodeSessionId: string | null;
};

export type FastAgentConversationGetOrCreateResult =
  FastAgentConversationRecord & {
    created: boolean;
  };

export type FastAgentMessageWrite = Omit<
  CreateFastAgentMessage,
  'conversationId'
>;

export type FastAgentMessageUpsertResult = {
  initialHumanTurn: boolean;
};

export const INTERRUPTED_INFERENCE_RETRY_MESSAGE =
  'The inference retry was interrupted before it completed. Please send the request again.';

export const RESTARTED_ACTIVE_TURN_MESSAGE =
  'Roomote restarted while working on this request. Please send it again.';

/**
 * Why an accepted Fast turn ended without a real answer. Stamped into the
 * terminal message's metadata by every writer so occurrence counts can be
 * attributed per cause instead of investigated per incident.
 */
export type FastAgentInterruptionReason =
  | 'api_shutdown'
  | 'turn_aborted'
  | 'lock_lost'
  | 'next_turn_reconcile'
  | 'turn_settled_reconcile'
  | 'expired_lease_reconcile';

function isLegacyPlatformEventMessage(message: ModelMessage): boolean {
  if (message.role !== 'user') return false;

  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('');
  const normalized = text.trim();
  return (
    normalized.startsWith('<platform_event>') &&
    normalized.endsWith('</platform_event>')
  );
}

function activeInferenceRetryNoticeWhere() {
  return and(
    // The event slot also matches notices written before retry lifecycle
    // metadata was introduced, so existing stale transcripts self-heal.
    sql`${fastAgentMessages.eventId} LIKE ${'%:retry-notice%'}`,
    sql`${fastAgentMessages.metadata}->>'purpose' = 'progress'`,
    or(
      sql`${fastAgentMessages.metadata}->>'inferenceRetryActive' = 'true'`,
      sql`${fastAgentMessages.metadata}->>'inferenceRetryActive' IS NULL`,
    ),
  );
}

async function reconcileInferenceRetryNotices(
  database: DatabaseOrTransaction,
  conversationId: string,
  requireExpiredLease: boolean,
  reason: FastAgentInterruptionReason,
): Promise<number> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`fast-agent-conversation:${conversationId}`}, 0))`,
  );

  if (requireExpiredLease) {
    const session = await getSessionForFastConversation(
      database,
      conversationId,
    );
    if (session?.respondingUntil && session.respondingUntil > new Date()) {
      return 0;
    }
  }

  // One set-based statement with no prior read: the terminal metadata is
  // derived from each row's current value under its row lock, so a cause an
  // interrupted owner commits concurrently (e.g. lock_lost) cannot be
  // overwritten by a stale snapshot; the reconciler's own reason only fills
  // in when nobody recorded one.
  const reconciled = await database
    .update(fastAgentMessages)
    .set({
      contentBlocks: [
        { type: 'text', text: INTERRUPTED_INFERENCE_RETRY_MESSAGE },
      ],
      metadata: sql`coalesce(${fastAgentMessages.metadata}, '{}'::jsonb)
        || ${JSON.stringify({
          visibleInTranscript: true,
          purpose: 'closeout',
          inferenceRetryNotice: true,
          inferenceRetryActive: false,
        })}::jsonb
        || jsonb_build_object('interruptionReason', coalesce(${fastAgentMessages.metadata}->>'interruptionReason', ${reason}::text))`,
      payload: sql`coalesce(${fastAgentMessages.payload}, '{}'::jsonb) || '{"purpose":"closeout"}'::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(fastAgentMessages.conversationId, conversationId),
        activeInferenceRetryNoticeWhere(),
      ),
    )
    .returning({ id: fastAgentMessages.id });

  if (reconciled.length > 0) {
    console.warn(
      `[Fast Agent] Reconciled ${reconciled.length} interrupted inference retry notice(s) (conversation=${conversationId}, reason=${reason}).`,
    );
  }

  return reconciled.length;
}

export async function reconcileFastAgentInferenceRetryNotices(
  conversationId: string,
  reason: Extract<
    FastAgentInterruptionReason,
    'next_turn_reconcile' | 'turn_settled_reconcile'
  >,
): Promise<number> {
  return db.transaction((tx) =>
    reconcileInferenceRetryNotices(tx, conversationId, false, reason),
  );
}

/**
 * Record why an active retry notice was orphaned without flipping it to a
 * terminal closeout. Used by an owner that lost the conversation lock: it is
 * fenced off from terminal writes (a successor may already own the turn), but
 * this guarded, fill-only stamp is a no-op whenever a successor got there
 * first, and the lease-gated reconciler later folds the cause into its
 * closeout.
 */
export async function markFastAgentInferenceRetryNoticeInterruption(
  conversationId: string,
  eventId: string,
  reason: FastAgentInterruptionReason,
): Promise<boolean> {
  const stamped = await db
    .update(fastAgentMessages)
    .set({
      metadata: sql`coalesce(${fastAgentMessages.metadata}, '{}'::jsonb) || ${JSON.stringify({ interruptionReason: reason })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(fastAgentMessages.conversationId, conversationId),
        eq(fastAgentMessages.eventId, eventId),
        activeInferenceRetryNoticeWhere(),
        sql`${fastAgentMessages.metadata}->>'interruptionReason' IS NULL`,
      ),
    )
    .returning({ id: fastAgentMessages.id });
  return stamped.length > 0;
}

/** One action the interrupted attempt of a turn took, as the transcript recorded it. */
export type FastAgentTurnAttemptAction = {
  tool: string;
  arguments: unknown;
  /** 'unknown' when the call was recorded but the process died before its result. */
  status: 'completed' | 'failed' | 'unknown';
  result?: string;
};

export type FastAgentTurnAttemptSummary = {
  /** Visible assistant replies the attempt already posted, in order. */
  replies: string[];
  actions: FastAgentTurnAttemptAction[];
};

const TURN_ATTEMPT_RESULT_MAX_CHARS = 1_200;

/**
 * What an earlier attempt at this turn already did, for the run that resumes
 * it. Every tool call is recorded before it executes and its result after,
 * so a resumed run can be told exactly what happened instead of starting the
 * turn over and repeating actions. A call with no result is reported as
 * unknown: the process died between starting it and recording the outcome.
 */
export async function loadFastAgentTurnAttemptSummary(
  conversationId: string,
  turnId: string,
): Promise<FastAgentTurnAttemptSummary> {
  const rows = await db
    .select({
      eventType: fastAgentMessages.eventType,
      role: fastAgentMessages.role,
      contentBlocks: fastAgentMessages.contentBlocks,
      metadata: fastAgentMessages.metadata,
      payload: fastAgentMessages.payload,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, conversationId),
        eq(fastAgentMessages.turnId, turnId),
      ),
    )
    .orderBy(fastAgentMessages.turnSeq, fastAgentMessages.ts);

  const text = (blocks: unknown) =>
    Array.isArray(blocks)
      ? blocks
          .flatMap((block) =>
            block &&
            typeof block === 'object' &&
            (block as { type?: unknown }).type === 'text'
              ? [String((block as { text?: unknown }).text ?? '')]
              : [],
          )
          .join('')
      : '';

  const replies: string[] = [];
  const actions = new Map<string, FastAgentTurnAttemptAction>();
  for (const row of rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    if (
      row.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCall ||
      row.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolResult
    ) {
      // A call and its result share one canonical event, so the result row
      // replaces the call row once it lands and carries the arguments with
      // it. A call row that is still present therefore has no result: the
      // process died between starting the call and recording its outcome.
      const toolCallId = String(payload.toolCallId ?? '');
      if (!toolCallId) continue;
      const rawInput = payload.rawInput as { arguments?: unknown } | undefined;
      const action: FastAgentTurnAttemptAction = {
        tool: String(payload.toolName ?? payload.title ?? 'tool'),
        arguments: rawInput?.arguments ?? null,
        status:
          row.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCall
            ? 'unknown'
            : payload.status === 'failed'
              ? 'failed'
              : 'completed',
      };
      if (action.status !== 'unknown') {
        const output = text(row.contentBlocks);
        if (output) {
          action.result =
            output.length > TURN_ATTEMPT_RESULT_MAX_CHARS
              ? `${output.slice(0, TURN_ATTEMPT_RESULT_MAX_CHARS)}…`
              : output;
        }
      }
      actions.set(toolCallId, action);
    } else if (
      row.role === 'assistant' &&
      row.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage &&
      metadata.visibleInTranscript !== false &&
      metadata.interruptionReason === undefined
    ) {
      const reply = text(row.contentBlocks).trim();
      if (reply) replies.push(reply);
    }
  }
  return { replies, actions: [...actions.values()] };
}

export type FastAgentUnresolvedRequest = {
  /** Turn whose human request never received a completed answer. */
  turnId: string;
  text: string;
  reason: string;
};

const UNRESOLVED_REQUEST_CHAIN_LIMIT = 8;

async function findFastAgentTurnPrompt(
  conversationId: string,
  turnId: string,
): Promise<{ text: string; metadata: Record<string, unknown> } | null> {
  const [prompt] = await db
    .select({
      contentBlocks: fastAgentMessages.contentBlocks,
      metadata: fastAgentMessages.metadata,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, conversationId),
        eq(fastAgentMessages.turnId, turnId),
        eq(fastAgentMessages.role, 'user'),
        eq(fastAgentMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
      ),
    )
    .limit(1);
  if (!prompt) return null;
  const text = prompt.contentBlocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
  return { text, metadata: prompt.metadata ?? {} };
}

/**
 * The human request the conversation still owes an answer to, if the most
 * recent turn ended in an interruption closeout instead of a completed reply.
 * A turn that itself resumed an earlier interrupted request records that
 * lineage in its prompt metadata, so the original request is what surfaces
 * even after repeated interruptions.
 */
export async function findFastAgentUnresolvedRequest(
  conversationId: string,
): Promise<FastAgentUnresolvedRequest | null> {
  // Anchor on the latest substantive human prompt: platform events and
  // reactions are persisted as prompts too, but their turns neither answer
  // nor supersede a human request, so they must not mask an owed one.
  const [latestPrompt] = await db
    .select({ turnId: fastAgentMessages.turnId })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, conversationId),
        eq(fastAgentMessages.role, 'user'),
        eq(fastAgentMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
        sql`${fastAgentMessages.metadata}->>'turnSource' = 'human'`,
        or(
          sql`${fastAgentMessages.metadata}->>'inputKind' IS NULL`,
          sql`${fastAgentMessages.metadata}->>'inputKind' <> ${FAST_AGENT_REACTION_INPUT_TYPE}`,
        ),
      ),
    )
    .orderBy(desc(fastAgentMessages.ts), desc(fastAgentMessages.turnSeq))
    .limit(1);
  if (!latestPrompt) return null;

  const [interruption] = await db
    .select({ metadata: fastAgentMessages.metadata })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, conversationId),
        eq(fastAgentMessages.turnId, latestPrompt.turnId),
        eq(fastAgentMessages.role, 'assistant'),
        sql`${fastAgentMessages.metadata}->>'interruptionReason' IS NOT NULL`,
      ),
    )
    .limit(1);
  if (!interruption) return null;
  const reason = interruption.metadata?.interruptionReason;
  if (typeof reason !== 'string') return null;

  let turnId = latestPrompt.turnId;
  let prompt = await findFastAgentTurnPrompt(conversationId, turnId);
  for (
    let hop = 0;
    prompt &&
    typeof prompt.metadata.resumesTurnId === 'string' &&
    hop < UNRESOLVED_REQUEST_CHAIN_LIMIT;
    hop += 1
  ) {
    const rootPrompt = await findFastAgentTurnPrompt(
      conversationId,
      prompt.metadata.resumesTurnId,
    );
    if (!rootPrompt) break;
    turnId = prompt.metadata.resumesTurnId;
    prompt = rootPrompt;
  }
  if (
    !prompt ||
    !prompt.text ||
    prompt.metadata.turnSource !== 'human' ||
    prompt.metadata.inputKind === FAST_AGENT_REACTION_INPUT_TYPE
  ) {
    return null;
  }
  return { turnId, text: prompt.text, reason };
}

/**
 * Durable admission of human turns. The accepting process persists the turn
 * as an inline-admitted parent event before running it, holds a claim lease
 * while it works, and settles the row when it finishes. If the process dies
 * first, the released or expired claim lets the parent-event queue re-run
 * the turn, but only while replay is still safe.
 */
export const FAST_AGENT_DURABLE_TURN_CLAIM_MS = 15 * 60 * 1000;

function pendingDurableTurnWhere(id: string) {
  return and(
    eq(fastAgentParentEvents.id, id),
    isNull(fastAgentParentEvents.deliveredAt),
    isNull(fastAgentParentEvents.discardedAt),
  );
}

/** Extend the inline owner's claim; false once the row is no longer pending. */
export async function renewFastAgentDurableTurnClaim(
  id: string,
): Promise<boolean> {
  const rows = await db
    .update(fastAgentParentEvents)
    .set({
      claimedUntil: new Date(Date.now() + FAST_AGENT_DURABLE_TURN_CLAIM_MS),
      updatedAt: new Date(),
    })
    .where(pendingDurableTurnWhere(id))
    .returning({ id: fastAgentParentEvents.id });
  return rows.length > 0;
}

/**
 * Hand the turn to the queue: an interrupted owner clears its claim so the
 * next drain or recovery sweep re-runs the turn immediately.
 */
export async function releaseFastAgentDurableTurnClaim(
  id: string,
): Promise<boolean> {
  const rows = await db
    .update(fastAgentParentEvents)
    .set({ claimedUntil: null, updatedAt: new Date() })
    .where(pendingDurableTurnWhere(id))
    .returning({ id: fastAgentParentEvents.id });
  return rows.length > 0;
}

/**
 * Permanently withdraw the turn from replay, recorded before the action
 * that makes replay unsafe runs, so a crash after it can never re-run it.
 */
export async function revokeFastAgentDurableTurnReplay(
  id: string,
  reason: string,
): Promise<boolean> {
  const rows = await db
    .update(fastAgentParentEvents)
    .set({
      discardedAt: new Date(),
      lastError: reason,
      updatedAt: new Date(),
    })
    .where(pendingDurableTurnWhere(id))
    .returning({ id: fastAgentParentEvents.id });
  return rows.length > 0;
}

/**
 * Park the turn for a durable inference retry: the owner gives up its claim
 * and the queue re-runs the row once `retryAt` arrives, on whichever process
 * is alive then. The consumed retry count travels with the row so the
 * per-turn cap holds across owners. False once the row is no longer pending
 * (superseded or already withdrawn), in which case the caller keeps the
 * retry in process.
 */
export async function scheduleFastAgentDurableTurnRetry(
  id: string,
  params: { retryAt: Date; inferenceRetries: number; reason: string },
): Promise<boolean> {
  const rows = await db
    .update(fastAgentParentEvents)
    .set({
      claimedUntil: null,
      retryAt: params.retryAt,
      inferenceRetries: params.inferenceRetries,
      lastError: params.reason,
      updatedAt: new Date(),
    })
    .where(pendingDurableTurnWhere(id))
    .returning({ id: fastAgentParentEvents.id });
  return rows.length > 0;
}

export type FastAgentActiveInferenceRetryNotice = {
  eventId: string;
  ts: number;
  text: string;
  platformMessageId: string | null;
};

/**
 * The retry notice a previous execution of this same turn left active, so a
 * resumed run can keep editing that notice instead of reconciling it into
 * an interruption and posting its answer beside a stale "retrying" message.
 */
export async function findFastAgentActiveInferenceRetryNotice(
  conversationId: string,
  turnId: string,
): Promise<FastAgentActiveInferenceRetryNotice | null> {
  const [notice] = await db
    .select({
      eventId: fastAgentMessages.eventId,
      ts: fastAgentMessages.ts,
      contentBlocks: fastAgentMessages.contentBlocks,
      metadata: fastAgentMessages.metadata,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, conversationId),
        eq(fastAgentMessages.turnId, turnId),
        activeInferenceRetryNoticeWhere(),
      ),
    )
    .orderBy(desc(fastAgentMessages.ts))
    .limit(1);
  if (!notice) return null;
  const platformMessageId = notice.metadata?.platformMessageId;
  return {
    eventId: notice.eventId,
    ts: notice.ts,
    text: notice.contentBlocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n'),
    platformMessageId:
      typeof platformMessageId === 'string' ? platformMessageId : null,
  };
}

/** The turn produced its outcome; nothing is left to recover. */
export async function markFastAgentDurableTurnDelivered(
  id: string,
): Promise<boolean> {
  const rows = await db
    .update(fastAgentParentEvents)
    .set({ deliveredAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(pendingDurableTurnWhere(id))
    .returning({ id: fastAgentParentEvents.id });
  return rows.length > 0;
}

/**
 * Extend the responding lease with the fence in the statement itself: only a
 * lease that is still live is extended, so a stale renewal from an owner that
 * lost the conversation mid-write can never resurrect a lease a settlement
 * or successor already cleared. No read precedes the write, which removes
 * the check-then-write window entirely. Returns whether a lease was renewed.
 */
export async function renewFastSessionRespondingLease(
  fastConversationId: string,
): Promise<boolean> {
  const renewed = await db
    .update(sessions)
    .set({
      respondingUntil: new Date(Date.now() + FAST_RESPONDING_LEASE_MS),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessions.fastConversationId, fastConversationId),
        isNotNull(sessions.respondingUntil),
        gt(sessions.respondingUntil, new Date()),
      ),
    )
    .returning({ id: sessions.id });
  return renewed.length > 0;
}

export async function reconcileExpiredFastAgentInferenceRetryNotices(
  limit = 100,
): Promise<number> {
  const candidates = await db
    .selectDistinct({ conversationId: fastAgentMessages.conversationId })
    .from(fastAgentMessages)
    .innerJoin(
      sessions,
      eq(sessions.fastConversationId, fastAgentMessages.conversationId),
    )
    .where(
      and(
        activeInferenceRetryNoticeWhere(),
        or(
          isNull(sessions.respondingUntil),
          lt(sessions.respondingUntil, new Date()),
        ),
        // A durably scheduled retry (or a live inline claim) means the turn
        // is still owned by recovery, not orphaned: its notice will be
        // edited by the resumed run, so an expired lease must not turn it
        // into an interruption in the meantime.
        sql`not exists (
          select 1 from ${fastAgentParentEvents}
          where ${fastAgentParentEvents.conversationId} = ${fastAgentMessages.conversationId}
            and ${fastAgentParentEvents.admission} = 'inline'
            and ${fastAgentParentEvents.deliveredAt} is null
            and ${fastAgentParentEvents.discardedAt} is null
            and (${fastAgentParentEvents.retryAt} > now()
              or ${fastAgentParentEvents.claimedUntil} > now())
        )`,
      ),
    )
    .limit(limit);

  let reconciled = 0;
  for (const candidate of candidates) {
    // The per-conversation lock and lease recheck prevent a renewed active
    // turn from being reconciled after the candidate scan races with it.
    reconciled += await db.transaction((tx) =>
      reconcileInferenceRetryNotices(
        tx,
        candidate.conversationId,
        true,
        'expired_lease_reconcile',
      ),
    );
  }
  return reconciled;
}

export interface FastAgentConversationRepository {
  getOrCreate(input: {
    userId: string;
    conversation: FastAgentConversation;
    /**
     * Session to bind a newly created conversation to, when that Session has
     * no conversation yet. A conversation that already exists keeps its own
     * Session.
     */
    sessionId?: string;
  }): Promise<FastAgentConversationGetOrCreateResult>;
  findById(input: {
    id: string;
    fallbackConversation?: FastAgentConversation;
  }): Promise<FastAgentConversationRecord | null>;
  getLookupIds(id: string): Promise<string[]>;
  exists(conversation: FastAgentConversation): Promise<boolean>;
  appendVisibleMessages(input: {
    conversationId: string;
    messages: ModelMessage[];
  }): Promise<void>;
  upsertMessage(input: {
    conversationId: string;
    message: FastAgentMessageWrite;
  }): Promise<FastAgentMessageUpsertResult>;
  setOpenCodeSession(input: {
    conversationId: string;
    openCodeSessionId: string;
  }): Promise<void>;
}

function buildIdentityKey(conversation: FastAgentConversation): string {
  return `${conversation.surface}:${conversation.workspaceId}:${conversation.conversationId}`;
}

function buildIdentityWhere(conversation: FastAgentConversation) {
  return and(
    eq(fastAgentConversations.surface, conversation.surface),
    eq(fastAgentConversations.workspaceId, conversation.workspaceId),
    eq(fastAgentConversations.conversationId, conversation.conversationId),
  );
}

function buildReplyTargetWhere(conversation: FastAgentConversation) {
  if (!('replyTarget' in conversation) || !conversation.replyTarget.threadId) {
    return null;
  }

  return and(
    eq(fastAgentConversations.surface, conversation.surface),
    eq(fastAgentConversations.workspaceId, conversation.workspaceId),
    eq(
      fastAgentConversations.currentReplyChannelId,
      conversation.replyTarget.channelId,
    ),
    eq(
      fastAgentConversations.currentReplyThreadId,
      conversation.replyTarget.threadId,
    ),
  );
}

function identityMatches(
  record: Pick<
    typeof fastAgentConversations.$inferSelect,
    'surface' | 'workspaceId' | 'conversationId'
  >,
  conversation: FastAgentConversation,
): boolean {
  return (
    record.surface === conversation.surface &&
    record.workspaceId === conversation.workspaceId &&
    record.conversationId === conversation.conversationId
  );
}

function toConversation(
  record: Pick<
    typeof fastAgentConversations.$inferSelect,
    | 'surface'
    | 'workspaceId'
    | 'conversationId'
    | 'currentReplyChannelId'
    | 'currentReplyThreadId'
    | 'currentReplyServiceUrl'
  >,
): FastAgentConversation | null {
  const parsed = fastAgentConversationSchema.safeParse(
    record.surface === 'automation' || record.surface === 'web'
      ? {
          surface: record.surface,
          workspaceId: record.workspaceId,
          conversationId: record.conversationId,
        }
      : {
          surface: record.surface,
          workspaceId: record.workspaceId,
          conversationId: record.conversationId,
          replyTarget: {
            channelId: record.currentReplyChannelId,
            ...(record.currentReplyThreadId
              ? { threadId: record.currentReplyThreadId }
              : {}),
            ...(record.currentReplyServiceUrl
              ? { serviceUrl: record.currentReplyServiceUrl }
              : {}),
          },
        },
  );

  return parsed.success ? parsed.data : null;
}

async function resolveCanonicalId(
  database: DatabaseOrTransaction,
  requestedId: string,
): Promise<string> {
  const aliased = await database.query.fastAgentConversations.findFirst({
    where: sql`${requestedId} = ANY(${fastAgentConversations.legacyConversationIds})`,
    columns: { id: true },
  });

  return aliased?.id ?? requestedId;
}

async function loadConversationRecord(
  database: DatabaseOrTransaction,
  conversationId: string,
): Promise<FastAgentConversationRecord> {
  const record = await database.query.fastAgentConversations.findFirst({
    where: eq(fastAgentConversations.id, conversationId),
  });
  const conversation = record ? toConversation(record) : null;
  if (!record || !conversation) {
    throw new Error('Fast conversation has an invalid reply target.');
  }

  return {
    id: record.id,
    userId: record.userId,
    title: record.title,
    conversation,
    compatibilityMessages: record.compatibilityMessages as ModelMessage[],
    openCodeSessionId: record.openCodeSessionId,
  };
}

export const fastAgentConversationRepository: FastAgentConversationRepository =
  {
    async getOrCreate({ userId, conversation, sessionId }) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${buildIdentityKey(conversation)}, 0))`,
        );

        let record = await tx.query.fastAgentConversations.findFirst({
          where: buildIdentityWhere(conversation),
        });

        let created = false;
        const replyTargetWhere = buildReplyTargetWhere(conversation);
        if (!record && replyTargetWhere) {
          record = await tx.query.fastAgentConversations.findFirst({
            where: replyTargetWhere,
          });
        }

        // Launches into one Session with different conversation identities
        // must agree on a single conversation. Serialize on the Session and
        // reuse the conversation a concurrent launch already bound to it.
        if (!record && sessionId) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`fast-agent-session-binding:${sessionId}`}, 0))`,
          );
          const [bound] = await tx
            .select({ fastConversationId: sessions.fastConversationId })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .limit(1);
          if (bound?.fastConversationId) {
            return {
              ...(await loadConversationRecord(tx, bound.fastConversationId)),
              created: false,
            };
          }
        }

        if (!record) {
          const [inserted] = await tx
            .insert(fastAgentConversations)
            .values({
              userId,
              surface: conversation.surface,
              workspaceId: conversation.workspaceId,
              conversationId: conversation.conversationId,
              currentReplyChannelId:
                'replyTarget' in conversation
                  ? conversation.replyTarget.channelId
                  : null,
              currentReplyThreadId:
                'replyTarget' in conversation
                  ? conversation.replyTarget.threadId
                  : null,
              currentReplyServiceUrl:
                'replyTarget' in conversation
                  ? (conversation.replyTarget.serviceUrl ?? null)
                  : null,
              replyTargetVerified: true,
            })
            .onConflictDoNothing()
            .returning({ id: fastAgentConversations.id });
          created = Boolean(inserted);
          record = await tx.query.fastAgentConversations.findFirst({
            where: buildIdentityWhere(conversation),
          });
        }
        if (!record) {
          throw new Error('Failed to create or load Fast conversation.');
        }

        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`fast-agent-conversation:${record.id}`}, 0))`,
        );
        const [updated] = await tx
          .update(fastAgentConversations)
          .set({
            currentReplyChannelId:
              'replyTarget' in conversation
                ? conversation.replyTarget.channelId
                : null,
            currentReplyThreadId:
              'replyTarget' in conversation
                ? (conversation.replyTarget.threadId ?? null)
                : null,
            currentReplyServiceUrl:
              'replyTarget' in conversation
                ? (conversation.replyTarget.serviceUrl ?? null)
                : null,
            replyTargetVerified: true,
            updatedAt: sql`now()`,
          })
          .where(eq(fastAgentConversations.id, record.id))
          .returning();

        const conversationId = updated?.id ?? record.id;
        const attached =
          created && sessionId
            ? await attachFastConversationToSession(tx, {
                sessionId,
                fastConversationId: conversationId,
              })
            : null;
        if (!attached) {
          await ensureSessionForFastConversation(tx, conversationId);
        }

        return {
          ...(await loadConversationRecord(tx, conversationId)),
          created,
        };
      });
    },

    async findById({ id, fallbackConversation }) {
      const conversationId = await resolveCanonicalId(db, id);
      let record = await db.query.fastAgentConversations.findFirst({
        where: eq(fastAgentConversations.id, conversationId),
      });

      if (
        !record ||
        (fallbackConversation && !identityMatches(record, fallbackConversation))
      ) {
        return null;
      }

      if (!record.replyTargetVerified && fallbackConversation) {
        const [updated] = await db
          .update(fastAgentConversations)
          .set({
            currentReplyChannelId:
              'replyTarget' in fallbackConversation
                ? fallbackConversation.replyTarget.channelId
                : null,
            currentReplyThreadId:
              'replyTarget' in fallbackConversation
                ? (fallbackConversation.replyTarget.threadId ?? null)
                : null,
            currentReplyServiceUrl:
              'replyTarget' in fallbackConversation
                ? (fallbackConversation.replyTarget.serviceUrl ?? null)
                : null,
            replyTargetVerified: true,
            updatedAt: sql`now()`,
          })
          .where(eq(fastAgentConversations.id, record.id))
          .returning();
        record = updated ?? record;
      }

      return loadConversationRecord(db, record.id);
    },

    async getLookupIds(id) {
      const conversationId = await resolveCanonicalId(db, id);
      const record = await db.query.fastAgentConversations.findFirst({
        where: eq(fastAgentConversations.id, conversationId),
        columns: { legacyConversationIds: true },
      });
      return [
        ...new Set([conversationId, ...(record?.legacyConversationIds ?? [])]),
      ];
    },

    async exists(conversation) {
      const exact = await db.query.fastAgentConversations.findFirst({
        where: buildIdentityWhere(conversation),
        columns: { id: true },
      });
      if (exact) {
        return true;
      }

      const replyTargetWhere = buildReplyTargetWhere(conversation);
      if (!replyTargetWhere) {
        return false;
      }

      const routed = await db.query.fastAgentConversations.findFirst({
        where: replyTargetWhere,
        columns: { id: true },
      });
      return Boolean(routed);
    },

    async appendVisibleMessages({ conversationId: requestedId, messages }) {
      if (messages.length === 0) {
        return;
      }

      await db.transaction(async (tx) => {
        const conversationId = await resolveCanonicalId(tx, requestedId);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`fast-agent-conversation:${conversationId}`}, 0))`,
        );
        const [updated] = await tx
          .update(fastAgentConversations)
          .set({
            compatibilityMessages: sql`${fastAgentConversations.compatibilityMessages} || ${JSON.stringify(messages)}::jsonb`,
            updatedAt: sql`now()`,
          })
          .where(eq(fastAgentConversations.id, conversationId))
          .returning({ id: fastAgentConversations.id });
        if (!updated) {
          throw new Error('Fast conversation was not found.');
        }
        const session = await getSessionForFastConversation(tx, conversationId);
        if (session) {
          await touchSessionActivity(
            tx,
            session.id,
            Math.floor(Date.now() / 1000),
            { recomputeStatus: false },
          );
        }
      });
    },

    async upsertMessage({ conversationId: requestedId, message }) {
      return db.transaction(async (tx) => {
        const conversationId = await resolveCanonicalId(tx, requestedId);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`fast-agent-conversation:${conversationId}`}, 0))`,
        );
        const [conversation] = await tx
          .select({
            id: fastAgentConversations.id,
            compatibilityMessages: fastAgentConversations.compatibilityMessages,
          })
          .from(fastAgentConversations)
          .where(eq(fastAgentConversations.id, conversationId))
          .limit(1);
        if (!conversation) {
          throw new Error('Fast conversation was not found.');
        }

        const isSubstantiveHumanPrompt =
          message.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt &&
          message.role === 'user' &&
          message.metadata?.turnSource === 'human' &&
          message.metadata?.inputKind !== FAST_AGENT_REACTION_INPUT_TYPE;
        let initialHumanTurn = false;
        if (isSubstantiveHumanPrompt) {
          const [currentHumanPrompt] = await tx
            .select({ id: fastAgentMessages.id })
            .from(fastAgentMessages)
            .where(
              and(
                eq(fastAgentMessages.conversationId, conversationId),
                eq(fastAgentMessages.eventId, message.eventId),
                eq(
                  fastAgentMessages.eventType,
                  ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
                ),
                eq(fastAgentMessages.role, 'user'),
                sql`${fastAgentMessages.metadata}->>'turnSource' = 'human'`,
                sql`coalesce(${fastAgentMessages.metadata}->>'inputKind', 'message') <> ${FAST_AGENT_REACTION_INPUT_TYPE}`,
              ),
            )
            .limit(1);
          const [priorHumanPrompt] = await tx
            .select({ id: fastAgentMessages.id })
            .from(fastAgentMessages)
            .where(
              and(
                eq(fastAgentMessages.conversationId, conversationId),
                eq(
                  fastAgentMessages.eventType,
                  ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
                ),
                eq(fastAgentMessages.role, 'user'),
                sql`${fastAgentMessages.metadata}->>'turnSource' = 'human'`,
                sql`coalesce(${fastAgentMessages.metadata}->>'inputKind', 'message') <> ${FAST_AGENT_REACTION_INPUT_TYPE}`,
                sql`${fastAgentMessages.eventId} <> ${message.eventId}`,
              ),
            )
            .limit(1);
          const hasCompatibilityHumanPrompt = (
            conversation.compatibilityMessages as ModelMessage[]
          ).some(
            (compatibilityMessage) =>
              compatibilityMessage.role === 'user' &&
              !isLegacyPlatformEventMessage(compatibilityMessage),
          );
          initialHumanTurn =
            !priorHumanPrompt &&
            (Boolean(currentHumanPrompt) || !hasCompatibilityHumanPrompt);
        }

        await tx
          .insert(fastAgentMessages)
          .values({ conversationId, ...message })
          .onConflictDoUpdate({
            target: [
              fastAgentMessages.conversationId,
              fastAgentMessages.eventId,
            ],
            set: {
              turnId: message.turnId,
              turnSeq: message.turnSeq,
              ts: message.ts,
              eventType: message.eventType,
              role: message.role ?? null,
              contentBlocks: message.contentBlocks ?? [],
              metadata: message.metadata ?? null,
              payload: message.payload ?? {},
              source: message.source ?? null,
              nativeSessionId: message.nativeSessionId ?? null,
              nativeMessageId: message.nativeMessageId ?? null,
              updatedAt: sql`now()`,
            },
          });
        await tx
          .update(fastAgentConversations)
          .set({ updatedAt: sql`now()` })
          .where(eq(fastAgentConversations.id, conversationId));
        const session = await getSessionForFastConversation(tx, conversationId);
        if (session) {
          await touchSessionActivity(
            tx,
            session.id,
            Math.floor(message.ts / 1000),
            {
              recomputeStatus: false,
              // An assistant message means the agent is still producing
              // output; re-extend the responding lease so long turns do not
              // expire it mid-stream.
              ...(message.role === 'assistant'
                ? {
                    respondingUntil: new Date(
                      Date.now() + FAST_RESPONDING_LEASE_MS,
                    ),
                  }
                : {}),
            },
          );
          const messageUserId = message.metadata?.userId;
          if (message.role === 'user' && typeof messageUserId === 'string') {
            await advanceSessionReadCursor(tx, {
              sessionId: session.id,
              userId: messageUserId,
              eventAt: message.ts,
              eventId: message.eventId,
            });
          } else if (message.role === 'assistant') {
            await advanceSessionNotifiedCursor(tx, {
              sessionId: session.id,
              eventAt: message.ts,
              eventId: message.eventId,
            });
          }
        }

        return { initialHumanTurn };
      });
    },

    async setOpenCodeSession({
      conversationId: requestedId,
      openCodeSessionId,
    }) {
      await db.transaction(async (tx) => {
        const conversationId = await resolveCanonicalId(tx, requestedId);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`fast-agent-conversation:${conversationId}`}, 0))`,
        );
        const [updated] = await tx
          .update(fastAgentConversations)
          .set({
            openCodeSessionId,
            updatedAt: sql`now()`,
          })
          .where(eq(fastAgentConversations.id, conversationId))
          .returning({ id: fastAgentConversations.id });
        if (!updated) throw new Error('Fast conversation was not found.');
      });
    },
  };
