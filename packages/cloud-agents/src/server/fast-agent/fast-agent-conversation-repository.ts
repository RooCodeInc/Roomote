import type { ModelMessage } from 'ai';
import {
  and,
  type CreateFastAgentMessage,
  type FastAgentInitialTurn,
  db,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  ensureSessionForFastConversation,
  advanceSessionNotifiedCursor,
  advanceSessionReadCursor,
  getSessionForFastConversation,
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
    initialTurnPending: boolean;
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

  const notices = await database
    .select({
      id: fastAgentMessages.id,
      metadata: fastAgentMessages.metadata,
      payload: fastAgentMessages.payload,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, conversationId),
        activeInferenceRetryNoticeWhere(),
      ),
    );

  for (const notice of notices) {
    await database
      .update(fastAgentMessages)
      .set({
        contentBlocks: [
          { type: 'text', text: INTERRUPTED_INFERENCE_RETRY_MESSAGE },
        ],
        metadata: {
          ...(notice.metadata ?? {}),
          visibleInTranscript: true,
          purpose: 'closeout',
          inferenceRetryNotice: true,
          inferenceRetryActive: false,
        },
        payload: { ...notice.payload, purpose: 'closeout' },
        updatedAt: new Date(),
      })
      .where(eq(fastAgentMessages.id, notice.id));
  }

  return notices.length;
}

export async function reconcileFastAgentInferenceRetryNotices(
  conversationId: string,
): Promise<number> {
  return db.transaction((tx) =>
    reconcileInferenceRetryNotices(tx, conversationId, false),
  );
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
      ),
    )
    .limit(limit);

  let reconciled = 0;
  for (const candidate of candidates) {
    // The per-conversation lock and lease recheck prevent a renewed active
    // turn from being reconciled after the candidate scan races with it.
    reconciled += await db.transaction((tx) =>
      reconcileInferenceRetryNotices(tx, candidate.conversationId, true),
    );
  }
  return reconciled;
}

export interface FastAgentConversationRepository {
  getOrCreate(input: {
    userId: string;
    conversation: FastAgentConversation;
    initialTurn?: FastAgentInitialTurn;
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
    async getOrCreate({ userId, conversation, initialTurn }) {
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
              initialTurn,
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
            ...(initialTurn
              ? {
                  initialTurn: sql`coalesce(${fastAgentConversations.initialTurn}, ${JSON.stringify(initialTurn)}::jsonb)`,
                }
              : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(fastAgentConversations.id, record.id))
          .returning();

        await ensureSessionForFastConversation(tx, updated?.id ?? record.id);

        return {
          ...(await loadConversationRecord(tx, updated?.id ?? record.id)),
          created,
          initialTurnPending: Boolean(
            (updated ?? record).initialTurn &&
            !(updated ?? record).initialTurnCompletedAt,
          ),
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
