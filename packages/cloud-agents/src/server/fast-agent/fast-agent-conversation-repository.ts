import type { ModelMessage } from 'ai';
import { captureFastAgentPeerDiscussion } from './fast-agent-peer-discussion';
import {
  and,
  type CreateFastAgentMessage,
  db,
  desc,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  fastAgentParentEvents,
  ensureAutomationRowsOnce,
  ensureSessionForFastConversation,
  advanceSessionNotifiedCursor,
  attachFastConversationToSession,
  advanceSessionReadCursor,
  getSessionForFastConversation,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sessions,
  sql,
  touchSessionActivity,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  fastAgentConversationSchema,
  type FastAgentConversationOwner,
  type ReasoningEffort,
} from '@roomote/types';

import { FAST_RESPONDING_LEASE_MS } from './fast-agent-constants';
import {
  FAST_AGENT_REACTION_INPUT_TYPE,
  type FastAgentConversation,
} from './fast-agent-conversation';
import type { ModelRequestMessage } from './fast-agent-model-authorization';

export type FastAgentConversationRecord = {
  id: string;
  userId: string | null;
  owner: FastAgentConversationOwner;
  privacy?: 'shared' | 'private';
  privateOwnerUserId?: string | null;
  title: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
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
  /** True only for the transaction that created this canonical event row. */
  inserted?: boolean;
};

