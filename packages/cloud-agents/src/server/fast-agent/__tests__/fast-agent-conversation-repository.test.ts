import {
  and,
  db,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  inArray,
  sessions,
  userFactory,
  users,
} from '@roomote/db/server';

import {
  fastAgentConversationRepository,
  INTERRUPTED_INFERENCE_RETRY_MESSAGE,
  reconcileExpiredFastAgentInferenceRetryNotices,
  reconcileFastAgentInferenceRetryNotices,
} from '../fast-agent-conversation-repository';
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
    expect(stored?.openCodeSessionId).toBeNull();
    const [row] = await db
      .select({
        channelId: fastAgentConversations.currentReplyChannelId,
        surface: fastAgentConversations.surface,
      })
      .from(fastAgentConversations)
      .where(eq(fastAgentConversations.id, session.id));
    expect(row).toEqual({ channelId: null, surface: 'automation' });
  });

  it.each(['teams', 'telegram'] as const)(
    'persists and reconstructs a %s Fast conversation reply target',
    async (surface) => {
      const user = await createUser();
      const conversation = {
        surface,
        workspaceId: `${surface}-workspace-repository-test`,
        conversationId: `${surface}-conversation-repository-test`,
        replyTarget: {
          channelId: `${surface}-channel-repository-test`,
          threadId: `${surface}-thread-repository-test`,
          ...(surface === 'teams'
            ? { serviceUrl: 'https://smba.example.com/amer/' }
            : {}),
        },
      };

      const session = await fastAgentConversationRepository.getOrCreate({
        userId: user.id,
        conversation,
      });

      await expect(
        fastAgentConversationRepository.findById({ id: session.id }),
      ).resolves.toMatchObject({ conversation });
    },
  );

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
    expect(sessions.filter(({ created }) => created)).toHaveLength(1);
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

  it('persists the canonical OpenCode session identity', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });

    await expect(
      fastAgentConversationRepository.setOpenCodeSession({
        conversationId: session.id,
        openCodeSessionId: 'opencode-session-1',
      }),
    ).resolves.toBeUndefined();

    await expect(
      fastAgentConversationRepository.findById({ id: session.id }),
    ).resolves.toMatchObject({
      openCodeSessionId: 'opencode-session-1',
    });
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

  it('upserts canonical messages idempotently by conversation and event', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    const baseMessage = {
      eventId: 'turn-1:retry-notice',
      turnId: 'turn-1',
      turnSeq: 1,
      ts: 100,
      eventType: 'roomote_runtime.assistant_message' as const,
      role: 'assistant' as const,
      contentBlocks: [{ type: 'text', text: 'Retrying' }],
      metadata: { visibleInTranscript: true },
      payload: { purpose: 'progress' },
      source: 'slack',
    };

    await Promise.all([
      fastAgentConversationRepository.upsertMessage({
        conversationId: session.id,
        message: baseMessage,
      }),
      fastAgentConversationRepository.upsertMessage({
        conversationId: session.id,
        message: {
          ...baseMessage,
          contentBlocks: [{ type: 'text', text: 'Recovered' }],
        },
      }),
    ]);

    const rows = await db
      .select()
      .from(fastAgentMessages)
      .where(eq(fastAgentMessages.conversationId, session.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventId).toBe(baseMessage.eventId);
    expect(rows[0]?.ts).toBe(100);
    expect(
      rows[0]?.contentBlocks.some(
        (block) => block.type === 'text' && block.text === 'Recovered',
      ) ||
        rows[0]?.contentBlocks.some(
          (block) => block.type === 'text' && block.text === 'Retrying',
        ),
    ).toBe(true);
  });

  it('classifies the first message after platform events and human reactions', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    const prompt = (
      eventId: string,
      turnSource: 'human' | 'platform_event',
      inputKind?: 'message' | 'reaction' | 'platform_event',
    ) => ({
      eventId,
      turnId: eventId,
      turnSeq: 0,
      ts: 100,
      eventType: 'roomote_runtime.user_prompt' as const,
      role: 'user' as const,
      contentBlocks: [{ type: 'text' as const, text: 'Prompt' }],
      metadata: {
        visibleInTranscript: true,
        turnSource,
        inputKind:
          inputKind ?? (turnSource === 'human' ? 'message' : 'platform_event'),
      },
      payload: {},
      source: 'slack',
    });

    await expect(
      fastAgentConversationRepository.upsertMessage({
        conversationId: session.id,
        message: prompt('platform-event', 'platform_event'),
      }),
    ).resolves.toEqual({ initialHumanTurn: false });
    await expect(
      fastAgentConversationRepository.upsertMessage({
        conversationId: session.id,
        message: prompt('human-reaction', 'human', 'reaction'),
      }),
    ).resolves.toEqual({ initialHumanTurn: false });
    await expect(
      fastAgentConversationRepository.upsertMessage({
        conversationId: session.id,
        message: prompt('first-human', 'human'),
      }),
    ).resolves.toEqual({ initialHumanTurn: true });
    await expect(
      fastAgentConversationRepository.upsertMessage({
        conversationId: session.id,
        message: prompt('first-human', 'human'),
      }),
    ).resolves.toEqual({ initialHumanTurn: true });
    await expect(
      fastAgentConversationRepository.upsertMessage({
        conversationId: session.id,
        message: prompt('later-human', 'human'),
      }),
    ).resolves.toEqual({ initialHumanTurn: false });
  });

  it('lets only one concurrent human prompt claim the initial turn', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });

    const results = await Promise.all(
      ['human-a', 'human-b'].map((eventId) =>
        fastAgentConversationRepository.upsertMessage({
          conversationId: session.id,
          message: {
            eventId,
            turnId: eventId,
            turnSeq: 0,
            ts: 100,
            eventType: 'roomote_runtime.user_prompt',
            role: 'user',
            contentBlocks: [{ type: 'text', text: 'Prompt' }],
            metadata: { visibleInTranscript: true, turnSource: 'human' },
            payload: {},
            source: 'slack',
          },
        }),
      ),
    );

    expect(
      results.filter(({ initialHumanTurn }) => initialHumanTurn),
    ).toHaveLength(1);
  });

  it('treats rollback-compatible human history as an earlier turn', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    await fastAgentConversationRepository.appendVisibleMessages({
      conversationId: session.id,
      messages: [{ role: 'user', content: 'Earlier question' }],
    });

    await expect(
      fastAgentConversationRepository.upsertMessage({
        conversationId: session.id,
        message: {
          eventId: 'later-human',
          turnId: 'later-human',
          turnSeq: 0,
          ts: 100,
          eventType: 'roomote_runtime.user_prompt',
          role: 'user',
          contentBlocks: [{ type: 'text', text: 'Prompt' }],
          metadata: { visibleInTranscript: true, turnSource: 'human' },
          payload: {},
          source: 'slack',
        },
      }),
    ).resolves.toEqual({ initialHumanTurn: false });
  });

  it('does not treat legacy platform-event history as a human turn', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    await fastAgentConversationRepository.appendVisibleMessages({
      conversationId: session.id,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<platform_event>{"type":"task_settled"}</platform_event>',
            },
          ],
        },
      ],
    });

    await expect(
      fastAgentConversationRepository.upsertMessage({
        conversationId: session.id,
        message: {
          eventId: 'first-human',
          turnId: 'first-human',
          turnSeq: 0,
          ts: 100,
          eventType: 'roomote_runtime.user_prompt',
          role: 'user',
          contentBlocks: [{ type: 'text', text: 'Prompt' }],
          metadata: { visibleInTranscript: true, turnSource: 'human' },
          payload: {},
          source: 'slack',
        },
      }),
    ).resolves.toEqual({ initialHumanTurn: true });
  });

  it('reconciles a persisted legacy retry notice after its turn stops', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    await fastAgentConversationRepository.upsertMessage({
      conversationId: session.id,
      message: {
        eventId: 'turn-stale:retry-notice',
        turnId: 'turn-stale',
        turnSeq: 1,
        ts: 100,
        eventType: 'roomote_runtime.assistant_message',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'Retrying in 1s' }],
        metadata: { visibleInTranscript: true, purpose: 'progress' },
        payload: { purpose: 'progress' },
        source: 'web',
      },
    });

    await expect(
      reconcileFastAgentInferenceRetryNotices(session.id),
    ).resolves.toBe(1);

    const [notice] = await db
      .select()
      .from(fastAgentMessages)
      .where(eq(fastAgentMessages.conversationId, session.id));
    expect(notice?.contentBlocks).toEqual([
      { type: 'text', text: INTERRUPTED_INFERENCE_RETRY_MESSAGE },
    ]);
    expect(notice?.metadata).toMatchObject({
      visibleInTranscript: true,
      purpose: 'closeout',
      inferenceRetryNotice: true,
      inferenceRetryActive: false,
    });
  });

  it('reconciles only retry notices whose session lease is inactive', async () => {
    const user = await createUser();
    const expired = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: {
        surface: 'web',
        workspaceId: user.id,
        conversationId: crypto.randomUUID(),
      },
    });
    const active = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: {
        surface: 'web',
        workspaceId: user.id,
        conversationId: crypto.randomUUID(),
      },
    });
    const retryMessage = {
      eventId: 'turn-1:retry-notice:0',
      turnId: 'turn-1',
      turnSeq: 1,
      ts: 100,
      eventType: 'roomote_runtime.assistant_message' as const,
      role: 'assistant' as const,
      contentBlocks: [{ type: 'text' as const, text: 'Retrying in 1s' }],
      metadata: {
        visibleInTranscript: true,
        purpose: 'progress',
        inferenceRetryNotice: true,
        inferenceRetryActive: true,
      },
      payload: { purpose: 'progress' },
      source: 'web',
    };
    await fastAgentConversationRepository.upsertMessage({
      conversationId: expired.id,
      message: retryMessage,
    });
    await fastAgentConversationRepository.upsertMessage({
      conversationId: active.id,
      message: retryMessage,
    });
    await db
      .update(sessions)
      .set({ respondingUntil: new Date(Date.now() - 1_000) })
      .where(eq(sessions.fastConversationId, expired.id));
    await db
      .update(sessions)
      .set({ respondingUntil: new Date(Date.now() + 60_000) })
      .where(eq(sessions.fastConversationId, active.id));

    await expect(
      reconcileExpiredFastAgentInferenceRetryNotices(),
    ).resolves.toBe(1);

    const rows = await db
      .select({
        conversationId: fastAgentMessages.conversationId,
        metadata: fastAgentMessages.metadata,
      })
      .from(fastAgentMessages)
      .where(
        inArray(fastAgentMessages.conversationId, [expired.id, active.id]),
      );
    expect(
      rows.find((row) => row.conversationId === expired.id)?.metadata,
    ).toMatchObject({ inferenceRetryActive: false });
    expect(
      rows.find((row) => row.conversationId === active.id)?.metadata,
    ).toMatchObject({ inferenceRetryActive: true });
  });
});
