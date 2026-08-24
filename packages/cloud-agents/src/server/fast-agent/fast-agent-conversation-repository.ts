import type { ModelMessage } from 'ai';
import {
  and,
  db,
  eq,
  fastAgentConversations,
  sql,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import { fastAgentConversationSchema } from '@roomote/types';

import type { FastAgentConversation } from './fast-agent-conversation';

export type FastAgentConversationRecord = {
  id: string;
  userId: string;
  conversation: FastAgentConversation;
  /**
   * Durable visible history for the last-resort reconstruction path. OpenCode,
   * not this field, owns the native transcript.
   */
  compatibilityMessages: ModelMessage[];
  openCodeSessionId: string | null;
};

export interface FastAgentConversationRepository {
  getOrCreate(input: {
    userId: string;
    conversation: FastAgentConversation;
  }): Promise<FastAgentConversationRecord>;
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
  setOpenCodeSessionId(input: {
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
  >,
): FastAgentConversation | null {
  const parsed = fastAgentConversationSchema.safeParse({
    surface: record.surface,
    workspaceId: record.workspaceId,
    conversationId: record.conversationId,
    replyTarget: {
      channelId: record.currentReplyChannelId,
      ...(record.currentReplyThreadId
        ? { threadId: record.currentReplyThreadId }
        : {}),
    },
  });

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
    conversation,
    compatibilityMessages: record.compatibilityMessages as ModelMessage[],
    openCodeSessionId: record.openCodeSessionId,
  };
}

export const fastAgentConversationRepository: FastAgentConversationRepository =
  {
    async getOrCreate({ userId, conversation }) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${buildIdentityKey(conversation)}, 0))`,
        );

        let record = await tx.query.fastAgentConversations.findFirst({
          where: buildIdentityWhere(conversation),
        });

        if (!record) {
          await tx
            .insert(fastAgentConversations)
            .values({
              userId,
              surface: conversation.surface,
              workspaceId: conversation.workspaceId,
              conversationId: conversation.conversationId,
              currentReplyChannelId: conversation.replyTarget.channelId,
              currentReplyThreadId: conversation.replyTarget.threadId,
              replyTargetVerified: true,
            })
            .onConflictDoNothing();
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
            currentReplyChannelId: conversation.replyTarget.channelId,
            currentReplyThreadId: conversation.replyTarget.threadId ?? null,
            replyTargetVerified: true,
            updatedAt: sql`now()`,
          })
          .where(eq(fastAgentConversations.id, record.id))
          .returning();

        return loadConversationRecord(tx, updated?.id ?? record.id);
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
            currentReplyChannelId: fallbackConversation.replyTarget.channelId,
            currentReplyThreadId:
              fallbackConversation.replyTarget.threadId ?? null,
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
      const neutral = await db.query.fastAgentConversations.findFirst({
        where: buildIdentityWhere(conversation),
        columns: { id: true },
      });
      if (neutral) {
        return true;
      }
      return false;
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
      });
    },

    async setOpenCodeSessionId({
      conversationId: requestedId,
      openCodeSessionId,
    }) {
      const conversationId = await resolveCanonicalId(db, requestedId);
      const [updated] = await db
        .update(fastAgentConversations)
        .set({ openCodeSessionId, updatedAt: sql`now()` })
        .where(eq(fastAgentConversations.id, conversationId))
        .returning({ id: fastAgentConversations.id });
      if (!updated) {
        throw new Error('Fast conversation was not found.');
      }
    },
  };