export const INTERRUPTED_INFERENCE_RETRY_MESSAGE =
  'The inference retry was interrupted before it completed. Please send the request again.';

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
  options: { excludeEventId?: string } = {},
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

  // An active notice whose turn still has a pending durable row is not
  // orphaned: that turn is parked for a retry, waiting for the queue, or
  // running elsewhere, and its resumed run edits the notice into the answer.
  // Stamping it as interrupted here would post a false interruption and
  // leave the eventual answer beside it. The caller's own row (a new turn
  // that has not superseded the older one, such as a reaction) is excluded.
  //
  // The expired-lease sweep is the backstop for a hand-off whose queue
  // wakeup never runs, so there only a live claim or a scheduled retry
  // counts as owned; a released or expired row must not block it forever.
  const now = new Date();
  const [pendingTurn] = await database
    .select({ id: fastAgentParentEvents.id })
    .from(fastAgentParentEvents)
    .where(
      and(
        eq(fastAgentParentEvents.conversationId, conversationId),
        eq(fastAgentParentEvents.admission, 'inline'),
        isNull(fastAgentParentEvents.deliveredAt),
        isNull(fastAgentParentEvents.discardedAt),
        ...(options.excludeEventId
          ? [ne(fastAgentParentEvents.id, options.excludeEventId)]
          : []),
        ...(requireExpiredLease
          ? [
              or(
                gt(fastAgentParentEvents.claimedUntil, now),
                gt(fastAgentParentEvents.retryAt, now),
              ),
            ]
          : []),
      ),
    )
    .limit(1);
  if (pendingTurn) {
    return 0;
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
  options: {
    /** The calling turn's own durable row, which must not count as a pending
     * turn that owns the notices. */
    excludeEventId?: string;
  } = {},
): Promise<number> {
  return db.transaction((tx) =>
    reconcileInferenceRetryNotices(tx, conversationId, false, reason, options),
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
  kind: 'action';
  tool: string;
  arguments: unknown;
  /** 'unknown' when the call was recorded but the process died before its result. */
  status: 'completed' | 'failed' | 'unknown';
  result?: string;
};

export type FastAgentTurnAttemptReplyPurpose =
  | 'ack'
  | 'progress'
  | 'closeout'
  | 'clarification';

export type FastAgentTurnAttemptReply = {
  kind: 'reply';
  /** A visible assistant reply the attempt already posted. */
  text: string;
  /** Recorded for replies the turn posted itself; absent on older rows. */
  purpose?: FastAgentTurnAttemptReplyPurpose;
  /** System retry notices are visible but do not acknowledge model work. */
  inferenceRetryNotice?: boolean;
};

function isFastAgentTurnAttemptReplyPurpose(
  value: unknown,
): value is FastAgentTurnAttemptReplyPurpose {
  return (
    value === 'ack' ||
    value === 'progress' ||
    value === 'closeout' ||
    value === 'clarification'
  );
}

export type FastAgentTurnAttemptEvent =
  | FastAgentTurnAttemptReply
  | FastAgentTurnAttemptAction;

export type FastAgentTurnAttemptSummary = {
  /** Everything the attempt did, in transcript order, up to where it was cut. */
  events: FastAgentTurnAttemptEvent[];
  /**
   * Where the resumed run must continue numbering its canonical events so
   * its rows extend the transcript instead of overwriting the attempt's.
   */
  next: {
    assistantOrdinal: number;
    toolOrdinal: number;
    retryNoticeOrdinal: number;
    turnSeq: number;
  };
  /** The attempt's prompt row, so the resumed run keeps its place and time. */
  prompt: { ts: number; turnSeq: number } | null;
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
      eventId: fastAgentMessages.eventId,
      turnSeq: fastAgentMessages.turnSeq,
      ts: fastAgentMessages.ts,
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

  const events: FastAgentTurnAttemptEvent[] = [];
  // A call and its result share one canonical event, so normally only one row
  // per call survives; when both are present the later row wins in place.
  const actionIndexByCallId = new Map<string, number>();
  const next = {
    assistantOrdinal: 0,
    toolOrdinal: 0,
    retryNoticeOrdinal: 0,
    turnSeq: 0,
  };
  let prompt: FastAgentTurnAttemptSummary['prompt'] = null;
  const ordinalOf = (slot: string, eventId: string) => {
    const match = new RegExp(`:${slot}:(\\d+)$`, 'u').exec(eventId);
    return match ? Number(match[1]) + 1 : 0;
  };
  for (const row of rows) {
    if (
      row.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt &&
      row.eventId === `${turnId}:user`
    ) {
      prompt = { ts: Number(row.ts), turnSeq: row.turnSeq };
    }
    next.turnSeq = Math.max(next.turnSeq, row.turnSeq + 1);
    next.assistantOrdinal = Math.max(
      next.assistantOrdinal,
      ordinalOf('assistant', row.eventId),
    );
    next.toolOrdinal = Math.max(
      next.toolOrdinal,
      ordinalOf('tool', row.eventId),
    );
    next.retryNoticeOrdinal = Math.max(
      next.retryNoticeOrdinal,
      ordinalOf('retry-notice', row.eventId),
    );
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
      // Native and MCP calls wrap their input as `rawInput.arguments`;
      // subagent task calls persist the input object directly.
      const rawInput = payload.rawInput as
        | { arguments?: unknown }
        | Record<string, unknown>
        | undefined;
      const action: FastAgentTurnAttemptAction = {
        kind: 'action',
        tool: String(payload.toolName ?? payload.title ?? 'tool'),
        arguments:
          rawInput && typeof rawInput === 'object'
            ? 'arguments' in rawInput
              ? rawInput.arguments
              : rawInput
            : null,
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
      const index = actionIndexByCallId.get(toolCallId);
      if (index === undefined) {
        actionIndexByCallId.set(toolCallId, events.length);
        events.push(action);
      } else {
        events[index] = action;
      }
    } else if (
      row.role === 'assistant' &&
      row.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage &&
      metadata.visibleInTranscript !== false &&
      metadata.interruptionReason === undefined
    ) {
      const reply = text(row.contentBlocks).trim();
      if (!reply) continue;
      const purpose = payload.purpose ?? metadata.purpose;
      events.push({
        kind: 'reply',
        text: reply,
        ...(isFastAgentTurnAttemptReplyPurpose(purpose) ? { purpose } : {}),
        ...(metadata.inferenceRetryNotice === true
          ? { inferenceRetryNotice: true }
          : {}),
      });
    }
  }
  return { events, next, prompt };
}

export type FastAgentUnresolvedRequest = {
  /** Turn whose human request never received a completed answer. */
  turnId: string;
  text: string;
  reason: string;
};

const UNRESOLVED_REQUEST_CHAIN_LIMIT = 8;
const FAST_AGENT_TOOL_APPROVAL_HISTORY_LIMIT = 80;
// The agent's last few visible replies are enough to see what it proposed.
const FAST_AGENT_REPLIED_TO_MESSAGE_LIMIT = 3;

/**
 * Read the human-authored prompts that were already in the Session before its
 * current UserPrompt. The N-1 `compatibility_messages` mirror intentionally
 * omits event metadata, so `fast_agent_messages` is the trust source for
 * distinguishing human requests from platform events and other transcript
 * content.
 *
 * Timestamps are milliseconds and there is no causal cursor across turns, so
 * the current prompt is excluded by its event id, and prompts sharing a
 * timestamp are returned as one entry. Callers that take the newest entry as
 * the request then see every prompt that could be the latest one.
 */
export async function listRecentFastAgentHumanUserPromptTexts(input: {
  conversationId: string;
  beforeTs: number;
  currentEventId: string;
}): Promise<string[]> {
  const rows = await db
    .select({
      ts: fastAgentMessages.ts,
      contentBlocks: fastAgentMessages.contentBlocks,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, input.conversationId),
        lte(fastAgentMessages.ts, input.beforeTs),
        ne(fastAgentMessages.eventId, input.currentEventId),
        eq(fastAgentMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
        eq(fastAgentMessages.role, 'user'),
        sql`${fastAgentMessages.metadata}->>'turnSource' = 'human'`,
        sql`coalesce(${fastAgentMessages.metadata}->>'inputKind', 'message') <> ${FAST_AGENT_REACTION_INPUT_TYPE}`,
        sql`coalesce(${fastAgentMessages.metadata}->>'visibleInTranscript', 'true') <> 'false'`,
      ),
    )
    // Order within a shared timestamp only affects how a grouped entry reads.
    .orderBy(
      desc(fastAgentMessages.ts),
      desc(fastAgentMessages.createdAt),
      desc(fastAgentMessages.turnSeq),
      desc(fastAgentMessages.id),
    )
    .limit(FAST_AGENT_TOOL_APPROVAL_HISTORY_LIMIT);

  const groups: Array<{ ts: number; texts: string[] }> = [];
  for (const row of rows.reverse()) {
    const text = row.contentBlocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
      .trim();
    if (!text) continue;
    const last = groups.at(-1);
    if (last?.ts === row.ts) {
      last.texts.push(text);
    } else {
      groups.push({ ts: row.ts, texts: [text] });
    }
  }
  return groups.map((group) => group.texts.join('\n\n'));
}

/** Model consent reads typed canonical events, never compatibility envelopes. */
export async function persistFastAgentModelAuthorizationSnapshot(
  conversationId: string,
  turnId: string,
  messages: readonly ModelRequestMessage[],
): Promise<void> {
  const snapshot = JSON.stringify({ version: 1, messages });
  const rows = await db
    .update(fastAgentMessages)
    .set({
      metadata: sql`coalesce(${fastAgentMessages.metadata}, '{}'::jsonb) || jsonb_build_object('modelAuthorizationSnapshot', ${snapshot}::jsonb)`,
    })
    .where(
      and(
        eq(fastAgentMessages.conversationId, conversationId),
        eq(fastAgentMessages.eventId, `${turnId}:user`),
        eq(fastAgentMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
        eq(fastAgentMessages.role, 'user'),
      ),
    )
    .returning({ id: fastAgentMessages.id });
  if (rows.length !== 1)
    throw new Error('Model authorization prompt anchor unavailable');
}

export async function loadFastAgentModelAuthorizationSnapshot(
  conversationId: string,
  turnId: string,
): Promise<ModelRequestMessage[] | null> {
  const [row] = await db
    .select({ metadata: fastAgentMessages.metadata })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, conversationId),
        eq(fastAgentMessages.eventId, `${turnId}:user`),
        eq(fastAgentMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
        eq(fastAgentMessages.role, 'user'),
      ),
    )
    .limit(1);
  const snapshot = row?.metadata?.modelAuthorizationSnapshot as
    | { version?: unknown; messages?: unknown }
    | undefined;
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.messages)) return null;
  if (
    !snapshot.messages.every(
      (message) =>
        message &&
        typeof message === 'object' &&
        ['user', 'assistant', 'tool', 'untrusted'].includes(message.role) &&
        typeof message.text === 'string',
    )
  )
    return null;
  return snapshot.messages as ModelRequestMessage[];
}

