import {
  and,
  db,
  eq,
  fastAgentConversations,
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
  it('persists a channel-less automation conversation', async () => {
    const user = await createUser();
    const conversation = {
      surface: 'automation' as const,
      workspaceId: 'automation-repository-test',
      conversationId: 'occurrence-repository-test',
    };

    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation,
    });
    const stored = await fastAgentConversationRepository.findById({
      id: session.id,
      fallbackConversation: conversation,
    });

    expect(stored?.conversation).toEqual(conversation);
    const [row] = await db
      .select({
        channelId: fastAgentConversations.currentReplyChannelId,
        surface: fastAgentConversations.surface,
      })
      .from(fastAgentConversations)
      .where(eq(fastAgentConversations.id, session.id));
    expect(row).toEqual({ channelId: null, surface: 'automation' });
  });

  it('converges concurrent creation on one provider-neutral row', async () => {
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
    const rows = await db
      .select({ id: fastAgentConversations.id })
      .from(fastAgentConversations)
      .where(
        and(
          eq(fastAgentConversations.surface, 'slack'),
          eq(fastAgentConversations.workspaceId, slackConversation.workspaceId),
          eq(
            fastAgentConversations.conversationId,
            slackConversation.conversationId,
          ),
        ),
      );

    expect(rows).toEqual([{ id: sessions[0]!.id }]);
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

  it('serializes concurrent visible-message appends in canonical history', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    const appended = Array.from({ length: 16 }, (_, index) => ({
      role: 'user' as const,
      content: `message-${index}`,
    }));

    await Promise.all(
      appended.map((message) =>
        fastAgentConversationRepository.appendVisibleMessages({
          conversationId: session.id,
          messages: [message],
        }),
      ),
    );

    const stored = await fastAgentConversationRepository.findById({
      id: session.id,
    });
    expect(
      new Set(
        stored?.compatibilityMessages.map((message) =>
          String(message.content),
        ) ?? [],
      ),
    ).toEqual(new Set(appended.map(({ content }) => content)));
  });

  it('loads canonical visible history for cold-start transcript rebuilds', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    const visibleHistory = [
      { role: 'user' as const, content: 'Earlier question' },
      { role: 'assistant' as const, content: 'Earlier answer' },
    ];

    await fastAgentConversationRepository.appendVisibleMessages({
      conversationId: session.id,
      messages: visibleHistory,
    });

    await expect(
      fastAgentConversationRepository.findById({ id: session.id }),
    ).resolves.toMatchObject({ compatibilityMessages: visibleHistory });
  });

  it('resolves retained legacy IDs without consulting the alias table', async () => {
    const user = await createUser();
    const canonical = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    const legacyId = crypto.randomUUID();
    await db
      .update(fastAgentConversations)
      .set({ legacyConversationIds: [legacyId] })
      .where(eq(fastAgentConversations.id, canonical.id));

    const resolved = await fastAgentConversationRepository.findById({
      id: legacyId,
      fallbackConversation: slackConversation,
    });

    expect(resolved?.id).toBe(canonical.id);
    await expect(
      fastAgentConversationRepository.getLookupIds(legacyId),
    ).resolves.toEqual(expect.arrayContaining([canonical.id, legacyId]));
  });

  it('does not miss a visible message while moving the reply destination', async () => {
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
    const visibleMessage = {
      role: 'assistant' as const,
      content: 'visible during destination move',
    };

    await Promise.all([
      fastAgentConversationRepository.getOrCreate({
        userId: user.id,
        conversation: {
          ...originalConversation,
          replyTarget: { channelId: 'moved-parent' },
        },
      }),
      fastAgentConversationRepository.appendVisibleMessages({
        conversationId: canonical.id,
        messages: [visibleMessage],
      }),
    ]);

    const stored = await fastAgentConversationRepository.findById({
      id: canonical.id,
    });
    expect(stored?.compatibilityMessages).toContainEqual(visibleMessage);
  });

  it('repairs an unverified migrated Discord destination from child metadata', async () => {
    const user = await createUser();
    const id = crypto.randomUUID();
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
