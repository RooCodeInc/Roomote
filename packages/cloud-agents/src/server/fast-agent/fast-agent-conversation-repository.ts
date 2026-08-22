import type { ModelMessage } from 'ai';
import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  db,
  eq,
  fastAgentConversationAliases,
  fastAgentConversations,
  slackQuickAnswers,
  sql,
  type DatabaseOrTransaction,
  type DatabaseTransaction,
} from '@roomote/db/server';
import { fastAgentConversationSchema } from '@roomote/types';

import {
  getFastAgentConversationStorageWorkspaceId,
  type FastAgentConversation,
} from './fast-agent-conversation';

export type FastAgentConversationRecord = {
  id: string;
  userId: string;
  conversation: FastAgentConversation;
  /**
   * Visible N-1 compatibility history. OpenCode, not this field, owns the
   * live warm transcript; this is only a cold-start fallback while the old
   * application release must remain rollback-compatible.
   */
  compatibilityMessages: ModelMessage[];
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

function buildLegacyChannelKey(conversation: FastAgentConversation): string {
  return `${getFastAgentConversationStorageWorkspaceId(conversation)}:${conversation.replyTarget.channelId}`;
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

async function findLegacyByCoordinates(
  database: DatabaseOrTransaction,
  conversation: FastAgentConversation,
) {
  return database.query.slackQuickAnswers.findFirst({
    where: and(
      eq(slackQuickAnswers.slackChannel, buildLegacyChannelKey(conversation)),
      eq(slackQuickAnswers.slackThreadTs, conversation.conversationId),
    ),
  });
}

async function resolveCanonicalId(
  database: DatabaseOrTransaction,
  requestedId: string,
): Promise<string> {
  const alias = await database.query.fastAgentConversationAliases.findFirst({
    where: eq(fastAgentConversationAliases.legacyConversationId, requestedId),
    columns: { conversationId: true },
  });

  return alias?.conversationId ?? requestedId;
}

async function loadCompatibilityMessages(
  database: DatabaseOrTransaction,
  conversationId: string,
  conversation: FastAgentConversation,
): Promise<ModelMessage[]> {
  const currentLegacy = await findLegacyByCoordinates(database, conversation);
  if (currentLegacy) {
    return currentLegacy.messages as ModelMessage[];
  }

  const [fallbackLegacy] = await database
    .select({ messages: slackQuickAnswers.messages })
    .from(fastAgentConversationAliases)
    .innerJoin(
      slackQuickAnswers,
      eq(
        slackQuickAnswers.id,
        fastAgentConversationAliases.legacyConversationId,
      ),
    )
    .where(eq(fastAgentConversationAliases.conversationId, conversationId))
    .orderBy(asc(fastAgentConversationAliases.createdAt))
    .limit(1);

  return (fallbackLegacy?.messages ?? []) as ModelMessage[];
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
    compatibilityMessages: await loadCompatibilityMessages(
      database,
      record.id,
      conversation,
    ),
  };
}

async function ensureLegacyAlias(
  tx: DatabaseTransaction,
  record: typeof fastAgentConversations.$inferSelect,
  conversation: FastAgentConversation,
) {
  const canonicalLegacy = await tx.query.slackQuickAnswers.findFirst({
    where: eq(slackQuickAnswers.id, record.id),
  });
  if (canonicalLegacy) {
    await tx
      .insert(fastAgentConversationAliases)
      .values({
        legacyConversationId: canonicalLegacy.id,
        conversationId: record.id,
      })
      .onConflictDoNothing();
  }

  let legacy = await findLegacyByCoordinates(tx, conversation);

  if (!legacy) {
    const compatibilityMessages = await loadCompatibilityMessages(
      tx,
      record.id,
      conversation,
    );
    const [created] = await tx
      .insert(slackQuickAnswers)
      .values({
        id: canonicalLegacy ? undefined : record.id,
        userId: record.userId,
        slackChannel: buildLegacyChannelKey(conversation),
        slackThreadTs: conversation.conversationId,
        messages: compatibilityMessages as Record<string, unknown>[],
      })
      .onConflictDoNothing({
        target: [
          slackQuickAnswers.slackChannel,
          slackQuickAnswers.slackThreadTs,
        ],
      })
      .returning();
    legacy =
      created ?? (await findLegacyByCoordinates(tx, conversation)) ?? undefined;
  }

  if (!legacy) {
    throw new Error('Failed to create or load legacy Fast conversation.');
  }

  await tx
    .insert(fastAgentConversationAliases)
    .values({
      legacyConversationId: legacy.id,
      conversationId: record.id,
    })
    .onConflictDoNothing();
  const alias = await tx.query.fastAgentConversationAliases.findFirst({
    where: eq(fastAgentConversationAliases.legacyConversationId, legacy.id),
  });
  if (!alias || alias.conversationId !== record.id) {
    throw new Error('Legacy Fast conversation alias points elsewhere.');
  }

  return legacy;
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
        const existingLegacy = await findLegacyByCoordinates(tx, conversation);

        if (!record) {
          const conversationId = existingLegacy?.id ?? randomUUID();
          await tx
            .insert(fastAgentConversations)
            .values({
              id: conversationId,
              userId: existingLegacy?.userId ?? userId,
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
        await ensureLegacyAlias(tx, record, conversation);
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
      let conversationId = await resolveCanonicalId(db, id);
      let record = await db.query.fastAgentConversations.findFirst({
        where: eq(fastAgentConversations.id, conversationId),
      });

      if (!record && fallbackConversation) {
        const legacy = await db.query.slackQuickAnswers.findFirst({
          where: eq(slackQuickAnswers.id, id),
        });
        if (legacy) {
          const migrated = await fastAgentConversationRepository.getOrCreate({
            userId: legacy.userId,
            conversation: fallbackConversation,
          });
          await db
            .insert(fastAgentConversationAliases)
            .values({
              legacyConversationId: legacy.id,
              conversationId: migrated.id,
            })
            .onConflictDoNothing();
          conversationId = migrated.id;
          record = await db.query.fastAgentConversations.findFirst({
            where: eq(fastAgentConversations.id, conversationId),
          });
        }
      }

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
      const aliases = await db.query.fastAgentConversationAliases.findMany({
        where: eq(fastAgentConversationAliases.conversationId, conversationId),
        columns: { legacyConversationId: true },
      });
      return [
        ...new Set([
          conversationId,
          ...aliases.map(({ legacyConversationId }) => legacyConversationId),
        ]),
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

      const legacy = await findLegacyByCoordinates(db, conversation);
      if (!legacy) {
        return false;
      }
      await fastAgentConversationRepository.getOrCreate({
        userId: legacy.userId,
        conversation,
      });
      return true;
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
        const aliases = await tx.query.fastAgentConversationAliases.findMany({
          where: eq(
            fastAgentConversationAliases.conversationId,
            conversationId,
          ),
          columns: { legacyConversationId: true },
        });
        const legacyIds = aliases
          .map(({ legacyConversationId }) => legacyConversationId)
          .sort();
        if (legacyIds.length === 0) {
          throw new Error('Fast conversation compatibility row is missing.');
        }

        for (const legacyId of legacyIds) {
          await tx
            .update(slackQuickAnswers)
            .set({
              messages: sql`${slackQuickAnswers.messages} || ${JSON.stringify(messages)}::jsonb`,
              updatedAt: sql`now()`,
            })
            .where(eq(slackQuickAnswers.id, legacyId));
        }
      });
    },
  };