export async function listFastAgentModelRequestDialogue(input: {
  conversationId: string;
  beforeTs: number;
  currentEventId: string;
  currentTurnId: string;
  requireAnchor?: boolean;
}): Promise<ModelRequestMessage[]> {
  const [anchor] = await db
    .select({ createdAt: fastAgentMessages.createdAt })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, input.conversationId),
        eq(fastAgentMessages.eventId, input.currentEventId),
      ),
    )
    .limit(1);
  if (input.requireAnchor && !anchor) return [];
  const rows = await db
    .select({
      role: fastAgentMessages.role,
      eventType: fastAgentMessages.eventType,
      metadata: fastAgentMessages.metadata,
      contentBlocks: fastAgentMessages.contentBlocks,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, input.conversationId),
        lte(fastAgentMessages.ts, input.beforeTs),
        ne(fastAgentMessages.eventId, input.currentEventId),
        // Compare in Postgres without truncating timestamp precision to JS Date.
        anchor
          ? sql`${fastAgentMessages.createdAt} < (
        select created_at from fast_agent_messages
        where conversation_id = ${input.conversationId} and event_id = ${input.currentEventId}
        limit 1
      )`
          : undefined,
        sql`coalesce(${fastAgentMessages.metadata}->>'visibleInTranscript', 'true') <> 'false'`,
        or(
          eq(fastAgentMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.ToolResult),
          eq(fastAgentMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
          and(
            eq(
              fastAgentMessages.eventType,
              ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
            ),
            eq(fastAgentMessages.role, 'assistant'),
            sql`${fastAgentMessages.turnId} is distinct from ${input.currentTurnId}`,
            sql`coalesce(${fastAgentMessages.metadata}->>'inferenceRetryNotice', 'false') <> 'true'`,
          ),
        ),
      ),
    )
    .orderBy(
      desc(fastAgentMessages.ts),
      desc(fastAgentMessages.createdAt),
      desc(fastAgentMessages.turnSeq),
    )
    .limit(20);
  return rows.reverse().map((row) => ({
    role:
      row.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolResult
        ? 'tool'
        : row.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt
          ? row.role === 'user' &&
            row.metadata?.turnSource === 'human' &&
            row.metadata?.inputKind !== FAST_AGENT_REACTION_INPUT_TYPE
            ? 'user'
            : 'untrusted'
          : 'assistant',
    text: row.contentBlocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n'),
  }));
}

