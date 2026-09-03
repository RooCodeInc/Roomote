import {
  and,
  db,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  fastAgentParentEvents,
  inArray,
  sessions,
  userFactory,
  users,
} from '@roomote/db/server';

import {
  fastAgentConversationRepository,
  findFastAgentActiveInferenceRetryNotice,
  findFastAgentUnresolvedRequest,
  INTERRUPTED_INFERENCE_RETRY_MESSAGE,
  scheduleFastAgentDurableTurnRetry,
  settleFastAgentDurableTurn,
  markFastAgentDurableTurnShutdown,
  reconcileFastAgentDeadTurns,
  RESTARTED_ACTIVE_TURN_MESSAGE,
  releaseFastAgentDurableTurnClaim,
  renewFastAgentDurableTurnClaim,
  revokeFastAgentDurableTurnReplay,
  markFastAgentInferenceRetryNoticeInterruption,
  reconcileExpiredFastAgentInferenceRetryNotices,
  reconcileFastAgentInferenceRetryNotices,
  renewFastSessionRespondingLease,
} from '../fast-agent-conversation-repository';
import { FAST_AGENT_REACTION_INPUT_TYPE } from '../fast-agent-conversation';
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

  it('binds a new conversation to the Session it was created for', async () => {
    const user = await createUser();
    const [origin] = await db
      .insert(sessions)
      .values({
        title: 'Weekly scan',
        ownerKind: 'user',
        ownerUserId: user.id,
        sourceSurface: 'web',
        sourceTrigger: 'manual',
        visibility: 'visible',
        activityAt: Math.floor(Date.now() / 1000),
        cachedStatus: 'ready',
      })
      .returning({ id: sessions.id });
    const conversation = {
      surface: 'slack' as const,
      workspaceId: 'team-origin-test',
      conversationId: `thread-origin-${origin!.id}`,
      replyTarget: {
        channelId: 'channel-origin-test',
        threadId: `thread-origin-${origin!.id}`,
      },
    };

    const created = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation,
      sessionId: origin!.id,
    });
    const [bound] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.fastConversationId, created.id));
    expect(bound?.id).toBe(origin!.id);

    // A second Session cannot claim a conversation that already exists.
    const [other] = await db
      .insert(sessions)
      .values({
        title: 'Another scan',
        ownerKind: 'user',
        ownerUserId: user.id,
        sourceSurface: 'web',
        sourceTrigger: 'manual',
        visibility: 'visible',
        activityAt: Math.floor(Date.now() / 1000),
        cachedStatus: 'ready',
      })
      .returning({ id: sessions.id });
    const reused = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation,
      sessionId: other!.id,
    });
    expect(reused.id).toBe(created.id);
    const [otherRow] = await db
      .select({ fastConversationId: sessions.fastConversationId })
      .from(sessions)
      .where(eq(sessions.id, other!.id));
    expect(otherRow?.fastConversationId).toBeNull();
    await db
      .delete(sessions)
      .where(inArray(sessions.id, [origin!.id, other!.id]));
  });

  it('converges concurrent launches into one Session on the conversation that bound first', async () => {
    const user = await createUser();
    const [origin] = await db
      .insert(sessions)
      .values({
        title: 'Weekly scan',
        ownerKind: 'user',
        ownerUserId: user.id,
        sourceSurface: 'web',
        sourceTrigger: 'manual',
        visibility: 'visible',
        activityAt: Math.floor(Date.now() / 1000),
        cachedStatus: 'ready',
      })
      .returning({ id: sessions.id });
    const identity = (index: number) => ({
      surface: 'slack' as const,
      workspaceId: 'team-origin-race-test',
      conversationId: `thread-origin-race-${origin!.id}-${index}`,
      replyTarget: {
        channelId: 'channel-origin-race-test',
        threadId: `thread-origin-race-${origin!.id}-${index}`,
      },
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        fastAgentConversationRepository.getOrCreate({
          userId: user.id,
          conversation: identity(index),
          sessionId: origin!.id,
        }),
      ),
    );

    expect(new Set(results.map(({ id }) => id)).size).toBe(1);
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    const [bound] = await db
      .select({ fastConversationId: sessions.fastConversationId })
      .from(sessions)
      .where(eq(sessions.id, origin!.id));
    expect(bound?.fastConversationId).toBe(results[0]!.id);
    const rows = await db
      .select({ id: fastAgentConversations.id })
      .from(fastAgentConversations)
      .where(eq(fastAgentConversations.workspaceId, 'team-origin-race-test'));
    expect(rows).toHaveLength(1);
    await db.delete(sessions).where(eq(sessions.id, origin!.id));
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

  it('returns the persisted Fast conversation title', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    await db
      .update(fastAgentConversations)
      .set({ title: 'Investigate Slack agent status' })
      .where(eq(fastAgentConversations.id, session.id));

    await expect(
      fastAgentConversationRepository.findById({ id: session.id }),
    ).resolves.toMatchObject({ title: 'Investigate Slack agent status' });
    await expect(
      fastAgentConversationRepository.getOrCreate({
        userId: user.id,
        conversation: slackConversation,
      }),
    ).resolves.toMatchObject({ title: 'Investigate Slack agent status' });
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

  it('resolves a delayed Slack root to the original Fast session', async () => {
    const user = await createUser();
    const pendingConversation = {
      surface: 'slack' as const,
      workspaceId: 'team-delayed-root',
      conversationId: 'automation-1:occurrence-1',
      replyTarget: { channelId: 'channel-delayed-root' },
    };
    const pending = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: pendingConversation,
    });
    await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: {
        ...pendingConversation,
        replyTarget: {
          ...pendingConversation.replyTarget,
          threadId: 'root-delayed-root',
        },
      },
    });
    const inboundConversation = {
      surface: 'slack' as const,
      workspaceId: pendingConversation.workspaceId,
      conversationId: 'root-delayed-root',
      replyTarget: {
        channelId: pendingConversation.replyTarget.channelId,
        threadId: 'root-delayed-root',
      },
    };

    expect(await hasFastAgentSession(inboundConversation)).toBe(true);
    const resumed = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: inboundConversation,
    });

    expect(resumed.id).toBe(pending.id);
    expect(resumed.conversation).toMatchObject({
      conversationId: pendingConversation.conversationId,
      replyTarget: inboundConversation.replyTarget,
    });
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
      inputKind?: typeof FAST_AGENT_REACTION_INPUT_TYPE,
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
        ...(inputKind ? { inputKind } : {}),
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
        message: prompt(
          'human-reaction',
          'human',
          FAST_AGENT_REACTION_INPUT_TYPE,
        ),
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
      reconcileFastAgentInferenceRetryNotices(
        session.id,
        'next_turn_reconcile',
      ),
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
      interruptionReason: 'next_turn_reconcile',
    });
  });

  it('reveals a quiet durable retry marker after its turn is orphaned', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    await fastAgentConversationRepository.upsertMessage({
      conversationId: session.id,
      message: {
        eventId: 'turn-stale:retry-notice:0',
        turnId: 'turn-stale',
        turnSeq: 1,
        ts: 100,
        eventType: 'roomote_runtime.assistant_message',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'Retrying automatically…' }],
        metadata: {
          visibleInTranscript: false,
          purpose: 'progress',
          inferenceRetryNotice: true,
          inferenceRetryActive: true,
        },
        payload: { purpose: 'progress' },
        source: 'web',
      },
    });

    await expect(
      reconcileFastAgentInferenceRetryNotices(
        session.id,
        'turn_settled_reconcile',
      ),
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
      interruptionReason: 'turn_settled_reconcile',
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
    ).toMatchObject({
      inferenceRetryActive: false,
      interruptionReason: 'expired_lease_reconcile',
    });
    expect(
      rows.find((row) => row.conversationId === active.id)?.metadata,
    ).toMatchObject({ inferenceRetryActive: true });
  });

  it('preserves a pre-recorded interruption cause when reconciling', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    await fastAgentConversationRepository.upsertMessage({
      conversationId: session.id,
      message: {
        eventId: 'turn-lost:retry-notice:0',
        turnId: 'turn-lost',
        turnSeq: 1,
        ts: 100,
        eventType: 'roomote_runtime.assistant_message',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'Retrying in 1s' }],
        metadata: {
          visibleInTranscript: true,
          purpose: 'progress',
          inferenceRetryNotice: true,
          inferenceRetryActive: true,
        },
        payload: { purpose: 'progress' },
        source: 'web',
      },
    });

    await markFastAgentInferenceRetryNoticeInterruption(
      session.id,
      'turn-lost:retry-notice:0',
      'lock_lost',
    );

    const [stamped] = await db
      .select({ metadata: fastAgentMessages.metadata })
      .from(fastAgentMessages)
      .where(eq(fastAgentMessages.conversationId, session.id));
    // The stamp records the cause without ending the notice; the reconciler
    // still owns the terminal flip.
    expect(stamped?.metadata).toMatchObject({
      inferenceRetryActive: true,
      interruptionReason: 'lock_lost',
    });

    // A second stamp is fill-only and cannot overwrite the recorded cause.
    await markFastAgentInferenceRetryNoticeInterruption(
      session.id,
      'turn-lost:retry-notice:0',
      'turn_aborted',
    );

    await expect(
      reconcileFastAgentInferenceRetryNotices(
        session.id,
        'next_turn_reconcile',
      ),
    ).resolves.toBe(1);

    const [notice] = await db
      .select()
      .from(fastAgentMessages)
      .where(eq(fastAgentMessages.conversationId, session.id));
    expect(notice?.contentBlocks).toEqual([
      { type: 'text', text: INTERRUPTED_INFERENCE_RETRY_MESSAGE },
    ]);
    expect(notice?.metadata).toMatchObject({
      inferenceRetryActive: false,
      interruptionReason: 'lock_lost',
    });

    // Once terminal, the notice no longer matches the fill-only stamp.
    await expect(
      markFastAgentInferenceRetryNoticeInterruption(
        session.id,
        'turn-lost:retry-notice:0',
        'turn_aborted',
      ),
    ).resolves.toBe(false);
    const [settled] = await db
      .select({ metadata: fastAgentMessages.metadata })
      .from(fastAgentMessages)
      .where(eq(fastAgentMessages.conversationId, session.id));
    expect(settled?.metadata).toMatchObject({
      interruptionReason: 'lock_lost',
    });
  });

  it('never loses a concurrently stamped cause to the reconciler', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });

    for (let round = 0; round < 10; round += 1) {
      const eventId = `turn-race-${round}:retry-notice:0`;
      await fastAgentConversationRepository.upsertMessage({
        conversationId: session.id,
        message: {
          eventId,
          turnId: `turn-race-${round}`,
          turnSeq: 1,
          ts: 100 + round,
          eventType: 'roomote_runtime.assistant_message',
          role: 'assistant',
          contentBlocks: [{ type: 'text', text: 'Retrying in 1s' }],
          metadata: {
            visibleInTranscript: true,
            purpose: 'progress',
            inferenceRetryNotice: true,
            inferenceRetryActive: true,
          },
          payload: { purpose: 'progress' },
          source: 'web',
        },
      });

      // Race the fill-only lock-lost stamp against the reconciler on separate
      // connections. Whenever the stamp reports success (the notice was still
      // active and unreasoned when it ran), the surviving cause must be
      // lock_lost regardless of how the two interleaved.
      const [stamped] = await Promise.all([
        markFastAgentInferenceRetryNoticeInterruption(
          session.id,
          eventId,
          'lock_lost',
        ),
        reconcileFastAgentInferenceRetryNotices(
          session.id,
          'next_turn_reconcile',
        ),
      ]);

      const [notice] = await db
        .select({ metadata: fastAgentMessages.metadata })
        .from(fastAgentMessages)
        .where(
          and(
            eq(fastAgentMessages.conversationId, session.id),
            eq(fastAgentMessages.eventId, eventId),
          ),
        );
      expect(notice?.metadata).toMatchObject({
        inferenceRetryActive: false,
        interruptionReason: stamped ? 'lock_lost' : 'next_turn_reconcile',
      });
    }
  });

  it('surfaces the interrupted request the conversation still owes', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    const write = (
      message: Parameters<
        typeof fastAgentConversationRepository.upsertMessage
      >[0]['message'],
    ) =>
      fastAgentConversationRepository.upsertMessage({
        conversationId: session.id,
        message,
      });
    const prompt = (
      turnId: string,
      ts: number,
      text: string,
      metadata: Record<string, unknown> = {},
    ) =>
      write({
        eventId: `${turnId}:user`,
        turnId,
        turnSeq: 0,
        ts,
        eventType: 'roomote_runtime.user_prompt',
        role: 'user',
        contentBlocks: [{ type: 'text', text }],
        metadata: {
          visibleInTranscript: true,
          turnSource: 'human',
          ...metadata,
        },
        payload: {},
        source: 'slack',
      });
    const closeout = (
      turnId: string,
      ts: number,
      metadata: Record<string, unknown> = {},
    ) =>
      write({
        eventId: `${turnId}:assistant:0`,
        turnId,
        turnSeq: 1,
        ts,
        eventType: 'roomote_runtime.assistant_message',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'closeout' }],
        metadata: {
          visibleInTranscript: true,
          purpose: 'closeout',
          ...metadata,
        },
        payload: { purpose: 'closeout' },
        source: 'slack',
      });

    await expect(
      findFastAgentUnresolvedRequest(session.id),
    ).resolves.toBeNull();

    // A turn that ended in an interruption closeout is still owed.
    await prompt('turn-1', 100, 'Break down the duplicate validation');
    await closeout('turn-1', 110, { interruptionReason: 'api_shutdown' });
    await expect(findFastAgentUnresolvedRequest(session.id)).resolves.toEqual({
      turnId: 'turn-1',
      text: 'Break down the duplicate validation',
      reason: 'api_shutdown',
    });

    // Platform events and reactions that arrive afterward neither answer nor
    // supersede the request, so they must not mask it.
    await prompt('turn-1b', 150, '<platform_event>{}</platform_event>', {
      visibleInTranscript: false,
      turnSource: 'platform_event',
    });
    await closeout('turn-1b', 160);
    await prompt('turn-1c', 170, 'reacted', {
      inputKind: FAST_AGENT_REACTION_INPUT_TYPE,
    });
    await closeout('turn-1c', 180);
    await expect(findFastAgentUnresolvedRequest(session.id)).resolves.toEqual({
      turnId: 'turn-1',
      text: 'Break down the duplicate validation',
      reason: 'api_shutdown',
    });

    // A nudge that resumed it and was interrupted again still surfaces the
    // original request, not the nudge.
    await prompt('turn-2', 200, 'hey', { resumesTurnId: 'turn-1' });
    await closeout('turn-2', 210, { interruptionReason: 'lock_lost' });
    await expect(findFastAgentUnresolvedRequest(session.id)).resolves.toEqual({
      turnId: 'turn-1',
      text: 'Break down the duplicate validation',
      reason: 'lock_lost',
    });

    // A completed turn settles the debt.
    await prompt('turn-3', 300, 'Thanks, what about the release?');
    await closeout('turn-3', 310);
    await expect(
      findFastAgentUnresolvedRequest(session.id),
    ).resolves.toBeNull();

    // An interrupted platform-event turn is not a request the user is owed.
    await prompt('turn-4', 400, '<platform_event>{}</platform_event>', {
      visibleInTranscript: false,
      turnSource: 'platform_event',
    });
    await closeout('turn-4', 410, { interruptionReason: 'api_shutdown' });
    await expect(
      findFastAgentUnresolvedRequest(session.id),
    ).resolves.toBeNull();
  });

  it('walks a durable turn row through claim, release, revoke, and delivery', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    const parent = { sessionId: session.id, conversation: slackConversation };
    const insertRow = async (eventKey: string) => {
      const [row] = await db
        .insert(fastAgentParentEvents)
        .values({
          conversationId: session.id,
          eventKey,
          parent,
          event: { type: 'human_follow_up', eventId: eventKey },
          admission: 'inline',
          claimedUntil: new Date(Date.now() + 1_000),
        })
        .returning({ id: fastAgentParentEvents.id });
      return row!.id;
    };
    const readRow = async (id: string) => {
      const [row] = await db
        .select({
          claimedUntil: fastAgentParentEvents.claimedUntil,
          deliveredAt: fastAgentParentEvents.deliveredAt,
          discardedAt: fastAgentParentEvents.discardedAt,
          lastError: fastAgentParentEvents.lastError,
        })
        .from(fastAgentParentEvents)
        .where(eq(fastAgentParentEvents.id, id));
      return row!;
    };

    // A live owner renews its claim, then hands the turn back on interruption.
    const resumable = await insertRow('durable-resumable');
    const before = (await readRow(resumable)).claimedUntil!;
    await expect(renewFastAgentDurableTurnClaim(resumable)).resolves.toBe(true);
    expect((await readRow(resumable)).claimedUntil!.getTime()).toBeGreaterThan(
      before.getTime(),
    );
    await expect(releaseFastAgentDurableTurnClaim(resumable)).resolves.toBe(
      true,
    );
    expect((await readRow(resumable)).claimedUntil).toBeNull();

    // Revocation is terminal: later renewals, releases, and settlements no-op.
    const acted = await insertRow('durable-acted');
    await expect(
      revokeFastAgentDurableTurnReplay(acted, 'Native tool launch_task'),
    ).resolves.toBe(true);
    const revoked = await readRow(acted);
    expect(revoked.discardedAt).not.toBeNull();
    expect(revoked.lastError).toBe('Native tool launch_task');
    await expect(renewFastAgentDurableTurnClaim(acted)).resolves.toBe(false);
    await expect(releaseFastAgentDurableTurnClaim(acted)).resolves.toBe(false);
    // Settling a withdrawn row records the outcome without undoing the
    // withdrawal.
    await settleFastAgentDurableTurn(acted);
    expect((await readRow(acted)).deliveredAt).toBeNull();

    // Settling a pending row delivers it, and only the first settle counts.
    const completed = await insertRow('durable-completed');
    await settleFastAgentDurableTurn(completed);
    const deliveredAt = (await readRow(completed)).deliveredAt;
    expect(deliveredAt).not.toBeNull();
    await settleFastAgentDurableTurn(completed);
    expect((await readRow(completed)).deliveredAt).toEqual(deliveredAt);
    await expect(
      revokeFastAgentDurableTurnReplay(completed, 'late'),
    ).resolves.toBe(false);
  });

  it('parks a durable turn for a scheduled retry and lets a resumed run find its notice', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    const parent = { sessionId: session.id, conversation: slackConversation };
    const [row] = await db
      .insert(fastAgentParentEvents)
      .values({
        conversationId: session.id,
        eventKey: 'durable-retry',
        parent,
        event: { type: 'human_follow_up', eventId: 'durable-retry' },
        admission: 'inline',
        claimedUntil: new Date(Date.now() + 1_000),
      })
      .returning({ id: fastAgentParentEvents.id });
    const readRow = async () => {
      const [current] = await db
        .select({
          claimedUntil: fastAgentParentEvents.claimedUntil,
          retryAt: fastAgentParentEvents.retryAt,
          inferenceRetries: fastAgentParentEvents.inferenceRetries,
          lastError: fastAgentParentEvents.lastError,
        })
        .from(fastAgentParentEvents)
        .where(eq(fastAgentParentEvents.id, row!.id));
      return current!;
    };

    // Parking releases the owner's claim and records when and why.
    const retryAt = new Date(Date.now() + 45_000);
    await expect(
      scheduleFastAgentDurableTurnRetry(row!.id, {
        retryAt,
        inferenceRetries: 2,
        reason: 'Inference retry 2/6 scheduled (timeout).',
      }),
    ).resolves.toBe(true);
    const parked = await readRow();
    expect(parked).toMatchObject({
      claimedUntil: null,
      inferenceRetries: 2,
      lastError: 'Inference retry 2/6 scheduled (timeout).',
    });
    expect(parked.retryAt?.getTime()).toBe(retryAt.getTime());

    // A settled row can no longer be parked.
    await settleFastAgentDurableTurn(row!.id);
    await expect(
      scheduleFastAgentDurableTurnRetry(row!.id, {
        retryAt,
        inferenceRetries: 3,
        reason: 'late',
      }),
    ).resolves.toBe(false);
    expect((await readRow()).inferenceRetries).toBe(2);

    // The resumed run finds the notice its predecessor left active for this
    // turn, and only while it is still active.
    await fastAgentConversationRepository.upsertMessage({
      conversationId: session.id,
      message: {
        eventId: 'turn-retry:retry-notice:0',
        turnId: 'turn-retry',
        turnSeq: 1,
        ts: 100,
        eventType: 'roomote_runtime.assistant_message',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'Retrying in 45s' }],
        metadata: {
          visibleInTranscript: true,
          purpose: 'progress',
          inferenceRetryNotice: true,
          inferenceRetryActive: true,
          platformMessageId: 'notice-1',
        },
        payload: { purpose: 'progress' },
        source: 'slack',
      },
    });
    await expect(
      findFastAgentActiveInferenceRetryNotice(session.id, 'turn-retry'),
    ).resolves.toEqual({
      eventId: 'turn-retry:retry-notice:0',
      ts: 100,
      text: 'Retrying in 45s',
      platformMessageId: 'notice-1',
    });
    await expect(
      findFastAgentActiveInferenceRetryNotice(session.id, 'turn-other'),
    ).resolves.toBeNull();
    await reconcileFastAgentInferenceRetryNotices(
      session.id,
      'turn_settled_reconcile',
    );
    await expect(
      findFastAgentActiveInferenceRetryNotice(session.id, 'turn-retry'),
    ).resolves.toBeNull();
  });

  it('does not reconcile an expired lease while a durable retry is scheduled', async () => {
    const user = await createUser();
    const conversation = {
      surface: 'web' as const,
      workspaceId: user.id,
      conversationId: crypto.randomUUID(),
    };
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation,
    });
    await fastAgentConversationRepository.upsertMessage({
      conversationId: session.id,
      message: {
        eventId: 'turn-1:retry-notice:0',
        turnId: 'turn-1',
        turnSeq: 1,
        ts: 100,
        eventType: 'roomote_runtime.assistant_message',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'Retrying in 45s' }],
        metadata: {
          visibleInTranscript: true,
          purpose: 'progress',
          inferenceRetryNotice: true,
          inferenceRetryActive: true,
        },
        payload: { purpose: 'progress' },
        source: 'web',
      },
    });
    await db
      .update(sessions)
      .set({ respondingUntil: new Date(Date.now() - 1_000) })
      .where(eq(sessions.fastConversationId, session.id));
    await db.insert(fastAgentParentEvents).values({
      conversationId: session.id,
      eventKey: `scheduled-retry-${session.id}`,
      parent: { sessionId: session.id, conversation },
      event: { type: 'human_follow_up', eventId: 'scheduled-retry' },
      admission: 'inline',
      retryAt: new Date(Date.now() + 60_000),
    });
    const readNotice = async () => {
      const [notice] = await db
        .select({ metadata: fastAgentMessages.metadata })
        .from(fastAgentMessages)
        .where(
          and(
            eq(fastAgentMessages.conversationId, session.id),
            eq(fastAgentMessages.eventId, 'turn-1:retry-notice:0'),
          ),
        );
      return notice!.metadata;
    };

    // The lease is inactive, but the scheduled retry still owns the notice.
    await reconcileExpiredFastAgentInferenceRetryNotices();
    expect(await readNotice()).toMatchObject({ inferenceRetryActive: true });

    // Once the row is settled, the same notice is an orphan again.
    await db
      .update(fastAgentParentEvents)
      .set({ deliveredAt: new Date() })
      .where(eq(fastAgentParentEvents.conversationId, session.id));
    await reconcileExpiredFastAgentInferenceRetryNotices();
    expect(await readNotice()).toMatchObject({
      inferenceRetryActive: false,
      purpose: 'closeout',
      interruptionReason: 'expired_lease_reconcile',
    });
  });

  it('closes out a turn whose owner was killed after withdrawing it from replay', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: slackConversation,
    });
    const parent = { sessionId: session.id, conversation: slackConversation };
    const insertRow = async (
      turnId: string,
      values: Record<string, unknown>,
    ) => {
      const [row] = await db
        .insert(fastAgentParentEvents)
        .values({
          conversationId: session.id,
          eventKey: `dead-${turnId}`,
          parent,
          event: {
            type: 'human_follow_up',
            eventId: turnId,
            currentMessageId: turnId,
          },
          admission: 'inline',
          ...values,
        })
        .returning({ id: fastAgentParentEvents.id });
      return row!.id;
    };
    const readRow = async (id: string) => {
      const [row] = await db
        .select({
          settledAt: fastAgentParentEvents.settledAt,
          shutdownAt: fastAgentParentEvents.shutdownAt,
        })
        .from(fastAgentParentEvents)
        .where(eq(fastAgentParentEvents.id, id));
      return row!;
    };
    const closeoutsFor = (turnId: string) =>
      db
        .select({
          text: fastAgentMessages.contentBlocks,
          metadata: fastAgentMessages.metadata,
        })
        .from(fastAgentMessages)
        .where(
          and(
            eq(fastAgentMessages.conversationId, session.id),
            eq(fastAgentMessages.turnId, turnId),
            eq(fastAgentMessages.role, 'assistant'),
          ),
        );
    await db
      .update(sessions)
      .set({ respondingUntil: new Date(Date.now() + 10 * 60_000) })
      .where(eq(sessions.fastConversationId, session.id));

    // Withdrawn from replay (a non-replayable tool ran), then the process
    // was told to stop and killed before it could close out: the stamp is
    // fresh, so the drain might still finish it. Not yet.
    const killed = await insertRow('turn-killed', {
      discardedAt: new Date(),
      lastError: 'Native tool launch_task is not replay-safe.',
      shutdownAt: new Date(),
    });
    await reconcileFastAgentDeadTurns();
    expect((await readRow(killed)).settledAt).toBeNull();
    expect(await closeoutsFor('turn-killed')).toHaveLength(0);

    // Once the stamp is older than the drain window, it is a dead turn.
    await db
      .update(fastAgentParentEvents)
      .set({ shutdownAt: new Date(Date.now() - 2 * 60_000) })
      .where(eq(fastAgentParentEvents.id, killed));
    await expect(reconcileFastAgentDeadTurns()).resolves.toBeGreaterThanOrEqual(
      1,
    );
    expect((await readRow(killed)).settledAt).not.toBeNull();
    const [closeout] = await closeoutsFor('turn-killed');
    expect(closeout?.text).toEqual([
      { type: 'text', text: RESTARTED_ACTIVE_TURN_MESSAGE },
    ]);
    expect(closeout?.metadata).toMatchObject({
      purpose: 'closeout',
      visibleInTranscript: true,
      interruptionReason: 'api_shutdown',
    });
    // The session no longer reads as responding, and a second pass is a
    // no-op.
    const [after] = await db
      .select({ respondingUntil: sessions.respondingUntil })
      .from(sessions)
      .where(eq(sessions.fastConversationId, session.id));
    expect(after?.respondingUntil).toBeNull();
    await reconcileFastAgentDeadTurns();
    expect(await closeoutsFor('turn-killed')).toHaveLength(1);

    // A turn that settled normally, a pending row (recovery's job), and a
    // turn that already closed out are all left alone.
    const settled = await insertRow('turn-settled', {
      deliveredAt: new Date(Date.now() - 20 * 60_000),
      updatedAt: new Date(Date.now() - 20 * 60_000),
      settledAt: new Date(),
    });
    const pending = await insertRow('turn-pending', {
      updatedAt: new Date(Date.now() - 20 * 60_000),
      shutdownAt: new Date(Date.now() - 20 * 60_000),
    });
    const spoken = await insertRow('turn-spoken', {
      discardedAt: new Date(Date.now() - 20 * 60_000),
      updatedAt: new Date(Date.now() - 20 * 60_000),
    });
    await fastAgentConversationRepository.upsertMessage({
      conversationId: session.id,
      message: {
        eventId: 'turn-spoken:assistant:0',
        turnId: 'turn-spoken',
        turnSeq: 1,
        ts: Date.now(),
        eventType: 'roomote_runtime.assistant_message',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'All done.' }],
        metadata: { visibleInTranscript: true, purpose: 'closeout' },
        payload: { purpose: 'closeout' },
        source: 'slack',
      },
    });
    await db
      .update(sessions)
      .set({ respondingUntil: null })
      .where(eq(sessions.fastConversationId, session.id));
    await reconcileFastAgentDeadTurns();
    expect((await readRow(pending)).settledAt).toBeNull();
    expect(await closeoutsFor('turn-pending')).toHaveLength(0);
    expect(await closeoutsFor('turn-settled')).toHaveLength(0);
    expect((await readRow(settled)).settledAt).not.toBeNull();
    // Already spoken for: settled without a second closeout.
    expect((await readRow(spoken)).settledAt).not.toBeNull();
    expect(await closeoutsFor('turn-spoken')).toHaveLength(1);

    // Without a stop signal, a lapsed lease plus a stale row is the signal.
    const crashed = await insertRow('turn-crashed', {
      discardedAt: new Date(Date.now() - 20 * 60_000),
      updatedAt: new Date(Date.now() - 20 * 60_000),
    });
    await reconcileFastAgentDeadTurns();
    expect((await readRow(crashed)).settledAt).not.toBeNull();
    const [crashCloseout] = await closeoutsFor('turn-crashed');
    expect(crashCloseout?.metadata).toMatchObject({
      interruptionReason: 'expired_lease_reconcile',
    });

    // A turn that delivered a progress-only response (a task kickoff, say)
    // and died before settling is spoken for: settle it silently rather than
    // contradict it with a restart notice.
    const kickoff = await insertRow('turn-kickoff', {
      deliveredAt: new Date(Date.now() - 20 * 60_000),
      updatedAt: new Date(Date.now() - 20 * 60_000),
    });
    await fastAgentConversationRepository.upsertMessage({
      conversationId: session.id,
      message: {
        eventId: 'turn-kickoff:assistant:0',
        turnId: 'turn-kickoff',
        turnSeq: 1,
        ts: Date.now() - 20 * 60_000,
        eventType: 'roomote_runtime.assistant_message',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'Starting that task.' }],
        metadata: { visibleInTranscript: true, purpose: 'progress' },
        payload: { purpose: 'progress' },
        source: 'slack',
      },
    });
    await db
      .update(sessions)
      .set({ respondingUntil: null })
      .where(eq(sessions.fastConversationId, session.id));
    await reconcileFastAgentDeadTurns();
    expect((await readRow(kickoff)).settledAt).not.toBeNull();
    expect(await closeoutsFor('turn-kickoff')).toHaveLength(1);

    // A turn whose conversation lock is still held is left alone however
    // stale its row looks.
    const live = await insertRow('turn-live', {
      discardedAt: new Date(Date.now() - 20 * 60_000),
      updatedAt: new Date(Date.now() - 20 * 60_000),
    });
    await reconcileFastAgentDeadTurns(100, { isTurnLive: async () => true });
    expect((await readRow(live)).settledAt).toBeNull();
    expect(await closeoutsFor('turn-live')).toHaveLength(0);
    await reconcileFastAgentDeadTurns(100, { isTurnLive: async () => false });
    expect((await readRow(live)).settledAt).not.toBeNull();

    // A retry notice the dead owner left active becomes the closeout itself,
    // so the retry-notice reconciler has nothing left to stamp.
    const noticed = await insertRow('turn-noticed', {
      discardedAt: new Date(Date.now() - 20 * 60_000),
      updatedAt: new Date(Date.now() - 20 * 60_000),
    });
    await fastAgentConversationRepository.upsertMessage({
      conversationId: session.id,
      message: {
        eventId: 'turn-noticed:retry-notice:0',
        turnId: 'turn-noticed',
        turnSeq: 1,
        ts: Date.now() - 20 * 60_000,
        eventType: 'roomote_runtime.assistant_message',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'Retrying automatically…' }],
        metadata: {
          visibleInTranscript: false,
          purpose: 'progress',
          inferenceRetryNotice: true,
          inferenceRetryActive: true,
        },
        payload: { purpose: 'progress' },
        source: 'slack',
      },
    });
    await db
      .update(sessions)
      .set({ respondingUntil: null })
      .where(eq(sessions.fastConversationId, session.id));
    await reconcileFastAgentDeadTurns();
    expect((await readRow(noticed)).settledAt).not.toBeNull();
    const noticedRows = await closeoutsFor('turn-noticed');
    expect(noticedRows).toHaveLength(1);
    expect(noticedRows[0]?.text).toEqual([
      { type: 'text', text: RESTARTED_ACTIVE_TURN_MESSAGE },
    ]);
    expect(noticedRows[0]?.metadata).toMatchObject({
      visibleInTranscript: true,
      purpose: 'closeout',
      inferenceRetryActive: false,
      interruptionReason: 'expired_lease_reconcile',
    });
    // Nothing left for the retry-notice reconciler to add.
    await reconcileExpiredFastAgentInferenceRetryNotices();
    expect(await closeoutsFor('turn-noticed')).toHaveLength(1);

    // The marks themselves: a settled row refuses a later stamp.
    await expect(markFastAgentDurableTurnShutdown(crashed)).resolves.toBe(
      false,
    );
    // Settling a pending row marks it delivered in the same statement, so a
    // kill can never land between the two.
    const pendingSettle = await insertRow('turn-pending-settle', {});
    await settleFastAgentDurableTurn(pendingSettle);
    const [settledRow] = await db
      .select({
        deliveredAt: fastAgentParentEvents.deliveredAt,
        settledAt: fastAgentParentEvents.settledAt,
      })
      .from(fastAgentParentEvents)
      .where(eq(fastAgentParentEvents.id, pendingSettle));
    expect(settledRow?.deliveredAt).not.toBeNull();
    expect(settledRow?.settledAt).not.toBeNull();
    // A withdrawn row keeps its withdrawal and is only settled.
    const withdrawn = await insertRow('turn-withdrawn', {
      discardedAt: new Date(),
      lastError: 'Native tool launch_task is not replay-safe.',
    });
    await settleFastAgentDurableTurn(withdrawn);
    const [withdrawnRow] = await db
      .select({
        deliveredAt: fastAgentParentEvents.deliveredAt,
        settledAt: fastAgentParentEvents.settledAt,
        lastError: fastAgentParentEvents.lastError,
      })
      .from(fastAgentParentEvents)
      .where(eq(fastAgentParentEvents.id, withdrawn));
    expect(withdrawnRow?.deliveredAt).toBeNull();
    expect(withdrawnRow?.settledAt).not.toBeNull();
    expect(withdrawnRow?.lastError).toBe(
      'Native tool launch_task is not replay-safe.',
    );

    const fresh = await insertRow('turn-fresh', {});
    await expect(markFastAgentDurableTurnShutdown(fresh)).resolves.toBe(true);
    await settleFastAgentDurableTurn(fresh);
    expect((await readRow(fresh)).settledAt).not.toBeNull();
  });

  it('renews only a live responding lease', async () => {
    const user = await createUser();
    const session = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: {
        surface: 'web',
        workspaceId: user.id,
        conversationId: crypto.randomUUID(),
      },
    });
    const readLease = async () => {
      const [row] = await db
        .select({ respondingUntil: sessions.respondingUntil })
        .from(sessions)
        .where(eq(sessions.fastConversationId, session.id));
      return row?.respondingUntil ?? null;
    };

    // A cleared lease is fenced out: a stale renewal cannot resurrect it.
    await db
      .update(sessions)
      .set({ respondingUntil: null })
      .where(eq(sessions.fastConversationId, session.id));
    await expect(renewFastSessionRespondingLease(session.id)).resolves.toBe(
      false,
    );
    await expect(readLease()).resolves.toBeNull();

    // An expired lease is fenced out and left untouched.
    const expired = new Date(Date.now() - 1_000);
    await db
      .update(sessions)
      .set({ respondingUntil: expired })
      .where(eq(sessions.fastConversationId, session.id));
    await expect(renewFastSessionRespondingLease(session.id)).resolves.toBe(
      false,
    );
    await expect(readLease()).resolves.toEqual(expired);

    // A live lease is extended.
    const live = new Date(Date.now() + 60_000);
    await db
      .update(sessions)
      .set({ respondingUntil: live })
      .where(eq(sessions.fastConversationId, session.id));
    await expect(renewFastSessionRespondingLease(session.id)).resolves.toBe(
      true,
    );
    const renewed = await readLease();
    expect(renewed?.getTime()).toBeGreaterThan(live.getTime());
  });
});
