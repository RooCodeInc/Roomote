import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, userFactory } from '../server';
import {
  fastAgentConversations,
  fastAgentParentEvents,
  sessions,
  telegramUserMappings,
  telegramManagedBotPairings as pairings,
  users,
} from '../schema';
import {
  activateTelegramManagedBot,
  beginTelegramManagedBotPairing,
  disconnectTelegramManagedBot,
  getTelegramManagedBotRoute,
  provisionTelegramManagedBot,
  recordTelegramManagedBotCandidate,
  resolveTelegramManagedBotCredentials,
  selectTelegramManagedBotCandidate,
} from '../lib/telegram-managed-bots';

const userIds: string[] = [];
let telegramId = 900_000;
async function setup() {
  const user = await userFactory.create();
  userIds.push(user.id);
  const ownerTelegramUserId = String(++telegramId);
  await db.insert(telegramUserMappings).values({
    userId: user.id,
    telegramUserId: ownerTelegramUserId,
    telegramChatId: ownerTelegramUserId,
  });
  const [session] = await db
    .insert(fastAgentConversations)
    .values({
      userId: user.id,
      surface: 'telegram',
      workspaceId: ownerTelegramUserId,
      conversationId: randomUUID(),
      currentReplyChannelId: ownerTelegramUserId,
    })
    .returning();
  const input = {
    sessionId: session!.id,
    ownerUserId: user.id,
    ownerTelegramUserId,
  };
  return { ...input, botId: String(++telegramId), session: session! };
}

async function candidate(input: Awaited<ReturnType<typeof setup>>) {
  const started = await beginTelegramManagedBotPairing(input);
  expect(started).not.toBeNull();
  const result = await recordTelegramManagedBotCandidate({
    ...input,
    botUsername: 'session_test_bot',
    managementUpdateId: 1,
  });
  expect(result).not.toBeNull();
  return result!;
}

async function ready(input: Awaited<ReturnType<typeof setup>>) {
  const result = await candidate(input);
  await selectTelegramManagedBotCandidate(
    result.candidate.id,
    input.ownerTelegramUserId,
  );
  const provision = vi.fn(async () => ({
    botToken: `${input.botId}:test_token`,
    botUsername: 'session_test_bot',
  }));
  const link = await provisionTelegramManagedBot(
    result.pairing.id,
    input.ownerTelegramUserId,
    provision,
  );
  expect(link).not.toBeNull();
  return { ...result, link: link!, provision };
}

afterAll(async () => {
  for (const id of userIds) await db.delete(users).where(eq(users.id, id));
});