/**
 * What the agent said to the owner between their previous message and the
 * current one: its visible replies, oldest first. Auto reads it to learn what
 * a short answer such as "yes, go ahead" agreed to. Retry notices and hidden
 * rows are skipped.
 */
export async function findFastAgentRepliesBeforeHumanPrompt(input: {
  conversationId: string;
  beforeTs: number;
  currentEventId: string;
  /** Recover only the final proposal before a replayed human instruction. */
  modelProposalTurnId?: string;
}): Promise<string | undefined> {
  const [previousPrompt] = await db
    .select({ ts: fastAgentMessages.ts })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, input.conversationId),
        input.modelProposalTurnId
          ? lte(fastAgentMessages.ts, input.beforeTs)
          : lt(fastAgentMessages.ts, input.beforeTs),
        ne(fastAgentMessages.eventId, input.currentEventId),
        eq(fastAgentMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
        eq(fastAgentMessages.role, 'user'),
        sql`${fastAgentMessages.metadata}->>'turnSource' = 'human'`,
      ),
    )
    .orderBy(desc(fastAgentMessages.ts))
    .limit(1);
  const rows = await db
    .select({ contentBlocks: fastAgentMessages.contentBlocks })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, input.conversationId),
        gt(fastAgentMessages.ts, previousPrompt?.ts ?? 0),
        lte(fastAgentMessages.ts, input.beforeTs),
        eq(
          fastAgentMessages.eventType,
          ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        ),
        eq(fastAgentMessages.role, 'assistant'),
        input.modelProposalTurnId
          ? sql`${fastAgentMessages.turnId} is distinct from ${input.modelProposalTurnId}`
          : undefined,
        sql`coalesce(${fastAgentMessages.metadata}->>'visibleInTranscript', 'true') <> 'false'`,
        sql`coalesce(${fastAgentMessages.metadata}->>'inferenceRetryNotice', 'false') <> 'true'`,
      ),
    )
    .orderBy(desc(fastAgentMessages.ts), desc(fastAgentMessages.turnSeq))
    .limit(input.modelProposalTurnId ? 1 : FAST_AGENT_REPLIED_TO_MESSAGE_LIMIT);
  const text = rows
    .reverse()
    .map((row) =>
      row.contentBlocks
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
        .trim(),
    )
    .filter(Boolean)
    .join('\n\n');
  return text || undefined;
}

const FAST_AGENT_RECENT_TOOL_RESULT_LIMIT = 30;
const FAST_AGENT_RECENT_TOOL_RESULT_OUTPUT_LENGTH = 8_000;
const FAST_AGENT_RECENT_TOOL_RESULT_ARGUMENTS_LENGTH = 2_000;

