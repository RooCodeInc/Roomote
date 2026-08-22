import type { ModelMessage } from 'ai';
import {
  and,
  db,
  eq,
  fastAgentConversationAliases,
  fastAgentConversations,
  inArray,
  slackQuickAnswers,
  sql,
  userFactory,
  users,
} from '@roomote/db/server';

import { fastAgentConversationRepository } from '../fast-agent-conversation-repository';
import { hasFastAgentSession } from '../fast-agent-session';

const createdUserIds: string[] = [];

async function createUser() {
  const user = await userFactory.create();
  createdUserIds.push(user.id);
  return user;
}

const slackConversation = {
  surface: 'slack' as const,
  workspaceId: 'team-repository-test',
  conversationId: 'thread-repository-test',
  replyTarget: {
    channelId: 'channel-repository-test',
    threadId: 'thread-repository-test',
  },
};

afterEach(async () => {
  for (const userId of createdUserIds.splice(0)) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe('Fast conversation repository', () => {
  it('converges concurrent creation on one provider-neutral and legacy row', async () => {
    const user = await createUser();
    const sessions = await Promise.all(
      Array.from({ length: 12 }, () =>
        fastAgentConversationRepository.getOrCreate({
          userId: user.id,
          conversation: slackConversation,
        }),
      ),
    );

    expect(new Set(sessions.map(({ id }) => id)).size).toBe(1);
    const sessionId = sessions[0]!.id;
    const [neutralRows, legacyRows] = await Promise.all([
      db
        .select({ id: fastAgentConversations.id })
        .from(fastAgentConversations)
        .where(
          and(
            eq(fastAgentConversations.surface, 'slack'),
            eq(
              fastAgentConversations.workspaceId,
              slackConversation.workspaceId,
            ),
            eq(
              fastAgentConversations.conversationId,
              slackConversation.conversationId,
            ),
          ),
        ),
      db
        .select({ id: slackQuickAnswers.id })
        .from(slackQuickAnswers)
        .where(eq(slackQuickAnswers.id, sessionId)),
    ]);

    expect(neutralRows).toEqual([{ id: sessionId }]);
    expect(legacyRows).toEqual([{ id: sessionId }]);
  });

  it('keeps identity stable while updating the current reply destination', async () => {
    const user = await createUser();
    const discordConversation = {
      surface: 'discord' as const,
      workspaceId: 'guild-destination-test',
      conversationId: 'conversation-destination-test',
      replyTarget: { channelId: 'original-channel' },
    };
    const original = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: discordConversation,
    });
    const movedConversation = {
      ...discordConversation,
      replyTarget: {
        channelId: 'moved-channel',
        threadId: 'moved-thread',
      },
    };
    const moved = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: movedConversation,
    });
    const resolved = await fastAgentConversationRepository.findById({
      id: original.id,
      fallbackConversation: discordConversation,
    });

    expect(moved.id).toBe(original.id);
    expect(resolved?.conversation).toEqual(movedConversation);
  });

  it('isolates identical external identities by provider', async () => {
    const user = await createUser();
    const slack = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    const discord = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: {
        surface: 'discord',
        workspaceId: slackConversation.workspaceId,
        conversationId: slackConversation.conversationId,
        replyTarget: { channelId: 'discord-channel' },
      },
    });

    expect(discord.id).not.toBe(slack.id);
  });

  it('looks up Slack and Discord Fast conversations through neutral identity', async () => {
    const user = await createUser();
    const discordConversation = {
      surface: 'discord' as const,
      workspaceId: slackConversation.workspaceId,
      conversationId: slackConversation.conversationId,
      replyTarget: { channelId: 'discord-parent' },
    };

    expect(await hasFastAgentSession(slackConversation)).toBe(false);
    expect(await hasFastAgentSession(discordConversation)).toBe(false);

    await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: discordConversation,
    });

    expect(await hasFastAgentSession(slackConversation)).toBe(true);
    expect(
      await hasFastAgentSession({
        ...discordConversation,
        replyTarget: { channelId: 'moved-discord-parent' },
      }),
    ).toBe(true);
  });

  it('serializes concurrent visible-message mirrors with an N-1 writer', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    const appended = Array.from({ length: 16 }, (_, index) => ({
      role: 'user' as const,
      content: `message-${index}`,
    }));
    const rollbackMessage = {
      role: 'assistant' as const,
      content: 'message-from-n-1',
    };

    await Promise.all([
      ...appended.map((message) =>
        fastAgentConversationRepository.appendVisibleMessages({
          conversationId: session.id,
          messages: [message],
        }),
      ),
      db
        .update(slackQuickAnswers)
        .set({
          messages: sql`${slackQuickAnswers.messages} || ${JSON.stringify([rollbackMessage])}::jsonb`,
        })
        .where(eq(slackQuickAnswers.id, session.id)),
    ]);

    const [stored, legacy] = await Promise.all([
      fastAgentConversationRepository.findById({ id: session.id }),
      db.query.slackQuickAnswers.findFirst({
        where: eq(slackQuickAnswers.id, session.id),
        columns: { messages: true },
      }),
    ]);
    expect(stored?.compatibilityMessages).toEqual(legacy?.messages);
    expect(
      new Set(
        stored?.compatibilityMessages.map((message) =>
          String(message.content),
        ) ?? [],
      ),
    ).toEqual(
      new Set([
        ...appended.map(({ content }) => content),
        rollbackMessage.content,
      ]),
    );
  });

  it('backfills identity while retaining legacy history only as a cold fallback', async () => {
    const user = await createUser();
    const legacyMessages = [
      { role: 'user', content: 'before migration' },
      { role: 'assistant', content: 'legacy answer' },
    ] satisfies ModelMessage[];
    const [legacy] = await db
      .insert(slackQuickAnswers)
      .values({
        userId: user.id,
        slackChannel: `${slackConversation.workspaceId}:${slackConversation.replyTarget.channelId}`,
        slackThreadTs: slackConversation.conversationId,
        messages: legacyMessages,
      })
      .returning({ id: slackQuickAnswers.id });

    const migrated = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    expect(migrated.id).toBe(legacy!.id);
    expect(migrated.compatibilityMessages).toEqual(legacyMessages);

    const rollbackMessage = {
      role: 'user' as const,
      content: 'written by N-1 after rollback',
    };
    await db
      .update(slackQuickAnswers)
      .set({
        messages: sql`${slackQuickAnswers.messages} || ${JSON.stringify([rollbackMessage])}::jsonb`,
      })
      .where(eq(slackQuickAnswers.id, migrated.id));

    const upgradedAgain = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    expect(upgradedAgain.compatibilityMessages).toEqual([
      ...legacyMessages,
      rollbackMessage,
    ]);
  });

  it('aliases moved legacy UUIDs and mirrors new visible turns to both', async () => {
    const user = await createUser();
    const originalConversation = {
      surface: 'discord' as const,
      workspaceId: 'guild-alias-test',
      conversationId: 'thread-alias-test',
      replyTarget: { channelId: 'original-parent' },
    };
    const canonical = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: originalConversation,
    });
    const originalMessage = {
      role: 'user' as const,
      content: 'original legacy history',
    };
    await fastAgentConversationRepository.appendVisibleMessages({
      conversationId: canonical.id,
      messages: [originalMessage],
    });

    const movedConversation = {
      ...originalConversation,
      replyTarget: { channelId: 'moved-parent', threadId: 'thread-alias-test' },
    };
    const movedMessage = {
      role: 'assistant' as const,
      content: 'history written by N-1 after the move',
    };
    const [movedLegacy] = await db
      .insert(slackQuickAnswers)
      .values({
        userId: user.id,
        slackChannel: 'discord:guild-alias-test:moved-parent',
        slackThreadTs: 'thread-alias-test',
        messages: [movedMessage],
      })
      .returning({ id: slackQuickAnswers.id });

    const moved = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: movedConversation,
    });
    const resolvedFromLegacyId = await fastAgentConversationRepository.findById(
      {
        id: movedLegacy!.id,
        fallbackConversation: movedConversation,
      },
    );

    expect(moved.id).toBe(canonical.id);
    expect(resolvedFromLegacyId?.id).toBe(canonical.id);
    expect(resolvedFromLegacyId?.compatibilityMessages).toEqual([movedMessage]);
    expect(
      await fastAgentConversationRepository.getLookupIds(canonical.id),
    ).toEqual(expect.arrayContaining([canonical.id, movedLegacy!.id]));

    const aliases = await db
      .select({
        legacyConversationId: fastAgentConversationAliases.legacyConversationId,
        conversationId: fastAgentConversationAliases.conversationId,
      })
      .from(fastAgentConversationAliases)
      .where(eq(fastAgentConversationAliases.conversationId, canonical.id));
    expect(aliases).toEqual(
      expect.arrayContaining([
        {
          legacyConversationId: canonical.id,
          conversationId: canonical.id,
        },
        {
          legacyConversationId: movedLegacy!.id,
          conversationId: canonical.id,
        },
      ]),
    );

    const newVisibleMessage = {
      role: 'assistant' as const,
      content: 'visible after the move',
    };
    await fastAgentConversationRepository.appendVisibleMessages({
      conversationId: canonical.id,
      messages: [newVisibleMessage],
    });
    const legacyRows = await db.query.slackQuickAnswers.findMany({
      where: inArray(slackQuickAnswers.id, [canonical.id, movedLegacy!.id]),
      columns: { id: true, messages: true },
    });
    expect(legacyRows).toHaveLength(2);
    for (const row of legacyRows) {
      expect(row.messages.at(-1)).toEqual(newVisibleMessage);
    }
  });

  it('does not miss a visible message while adding a moved-destination alias', async () => {
    const user = await createUser();
    const originalConversation = {
      surface: 'discord' as const,
      workspaceId: 'guild-concurrent-move',
      conversationId: 'thread-concurrent-move',
      replyTarget: { channelId: 'original-parent' },
    };
    const canonical = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: originalConversation,
    });
    const movedConversation = {
      ...originalConversation,
      replyTarget: { channelId: 'moved-parent' },
    };
    const visibleMessage = {
      role: 'assistant' as const,
      content: 'visible during destination move',
    };

    await Promise.all([
      fastAgentConversationRepository.getOrCreate({
        userId: user.id,
        conversation: movedConversation,
      }),
      fastAgentConversationRepository.appendVisibleMessages({
        conversationId: canonical.id,
        messages: [visibleMessage],
      }),
    ]);

    const aliases = await db.query.fastAgentConversationAliases.findMany({
      where: eq(fastAgentConversationAliases.conversationId, canonical.id),
      columns: { legacyConversationId: true },
    });
    const legacyRows = await db.query.slackQuickAnswers.findMany({
      where: inArray(
        slackQuickAnswers.id,
        aliases.map(({ legacyConversationId }) => legacyConversationId),
      ),
      columns: { messages: true },
    });
    expect(legacyRows).toHaveLength(2);
    for (const row of legacyRows) {
      expect(row.messages).toContainEqual(visibleMessage);
    }
  });

  it('repairs an unverified migrated Discord destination from child metadata', async () => {
    const user = await createUser();
    const id = crypto.randomUUID();
    await db.insert(slackQuickAnswers).values({
      id,
      userId: user.id,
      slackChannel: 'discord:guild-1:parent-channel',
      slackThreadTs: 'thread-1',
    });
    await db.insert(fastAgentConversations).values({
      id,
      userId: user.id,
      surface: 'discord',
      workspaceId: 'guild-1',
      conversationId: 'thread-1',
      currentReplyChannelId: 'parent-channel',
      replyTargetVerified: false,
    });

    const fallbackConversation = {
      surface: 'discord' as const,
      workspaceId: 'guild-1',
      conversationId: 'thread-1',
      replyTarget: { channelId: 'parent-channel', threadId: 'thread-1' },
    };
    const resolved = await fastAgentConversationRepository.findById({
      id,
      fallbackConversation,
    });

    expect(resolved?.conversation).toEqual(fallbackConversation);
    const row = await db.query.fastAgentConversations.findFirst({
      where: eq(fastAgentConversations.id, id),
      columns: { replyTargetVerified: true },
    });
    expect(row?.replyTargetVerified).toBe(true);
  });
});