describe('managed Telegram bot durable binding', () => {
  it('resolves a plain DM by its exact persisted identity, never by latest owner conversation', async () => {
    const input = await setup();
    const owner = {
      ownerTelegramUserId: input.ownerTelegramUserId,
      ownerUserId: input.ownerUserId,
    };
    expect(await beginTelegramManagedBotPairing(owner)).toBeNull();
    await db
      .update(fastAgentConversations)
      .set({
        conversationId: `${input.ownerTelegramUserId}:user:${input.ownerUserId}`,
      })
      .where(eq(fastAgentConversations.id, input.sessionId));
    await db.insert(fastAgentConversations).values({
      userId: input.ownerUserId,
      surface: 'telegram',
      workspaceId: input.ownerTelegramUserId,
      conversationId: `42:user:${input.ownerUserId}`,
      currentReplyChannelId: input.ownerTelegramUserId,
      currentReplyThreadId: '42',
    });
    const result = await beginTelegramManagedBotPairing(owner);
    expect(result!.pairing.sessionId).toBe(input.sessionId);
    expect(result!.pairing.botId).toBeNull();
  });
  it('does not consume the ticket while a durable turn is pending', async () => {
    const input = await setup();
    const result = await ready(input);
    const [event] = await db
      .insert(fastAgentParentEvents)
      .values({
        conversationId: input.sessionId,
        eventKey: randomUUID(),
        parent: {
          sessionId: input.sessionId,
          conversation: {
            surface: 'telegram',
            workspaceId: input.ownerTelegramUserId,
            conversationId: input.session.conversationId,
            replyTarget: { channelId: input.ownerTelegramUserId },
          },
        },
        event: { type: 'human_follow_up', question: 'pending' },
      })
      .returning();
    expect(
      await activateTelegramManagedBot(
        input.botId,
        input.ownerTelegramUserId,
        result.link.ticket,
      ),
    ).toBeNull();
    await db
      .update(fastAgentParentEvents)
      .set({ deliveredAt: new Date() })
      .where(eq(fastAgentParentEvents.id, event!.id));
    expect(
      await activateTelegramManagedBot(
        input.botId,
        input.ownerTelegramUserId,
        result.link.ticket,
      ),
    ).toBe(input.sessionId);
  });
  it('waits for the managed_bot owner event when the service message arrives first', async () => {
    const input = await setup();
    await beginTelegramManagedBotPairing(input);
    expect(
      await recordTelegramManagedBotCandidate({
        ...input,
        botUsername: 'service_first_bot',
      }),
    ).toBeNull();
    const result = await recordTelegramManagedBotCandidate({
      ...input,
      botUsername: 'service_first_bot',
      managementUpdateId: 10,
    });
    expect(result).not.toBeNull();
    expect(
      await selectTelegramManagedBotCandidate(
        result!.candidate.id,
        input.ownerTelegramUserId,
      ),
    ).not.toBeNull();
  });

  it('never assigns orphan or expired creation updates to a later request', async () => {
    const input = await setup();
    const event = {
      ...input,
      botUsername: 'orphan_bot',
      managementUpdateId: 1,
    };
    expect(await recordTelegramManagedBotCandidate(event)).toBeNull();
    await beginTelegramManagedBotPairing(input);
    expect(await recordTelegramManagedBotCandidate(event)).toBeNull();
    const newEvent = {
      ...event,
      botId: String(++telegramId),
      managementUpdateId: 2,
    };
    const old = await recordTelegramManagedBotCandidate(newEvent);
    expect(old).not.toBeNull();
    await db
      .update(pairings)
      .set({ expiresAt: new Date(0) })
      .where(eq(pairings.id, old!.pairing.id));
    await beginTelegramManagedBotPairing(input);
    expect(await recordTelegramManagedBotCandidate(newEvent)).toBeNull();
  });

  it('ignores exact native-event replays but revokes on a later management change', async () => {
    const input = await setup();
    const result = await ready(input);
    await activateTelegramManagedBot(
      input.botId,
      input.ownerTelegramUserId,
      result.link.ticket,
    );
    await recordTelegramManagedBotCandidate({
      ...input,
      botUsername: 'session_test_bot',
      managementUpdateId: 1,
    });
    expect(
      await resolveTelegramManagedBotCredentials(`telegram-bot:${input.botId}`),
    ).not.toBeNull();
    await recordTelegramManagedBotCandidate({
      ...input,
      botUsername: null,
      managementUpdateId: 2,
    });
    expect(
      await resolveTelegramManagedBotCredentials(`telegram-bot:${input.botId}`),
    ).toBeNull();
    await recordTelegramManagedBotCandidate({
      ...input,
      botUsername: 'session_test_bot',
      managementUpdateId: 1,
    });
    expect(
      await activateTelegramManagedBot(
        input.botId,
        input.ownerTelegramUserId,
        result.link.ticket,
      ),
    ).toBeNull();
  });

  it('serializes activation against disconnect and always ends revoked', async () => {
    const input = await setup();
    const result = await ready(input);
    await Promise.all([
      activateTelegramManagedBot(
        input.botId,
        input.ownerTelegramUserId,
        result.link.ticket,
      ),
      disconnectTelegramManagedBot(input.botId, input.ownerTelegramUserId),
    ]);
    expect(await getTelegramManagedBotRoute(input.botId)).toBeNull();
    expect(
      await resolveTelegramManagedBotCredentials(`telegram-bot:${input.botId}`),
    ).toBeNull();
    expect(
      await activateTelegramManagedBot(
        input.botId,
        input.ownerTelegramUserId,
        result.link.ticket,
      ),
    ).toBeNull();
  });

  it('rechecks active namespace, reply address, and deleted owner on every resolution', async () => {
    const input = await setup();
    const result = await ready(input);
    await activateTelegramManagedBot(
      input.botId,
      input.ownerTelegramUserId,
      result.link.ticket,
    );
    await db
      .update(fastAgentConversations)
      .set({ currentReplyChannelId: 'wrong-chat' })
      .where(eq(fastAgentConversations.id, input.sessionId));
    expect(
      await resolveTelegramManagedBotCredentials(`telegram-bot:${input.botId}`),
    ).toBeNull();
    await db
      .update(fastAgentConversations)
      .set({
        currentReplyChannelId: input.ownerTelegramUserId,
        workspaceId: input.ownerTelegramUserId,
      })
      .where(eq(fastAgentConversations.id, input.sessionId));
    expect(
      await resolveTelegramManagedBotCredentials(`telegram-bot:${input.botId}`),
    ).toBeNull();
    await db
      .update(fastAgentConversations)
      .set({ workspaceId: `telegram-bot:${input.botId}` })
      .where(eq(fastAgentConversations.id, input.sessionId));
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, input.ownerUserId));
    expect(
      await resolveTelegramManagedBotCredentials(`telegram-bot:${input.botId}`),
    ).toBeNull();
  });

  it('allows one pending request per owner without silently changing its Session', async () => {
    const input = await setup();
    const [a, b] = await Promise.all([
      beginTelegramManagedBotPairing(input),
      beginTelegramManagedBotPairing(input),
    ]);
    expect(a!.pairing.id).toBe(b!.pairing.id);
    expect([a!.existing, b!.existing].sort()).toEqual([false, true]);
    const other = await setup();
    const repeated = await beginTelegramManagedBotPairing({
      ...input,
      sessionId: other.sessionId,
    });
    expect(repeated!.pairing.sessionId).toBe(input.sessionId);
    expect(repeated!.existing).toBe(true);
  });

  it('does not create a session or bind a foreign/group conversation', async () => {
    const input = await setup();
    const other = await setup();
    expect(
      await beginTelegramManagedBotPairing({
        ...input,
        sessionId: other.sessionId,
      }),
    ).toBeNull();
    await db
      .update(fastAgentConversations)
      .set({ workspaceId: '-100', currentReplyChannelId: '-100' })
      .where(eq(fastAgentConversations.id, input.sessionId));
    expect(await beginTelegramManagedBotPairing(input)).toBeNull();
    expect(
      await beginTelegramManagedBotPairing({
        ...input,
        sessionId: randomUUID(),
      }),
    ).toBeNull();
  });

  it('requires a real candidate and the exact owner; competing selections cannot replace the winner', async () => {
    const input = await setup();
    const first = await candidate(input);
    const second = await recordTelegramManagedBotCandidate({
      ...input,
      botId: String(++telegramId),
      botUsername: 'other_test_bot',
      managementUpdateId: 2,
    });
    expect(
      await selectTelegramManagedBotCandidate(
        randomUUID(),
        input.ownerTelegramUserId,
      ),
    ).toBeNull();
    expect(
      await selectTelegramManagedBotCandidate(first.candidate.id, '123'),
    ).toBeNull();
    const selected = await Promise.all([
      selectTelegramManagedBotCandidate(
        first.candidate.id,
        input.ownerTelegramUserId,
      ),
      selectTelegramManagedBotCandidate(
        second!.candidate.id,
        input.ownerTelegramUserId,
      ),
    ]);
    expect(selected.filter(Boolean)).toHaveLength(1);
    const winner = selected.find(Boolean)!;
    const winningCandidate =
      winner.botId === input.botId ? first.candidate : second!.candidate;
    expect(
      (await selectTelegramManagedBotCandidate(
        winningCandidate.id,
        input.ownerTelegramUserId,
      ))!.botId,
    ).toBe(winner.botId);
    expect(
      await resolveTelegramManagedBotCredentials(
        `telegram-bot:${winner.botId}`,
      ),
    ).toBeNull();
  });

  it('retries token failures for only the selected bot and reuses one encrypted short-lived ticket', async () => {
    const input = await setup();
    const result = await candidate(input);
    await selectTelegramManagedBotCandidate(
      result.candidate.id,
      input.ownerTelegramUserId,
    );
    await expect(
      provisionTelegramManagedBot(
        result.pairing.id,
        input.ownerTelegramUserId,
        async () => {
          throw new Error('token unavailable');
        },
      ),
    ).rejects.toThrow('token unavailable');
    expect(await getTelegramManagedBotRoute(input.botId)).toBeNull();
    const provision = vi.fn(async () => ({
      botToken: `${input.botId}:test_token`,
      botUsername: 'edited_test_bot',
    }));
    const [a, b] = await Promise.all([
      provisionTelegramManagedBot(
        result.pairing.id,
        input.ownerTelegramUserId,
        provision,
      ),
      provisionTelegramManagedBot(
        result.pairing.id,
        input.ownerTelegramUserId,
        provision,
      ),
    ]);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a!.botUsername).toBe('edited_test_bot');
    const [stored] = await db
      .select()
      .from(pairings)
      .where(eq(pairings.id, result.pairing.id));
    expect(stored!.ticket).not.toBe(a!.ticket);
    expect(stored!.botToken).not.toBe(`${input.botId}:test_token`);
    expect(stored!.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 5 * 60_000,
    );
    expect(
      await resolveTelegramManagedBotCredentials(`telegram-bot:${input.botId}`),
    ).toBeNull();
  });

  it('atomically activates the SAME Session once and preserves its memory and durable identity', async () => {
    const input = await setup();
    const [durable] = await db
      .insert(sessions)
      .values({
        title: 'Existing durable Session',
        ownerKind: 'user',
        ownerUserId: input.ownerUserId,
        sourceSurface: 'telegram',
        sourceTrigger: 'message',
        fastConversationId: input.sessionId,
        activityAt: 1,
      })
      .returning();
    await db
      .update(fastAgentConversations)
      .set({
        compatibilityMessages: [{ role: 'user', content: 'keep this' }],
        openCodeSessionId: 'native-session',
      })
      .where(eq(fastAgentConversations.id, input.sessionId));
    const result = await ready(input);
    expect(
      await activateTelegramManagedBot(
        input.botId,
        'wrong-owner',
        result.link.ticket,
      ),
    ).toBeNull();
    expect(
      await activateTelegramManagedBot(
        String(++telegramId),
        input.ownerTelegramUserId,
        result.link.ticket,
      ),
    ).toBeNull();
    const activated = await Promise.all([
      activateTelegramManagedBot(
        input.botId,
        input.ownerTelegramUserId,
        result.link.ticket,
      ),
      activateTelegramManagedBot(
        input.botId,
        input.ownerTelegramUserId,
        result.link.ticket,
      ),
    ]);
    expect(activated.filter(Boolean)).toEqual([input.sessionId]);
    expect(
      await activateTelegramManagedBot(
        input.botId,
        input.ownerTelegramUserId,
        result.link.ticket,
      ),
    ).toBeNull();
    const [conversation] = await db
      .select()
      .from(fastAgentConversations)
      .where(eq(fastAgentConversations.id, input.sessionId));
    expect(conversation).toMatchObject({
      id: input.sessionId,
      conversationId: input.session.conversationId,
      surface: 'telegram',
      workspaceId: `telegram-bot:${input.botId}`,
      currentReplyChannelId: input.ownerTelegramUserId,
      currentReplyThreadId: null,
      compatibilityMessages: [{ role: 'user', content: 'keep this' }],
      openCodeSessionId: 'native-session',
    });
    expect(
      (await db.select().from(sessions).where(eq(sessions.id, durable!.id)))[0]!
        .fastConversationId,
    ).toBe(input.sessionId);
    expect(
      await resolveTelegramManagedBotCredentials(`telegram-bot:${input.botId}`),
    ).toEqual({
      botToken: `${input.botId}:test_token`,
      botId: input.botId,
      ownerTelegramUserId: input.ownerTelegramUserId,
      sessionId: input.sessionId,
    });
  });

  it('rejects expired tickets and stale candidates after a new request', async () => {
    const input = await setup();
    const result = await ready(input);
    await db
      .update(pairings)
      .set({ expiresAt: new Date(0) })
      .where(eq(pairings.id, result.pairing.id));
    expect(
      await activateTelegramManagedBot(
        input.botId,
        input.ownerTelegramUserId,
        result.link.ticket,
      ),
    ).toBeNull();
    expect(await getTelegramManagedBotRoute(input.botId)).toBeNull();
    const next = await beginTelegramManagedBotPairing(input);
    expect(next!.pairing.id).not.toBe(result.pairing.id);
    expect(
      await selectTelegramManagedBotCandidate(
        result.candidate.id,
        input.ownerTelegramUserId,
      ),
    ).toBeNull();
  });

  it('fails closed if the mapping or canonical Session owner changes', async () => {
    const input = await setup();
    const other = await setup();
    const result = await ready(input);
    await db
      .update(telegramUserMappings)
      .set({ userId: other.ownerUserId })
      .where(
        eq(telegramUserMappings.telegramUserId, input.ownerTelegramUserId),
      );
    expect(
      await activateTelegramManagedBot(
        input.botId,
        input.ownerTelegramUserId,
        result.link.ticket,
      ),
    ).toBeNull();
    expect(await getTelegramManagedBotRoute(input.botId)).toBeNull();
    await db
      .update(telegramUserMappings)
      .set({ userId: input.ownerUserId })
      .where(
        eq(telegramUserMappings.telegramUserId, input.ownerTelegramUserId),
      );
    await db.insert(sessions).values({
      title: 'Changed owner',
      ownerKind: 'user',
      ownerUserId: other.ownerUserId,
      sourceSurface: 'telegram',
      sourceTrigger: 'message',
      fastConversationId: input.sessionId,
      activityAt: 1,
    });
    expect(
      await activateTelegramManagedBot(
        input.botId,
        input.ownerTelegramUserId,
        result.link.ticket,
      ),
    ).toBeNull();
  });

  it('revokes routes and tickets without deleting the Session or restoring the main namespace', async () => {
    const input = await setup();
    const result = await ready(input);
    await activateTelegramManagedBot(
      input.botId,
      input.ownerTelegramUserId,
      result.link.ticket,
    );
    expect(await disconnectTelegramManagedBot(input.botId, 'not-owner')).toBe(
      false,
    );
    expect(
      await disconnectTelegramManagedBot(
        input.botId,
        input.ownerTelegramUserId,
      ),
    ).toBe(true);
    expect(
      await disconnectTelegramManagedBot(
        input.botId,
        input.ownerTelegramUserId,
      ),
    ).toBe(false);
    expect(await getTelegramManagedBotRoute(input.botId)).toBeNull();
    expect(
      await resolveTelegramManagedBotCredentials(`telegram-bot:${input.botId}`),
    ).toBeNull();
    expect(
      await activateTelegramManagedBot(
        input.botId,
        input.ownerTelegramUserId,
        result.link.ticket,
      ),
    ).toBeNull();
    expect(
      (
        await db
          .select()
          .from(fastAgentConversations)
          .where(eq(fastAgentConversations.id, input.sessionId))
      )[0]!.workspaceId,
    ).toBe(`telegram-bot:${input.botId}`);
  });

  it('revokes the old route on a native owner transfer, even with no pending request', async () => {
    const input = await setup();
    const result = await ready(input);
    await activateTelegramManagedBot(
      input.botId,
      input.ownerTelegramUserId,
      result.link.ticket,
    );
    expect(
      await recordTelegramManagedBotCandidate({
        ownerTelegramUserId: '123456',
        botId: input.botId,
        botUsername: 'transferred_bot',
      }),
    ).toBeNull();
    expect(
      await resolveTelegramManagedBotCredentials(`telegram-bot:${input.botId}`),
    ).toBeNull();
  });
});