/**
 * Results of the integration tools the agent ran most recently in this
 * conversation, oldest first and across turns. Auto reads them to tell what
 * an identifier in a paused call refers to (a listing that maps ids to
 * names): it checks an identifier against all of them and shows the model
 * the newest few. Unfinished calls and Roomote's own tools are skipped.
 * Each output is cut to its head in the query, and oversized arguments are
 * left out, so one call never loads more than a bounded amount of text.
 */
export async function findRecentFastAgentToolResults(input: {
  conversationId: string;
}): Promise<Array<{ tool: string; arguments?: unknown; output: string }>> {
  const payload = fastAgentMessages.payload;
  const rows = await db
    .select({
      toolName: sql<
        string | null
      >`coalesce(${payload}->>'mcpToolName', ${payload}->>'toolName')`,
      serverName: sql<
        string | null
      >`coalesce(${payload}->>'mcpServerName', ${payload}->>'serverName')`,
      arguments: sql<unknown>`case when length((${payload}->'rawInput'->'arguments')::text) <= ${FAST_AGENT_RECENT_TOOL_RESULT_ARGUMENTS_LENGTH} then ${payload}->'rawInput'->'arguments' end`,
      output: sql<
        string | null
      >`left(${payload}->>'output', ${FAST_AGENT_RECENT_TOOL_RESULT_OUTPUT_LENGTH})`,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, input.conversationId),
        eq(fastAgentMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.ToolResult),
        sql`${payload}->>'status' = 'completed'`,
        sql`${payload}->>'isMcp' = 'true'`,
        sql`coalesce(${payload}->>'isRoomoteNativeTool', 'false') <> 'true'`,
      ),
    )
    .orderBy(desc(fastAgentMessages.ts), desc(fastAgentMessages.turnSeq))
    .limit(FAST_AGENT_RECENT_TOOL_RESULT_LIMIT);
  return rows.reverse().flatMap((row) => {
    if (!row.toolName || !row.output?.trim()) return [];
    return [
      {
        tool: row.serverName
          ? `${row.serverName}.${row.toolName}`
          : row.toolName,
        ...(row.arguments === null || row.arguments === undefined
          ? {}
          : { arguments: row.arguments }),
        output: row.output,
      },
    ];
  });
}

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

/**
 * How long a native steer holds the queued follow-ups it is delivering
 * before the queue may take them back. A live steer delivers or releases its
 * claim within one dispatch, so this only bounds how long a crashed owner
 * delays the queue's whole-turn fallback.
 */
const FAST_AGENT_HUMAN_STEER_CLAIM_MS = 2 * 60 * 1000;

/**
 * Claim queued human follow-ups for one native steer, returning the ids the
 * steer may deliver. A row withdrawn or settled since the lookup is left out,
 * and until the claim is released a withdrawal no longer succeeds, so a
 * withdrawn follow-up is never delivered and a delivered one is never
 * reported as withdrawn.
 */
export async function claimFastAgentHumanFollowUpSteers(
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const now = new Date();
  const rows = await db
    .update(fastAgentParentEvents)
    .set({
      claimedUntil: new Date(Date.now() + FAST_AGENT_HUMAN_STEER_CLAIM_MS),
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(fastAgentParentEvents.id, ids),
        isNull(fastAgentParentEvents.admission),
        isNull(fastAgentParentEvents.deliveredAt),
        isNull(fastAgentParentEvents.discardedAt),
        // Re-check ownership atomically after selection. A Send now
        // reservation or another native steer may have claimed the row.
        or(
          isNull(fastAgentParentEvents.claimedUntil),
          lt(fastAgentParentEvents.claimedUntil, now),
        ),
      ),
    )
    .returning({ id: fastAgentParentEvents.id });
  return new Set(rows.map((row) => row.id));
}

/**
 * Return steer claims whose follow-ups were not delivered, so the queue's
 * whole-turn fallback picks them up without waiting out the lease.
 */
export async function releaseFastAgentHumanFollowUpSteerClaims(
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(fastAgentParentEvents)
    .set({ claimedUntil: null, updatedAt: new Date() })
    .where(
      and(
        inArray(fastAgentParentEvents.id, ids),
        isNull(fastAgentParentEvents.admission),
        isNull(fastAgentParentEvents.deliveredAt),
      ),
    );
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
    owner?: FastAgentConversationOwner;
    userId?: string;
    conversation: FastAgentConversation;
    /**
     * Session to bind a newly created conversation to, when that Session has
     * no conversation yet. A conversation that already exists keeps its own
     * Session.
     */
    sessionId?: string;
    /** Title to seed only when this call creates the conversation. */
    initialTitle?: string;
    /** Creation value or explicit assertion; omission preserves an existing mode. */
    privacy?: 'shared' | 'private';
    initialModel?: string;
    initialReasoningEffort?: ReasoningEffort;
  }): Promise<FastAgentConversationGetOrCreateResult>;
  findById(input: {
    id: string;
    fallbackConversation?: FastAgentConversation;
  }): Promise<FastAgentConversationRecord | null>;
  findByConversation(
    conversation: FastAgentConversation,
  ): Promise<FastAgentConversationRecord | null>;
  getLookupIds(id: string): Promise<string[]>;
  exists(conversation: FastAgentConversation): Promise<boolean>;
  appendVisibleMessages(input: {
    conversationId: string;
    messages: ModelMessage[];
  }): Promise<void>;
  upsertMessage(input: {
    conversationId: string;
    message: FastAgentMessageWrite;
    insertOnly?: boolean;
  }): Promise<FastAgentMessageUpsertResult>;
  /** `null` forgets the native session so the next turn rebuilds it. */
  setOpenCodeSession(input: {
    conversationId: string;
    openCodeSessionId: string | null;
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
  const owner: FastAgentConversationOwner = record.userId
    ? { kind: 'user', userId: record.userId }
    : record.ownerAutomation
      ? { kind: 'automation', automationKey: record.ownerAutomation }
      : (() => {
          throw new Error('Fast conversation has an invalid owner.');
        })();

  return {
    id: record.id,
    userId: record.userId,
    owner,
    privacy: record.privacy,
    privateOwnerUserId: record.privateOwnerUserId,
    title: record.title,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    conversation,
    compatibilityMessages: record.compatibilityMessages as ModelMessage[],
    openCodeSessionId: record.openCodeSessionId,
  };
}

export const fastAgentConversationRepository: FastAgentConversationRepository =
  {
    async getOrCreate({
      owner,
      userId,
      conversation,
      sessionId,
      initialTitle,
      privacy,
      initialModel,
      initialReasoningEffort,
    }) {
      const resolvedOwner =
        owner ?? (userId ? { kind: 'user' as const, userId } : null);
      if (!resolvedOwner) {
        throw new Error('Fast conversation owner is required.');
      }
      if (
        privacy === 'private' &&
        (resolvedOwner.kind !== 'user' || conversation.surface !== 'web')
      ) {
        throw new Error(
          'Private sessions require a user-owned web conversation.',
        );
      }
      if (resolvedOwner.kind === 'automation') {
        await ensureAutomationRowsOnce();
      }
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
            .select({
              fastConversationId: sessions.fastConversationId,
              privacy: sessions.privacy,
              privateOwnerUserId: sessions.privateOwnerUserId,
            })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .limit(1);
          const requestedPrivateOwner =
            privacy === 'private' && resolvedOwner.kind === 'user'
              ? resolvedOwner.userId
              : null;
          if (
            bound &&
            privacy !== undefined &&
            (bound.privacy !== privacy ||
              bound.privateOwnerUserId !== requestedPrivateOwner)
          ) {
            throw new Error('Session privacy does not match the conversation.');
          }
          if (
            bound?.privacy === 'private' &&
            (resolvedOwner.kind !== 'user' ||
              bound.privateOwnerUserId !== resolvedOwner.userId)
          ) {
            throw new Error(
              'Fast conversation private owner does not match the caller.',
            );
          }
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
              userId:
                resolvedOwner.kind === 'user' ? resolvedOwner.userId : null,
              ownerAutomation:
                resolvedOwner.kind === 'automation'
                  ? resolvedOwner.automationKey
                  : null,
              privacy: privacy ?? 'shared',
              privateOwnerUserId:
                privacy === 'private' && resolvedOwner.kind === 'user'
                  ? resolvedOwner.userId
                  : null,
              title: initialTitle?.trim() || null,
              model: initialModel,
              reasoningEffort: initialReasoningEffort,
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
        if (privacy !== undefined && record.privacy !== privacy) {
          throw new Error(
            'Fast conversation privacy does not match the caller.',
          );
        }
        if (
          record.privacy === 'private' &&
          (resolvedOwner.kind !== 'user' ||
            record.privateOwnerUserId !== resolvedOwner.userId)
        ) {
          throw new Error(
            'Fast conversation private owner does not match the caller.',
          );
        }
        // Only an explicit owner asserts who the conversation belongs to. A
        // bare userId is the acting sender: it becomes the owner when this
        // call creates the conversation, and otherwise it is a participant
        // taking a turn in someone else's thread (a coworker replying in a
        // bound Slack thread, a human replying to an automation-owned
        // Session), which must not be rejected.
        if (
          owner &&
          ((owner.kind === 'user' &&
            (record.userId !== owner.userId ||
              record.ownerAutomation !== null)) ||
            (owner.kind === 'automation' &&
              (record.userId !== null ||
                record.ownerAutomation !== owner.automationKey)))
        ) {
          throw new Error('Fast conversation owner does not match the caller.');
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

    async findByConversation(conversation) {
      const exact = await db.query.fastAgentConversations.findFirst({
        where: buildIdentityWhere(conversation),
        columns: { id: true },
      });
      if (exact) {
        return loadConversationRecord(db, exact.id);
      }

      const replyTargetWhere = buildReplyTargetWhere(conversation);
      if (!replyTargetWhere) {
        return null;
      }

      const routed = await db.query.fastAgentConversations.findFirst({
        where: replyTargetWhere,
        columns: { id: true },
      });
      return routed ? loadConversationRecord(db, routed.id) : null;
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
      return Boolean(await this.findByConversation(conversation));
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

    async upsertMessage({ conversationId: requestedId, message, insertOnly }) {
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

        const [existingEvent] = await tx
          .select({ id: fastAgentMessages.id })
          .from(fastAgentMessages)
          .where(
            and(
              eq(fastAgentMessages.conversationId, conversationId),
              eq(fastAgentMessages.eventId, message.eventId),
            ),
          )
          .limit(1);

        const isSubstantiveHumanPrompt =
          message.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt &&
          message.role === 'user' &&
          message.metadata?.turnSource === 'human' &&
          message.metadata?.inputKind !== FAST_AGENT_REACTION_INPUT_TYPE;
        let initialHumanTurn = false;
        if (
          existingEvent &&
          insertOnly &&
          message.eventType === ACP_ENVELOPE_EVENT_TYPES.PeerMessage
        ) {
          return { initialHumanTurn: false, inserted: false };
        }
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

        const metadata = message.metadata ? { ...message.metadata } : null;
        if (metadata) delete metadata.modelAuthorizationSnapshot;
        const payload = { ...message.payload };
        if (
          !existingEvent &&
          isSubstantiveHumanPrompt &&
          message.source === 'web'
        ) {
          payload.peerDiscussionContext =
            (await captureFastAgentPeerDiscussion(tx, conversationId)) ?? null;
        }
        const insert = tx
          .insert(fastAgentMessages)
          .values({ conversationId, ...message, metadata, payload });
        if (insertOnly) {
          await insert.onConflictDoNothing({
            target: [
              fastAgentMessages.conversationId,
              fastAgentMessages.eventId,
            ],
          });
        } else {
          await insert.onConflictDoUpdate({
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
              // The cache belongs to its dedicated writer. A replay upsert
              // must preserve the newest stored value atomically, not reload
              // and overwrite it with a possibly stale in-memory snapshot.
              metadata: sql`case when ${fastAgentMessages.metadata} ? 'modelAuthorizationSnapshot'
                then coalesce(${metadata ? JSON.stringify(metadata) : null}::jsonb, '{}'::jsonb) || jsonb_build_object('modelAuthorizationSnapshot', ${fastAgentMessages.metadata}->'modelAuthorizationSnapshot')
                else ${metadata ? JSON.stringify(metadata) : null}::jsonb end`,
              payload: sql`case when ${fastAgentMessages.payload} ? 'peerDiscussionContext'
                then ${JSON.stringify(payload)}::jsonb || jsonb_build_object('peerDiscussionContext', ${fastAgentMessages.payload}->'peerDiscussionContext')
                else ${JSON.stringify(payload)}::jsonb end`,
              source: message.source ?? null,
              nativeSessionId: message.nativeSessionId ?? null,
              nativeMessageId: message.nativeMessageId ?? null,
              updatedAt: sql`now()`,
            },
          });
        }
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

        return { initialHumanTurn, inserted: !existingEvent };
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
