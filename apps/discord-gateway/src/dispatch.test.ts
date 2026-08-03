import { Routes } from 'discord.js';

import { parseDiscordGatewayEvent } from '@roomote/communication/discord-event';

import { handleGatewayDispatch } from './dispatch';
import type { DiscordInboundEnvelope } from './inbound-queue';

describe('handleGatewayDispatch', () => {
  const now = () => new Date('2026-07-12T12:00:00.000Z');

  it('ignores bot-authored messages', async () => {
    const enqueue = vi.fn();
    const rest = { post: vi.fn() };

    await expect(
      handleGatewayDispatch(
        {
          t: 'MESSAGE_CREATE',
          d: { id: 'message-1', author: { id: 'bot-1', bot: true } },
        },
        { enqueue, rest, now },
      ),
    ).resolves.toBe('ignored');

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues complete user messages including attachments', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    const rest = { post: vi.fn() };
    const payload = {
      id: 'message-2',
      content: '',
      author: { id: 'user-1', bot: false },
      attachments: [{ id: 'attachment-1', filename: 'screen.png' }],
    };

    await expect(
      handleGatewayDispatch(
        { t: 'MESSAGE_CREATE', d: payload },
        { enqueue, rest, now },
      ),
    ).resolves.toBe('enqueued');

    expect(enqueue).toHaveBeenCalledWith({
      eventId: 'message-2',
      eventType: 'MESSAGE_CREATE',
      payload,
      receivedAt: '2026-07-12T12:00:00.000Z',
    });
  });

  it('enqueues message reactions with a deterministic event id', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    const rest = { post: vi.fn() };
    const payload = {
      user_id: 'user-1',
      channel_id: 'channel-1',
      message_id: 'message-1',
      guild_id: 'guild-1',
      emoji: { id: null, name: 'white_check_mark' },
      member: {
        user: { id: 'user-1', username: 'matt' },
      },
    };

    await expect(
      handleGatewayDispatch(
        { t: 'MESSAGE_REACTION_ADD', s: 42, d: payload },
        { enqueue, rest, now },
      ),
    ).resolves.toBe('enqueued');

    expect(enqueue).toHaveBeenCalledWith({
      eventId: 'channel-1:message-1:user-1:white_check_mark:42',
      eventType: 'MESSAGE_REACTION_ADD',
      payload,
      receivedAt: '2026-07-12T12:00:00.000Z',
    });
  });

  it('keeps separate reaction adds distinct while deduping Gateway replays', async () => {
    const eventIds = new Set<string>();
    const enqueue = vi.fn(async (envelope: DiscordInboundEnvelope) => {
      if (eventIds.has(envelope.eventId)) return false;
      eventIds.add(envelope.eventId);
      return true;
    });
    const rest = { post: vi.fn() };
    const payload = {
      user_id: 'user-1',
      channel_id: 'channel-1',
      message_id: 'message-1',
      emoji: { id: null, name: 'white_check_mark' },
    };

    await expect(
      handleGatewayDispatch(
        { t: 'MESSAGE_REACTION_ADD', s: 42, d: payload },
        { enqueue, rest, now },
      ),
    ).resolves.toBe('enqueued');
    await expect(
      handleGatewayDispatch(
        { t: 'MESSAGE_REACTION_ADD', s: 42, d: payload },
        { enqueue, rest, now },
      ),
    ).resolves.toBe('duplicate');
    await expect(
      handleGatewayDispatch(
        { t: 'MESSAGE_REACTION_ADD', s: 43, d: payload },
        { enqueue, rest, now },
      ),
    ).resolves.toBe('enqueued');
  });

  it('normalizes a managed-role mention into a canonical bot mention', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    const rest = { post: vi.fn() };
    // Discord's autocomplete resolved the bot by its managed role: user
    // mentions are empty and only mention_roles carries the reference.
    const payload = {
      id: 'message-role-1',
      channel_id: 'channel-1',
      guild_id: 'guild-1',
      content: '<@&bot-role-1> are you there?',
      author: { id: 'user-1', username: 'dan', bot: false },
      mentions: [],
      mention_roles: ['bot-role-1'],
    };

    await expect(
      handleGatewayDispatch(
        { t: 'MESSAGE_CREATE', d: payload },
        {
          enqueue,
          rest,
          now,
          getBotUserId: () => 'bot-1',
          getBotUsername: () => 'RoomoteBot',
          getBotRoleId: (guildId) =>
            guildId === 'guild-1' ? 'bot-role-1' : undefined,
        },
      ),
    ).resolves.toBe('enqueued');

    const envelope = enqueue.mock.calls[0]?.[0] as DiscordInboundEnvelope;
    const normalized = envelope.payload as {
      content?: string;
      mentions?: Array<{ id?: string; username?: string; bot?: boolean }>;
    };
    expect(normalized.content).toBe('<@bot-1> are you there?');
    expect(normalized.mentions).toEqual([
      { id: 'bot-1', username: 'RoomoteBot', bot: true },
    ]);

    // The normalized envelope must satisfy the API's real event schema —
    // this is the contract that quarantined events when the injected
    // mention was a bare id.
    const parsed = parseDiscordGatewayEvent({
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      payload: envelope.payload,
      receivedAt: envelope.receivedAt,
    });
    expect(parsed.success).toBe(true);
  });

  it('ignores mentions of roles that are not the bot managed role', async () => {
    const enqueue = vi.fn();
    const rest = { post: vi.fn() };

    await expect(
      handleGatewayDispatch(
        {
          t: 'MESSAGE_CREATE',
          d: {
            id: 'message-role-2',
            channel_id: 'channel-1',
            guild_id: 'guild-1',
            content: '<@&some-team-role> morning everyone',
            author: { id: 'user-1', username: 'dan', bot: false },
            mentions: [],
            mention_roles: ['some-team-role'],
          },
        },
        {
          enqueue,
          rest,
          now,
          getBotUserId: () => 'bot-1',
          getBotUsername: () => 'RoomoteBot',
          getBotRoleId: () => 'bot-role-1',
          getCachedChannel: () => ({
            id: 'channel-1',
            type: 0,
            isThread: false,
          }),
        },
      ),
    ).resolves.toBe('ignored');

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('keeps the user-mention-only behavior when the bot role is unknown', async () => {
    const enqueue = vi.fn();
    const rest = { post: vi.fn() };

    await expect(
      handleGatewayDispatch(
        {
          t: 'MESSAGE_CREATE',
          d: {
            id: 'message-role-3',
            channel_id: 'channel-1',
            guild_id: 'guild-1',
            content: '<@&bot-role-1> hello',
            author: { id: 'user-1', username: 'dan', bot: false },
            mentions: [],
            mention_roles: ['bot-role-1'],
          },
        },
        {
          enqueue,
          rest,
          now,
          getBotUserId: () => 'bot-1',
          getBotUsername: () => 'RoomoteBot',
          getCachedChannel: () => ({
            id: 'channel-1',
            type: 0,
            isThread: false,
          }),
        },
      ),
    ).resolves.toBe('ignored');

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('drops unmentioned guild root messages before they reach the queue', async () => {
    const enqueue = vi.fn();

    await expect(
      handleGatewayDispatch(
        {
          t: 'MESSAGE_CREATE',
          d: {
            id: 'message-root',
            channel_id: 'channel-root',
            guild_id: 'guild-1',
            content: 'talking to other people',
            author: { id: 'user-1' },
            mentions: [],
          },
        },
        {
          enqueue,
          rest: { post: vi.fn() },
          now,
          getBotUserId: () => 'bot-1',
          getCachedChannel: () => ({
            id: 'channel-root',
            type: 0,
            guildId: 'guild-1',
            name: 'general',
            isThread: false,
          }),
        },
      ),
    ).resolves.toBe('ignored');

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('forwards unmentioned guild messages from a monitored auto-start channel', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    const payload = {
      id: 'message-auto-1',
      channel_id: 'channel-bugs',
      guild_id: 'guild-1',
      content: 'the login page 500s on refresh',
      author: { id: 'user-1' },
      mentions: [],
    };

    await expect(
      handleGatewayDispatch(
        { t: 'MESSAGE_CREATE', d: payload },
        {
          enqueue,
          rest: { post: vi.fn() },
          now,
          getBotUserId: () => 'bot-1',
          getCachedChannel: () => ({
            id: 'channel-bugs',
            type: 0,
            guildId: 'guild-1',
            name: 'bugs',
            isThread: false,
          }),
          isAutoStartChannel: (channelId) => channelId === 'channel-bugs',
        },
      ),
    ).resolves.toBe('enqueued');

    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('forwards bot- and webhook-authored messages only from monitored channels', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    const dependencies = {
      enqueue,
      rest: { post: vi.fn() },
      now,
      getBotUserId: () => 'bot-1',
      getCachedChannel: () => ({
        id: 'channel-alerts',
        type: 0,
        guildId: 'guild-1',
        name: 'alerts',
        isThread: false,
      }),
      isAutoStartChannel: (channelId: string) => channelId === 'channel-alerts',
    };

    // Bot author in the monitored channel forwards.
    await expect(
      handleGatewayDispatch(
        {
          t: 'MESSAGE_CREATE',
          d: {
            id: 'message-bot-1',
            channel_id: 'channel-alerts',
            guild_id: 'guild-1',
            content: 'Deploy failed for api@1.2.3',
            author: { id: 'alert-bot', bot: true },
            mentions: [],
          },
        },
        dependencies,
      ),
    ).resolves.toBe('enqueued');

    // Webhook author (no author.bot flag) in the monitored channel forwards.
    await expect(
      handleGatewayDispatch(
        {
          t: 'MESSAGE_CREATE',
          d: {
            id: 'message-webhook-1',
            channel_id: 'channel-alerts',
            guild_id: 'guild-1',
            content: 'New Sentry issue: TypeError',
            author: { id: 'webhook-user' },
            webhook_id: 'webhook-1',
            mentions: [],
          },
        },
        dependencies,
      ),
    ).resolves.toBe('enqueued');

    // The same bot author outside any monitored channel still drops.
    await expect(
      handleGatewayDispatch(
        {
          t: 'MESSAGE_CREATE',
          d: {
            id: 'message-bot-2',
            channel_id: 'channel-other',
            guild_id: 'guild-1',
            content: 'Deploy failed for api@1.2.3',
            author: { id: 'alert-bot', bot: true },
            mentions: [],
          },
        },
        dependencies,
      ),
    ).resolves.toBe('ignored');

    // Roomote's own messages never forward, even from monitored channels.
    await expect(
      handleGatewayDispatch(
        {
          t: 'MESSAGE_CREATE',
          d: {
            id: 'message-own-1',
            channel_id: 'channel-alerts',
            guild_id: 'guild-1',
            content: 'Started a task for this alert.',
            author: { id: 'bot-1', bot: true },
            mentions: [],
          },
        },
        dependencies,
      ),
    ).resolves.toBe('ignored');

    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('treats an unknown guild channel conservatively until metadata is fetched', async () => {
    const enqueue = vi.fn();

    await expect(
      handleGatewayDispatch(
        {
          t: 'MESSAGE_CREATE',
          d: {
            id: 'message-unknown-channel',
            channel_id: 'channel-unknown',
            guild_id: 'guild-1',
            content: 'talking to other people',
            author: { id: 'user-1' },
            mentions: [],
          },
        },
        {
          enqueue,
          rest: { post: vi.fn() },
          now,
          getBotUserId: () => 'bot-1',
          getCachedChannel: () => undefined,
        },
      ),
    ).resolves.toBe('ignored');

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('durably forwards an unknown guild channel after Gateway lookup fails', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    const payload = {
      id: 'message-unknown-channel',
      channel_id: 'channel-unknown',
      guild_id: 'guild-1',
      content: 'natural task-thread follow-up',
      author: { id: 'user-1' },
      mentions: [],
    };

    await expect(
      handleGatewayDispatch(
        { t: 'MESSAGE_CREATE', d: payload },
        {
          enqueue,
          rest: { post: vi.fn() },
          now,
          getBotUserId: () => 'bot-1',
          getCachedChannel: () => undefined,
          enqueueUnknownGuildChannel: true,
        },
      ),
    ).resolves.toBe('enqueued');

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ payload }));
  });

  it('retains mentions in root channels and enriches cached channel data', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);

    await handleGatewayDispatch(
      {
        t: 'MESSAGE_CREATE',
        d: {
          id: 'message-mentioned',
          channel_id: 'channel-root',
          guild_id: 'guild-1',
          content: '<@bot-1> fix this',
          author: { id: 'user-1' },
          mentions: [{ id: 'bot-1' }],
        },
      },
      {
        enqueue,
        rest: { post: vi.fn() },
        now,
        getBotUserId: () => 'bot-1',
        getCachedChannel: () => ({
          id: 'channel-root',
          type: 0,
          guildId: 'guild-1',
          name: 'general',
          isThread: false,
        }),
      },
    );

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          channel: {
            id: 'channel-root',
            type: 0,
            guild_id: 'guild-1',
            name: 'general',
          },
        }),
      }),
    );
  });

  it('retains unmentioned thread messages and includes their parent', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);

    await handleGatewayDispatch(
      {
        t: 'MESSAGE_CREATE',
        d: {
          id: 'message-thread',
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          content: 'natural follow-up',
          author: { id: 'user-1' },
          mentions: [],
        },
      },
      {
        enqueue,
        rest: { post: vi.fn() },
        now,
        getBotUserId: () => 'bot-1',
        getCachedChannel: () => ({
          id: 'thread-1',
          type: 11,
          guildId: 'guild-1',
          parentId: 'channel-root',
          ownerId: 'bot-1',
          name: 'fix-the-bug',
          isThread: true,
        }),
      },
    );

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          channel: {
            id: 'thread-1',
            type: 11,
            guild_id: 'guild-1',
            parent_id: 'channel-root',
            owner_id: 'bot-1',
            name: 'fix-the-bug',
          },
        }),
      }),
    );
  });

  it('forwards unmentioned messages in non-bot-owned threads for API classification', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);

    await expect(
      handleGatewayDispatch(
        {
          t: 'MESSAGE_CREATE',
          d: {
            id: 'message-foreign-thread',
            channel_id: 'thread-foreign',
            guild_id: 'guild-1',
            content: 'conversation between other people',
            author: { id: 'user-1' },
            mentions: [],
          },
        },
        {
          enqueue,
          rest: { post: vi.fn() },
          now,
          getBotUserId: () => 'bot-1',
          getCachedChannel: () => ({
            id: 'thread-foreign',
            type: 11,
            guildId: 'guild-1',
            parentId: 'channel-root',
            ownerId: 'someone-else',
            name: 'other-thread',
            isThread: true,
          }),
        },
      ),
    ).resolves.toBe('enqueued');

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          channel: expect.objectContaining({
            id: 'thread-foreign',
            parent_id: 'channel-root',
            owner_id: 'someone-else',
          }),
        }),
      }),
    );
  });

  it('retains explicit bot mentions in threads owned by someone else', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);

    await expect(
      handleGatewayDispatch(
        {
          t: 'MESSAGE_CREATE',
          d: {
            id: 'message-mentioned-foreign-thread',
            channel_id: 'thread-foreign',
            guild_id: 'guild-1',
            content: '<@bot-1> help with this',
            author: { id: 'user-1' },
            mentions: [{ id: 'bot-1' }],
          },
        },
        {
          enqueue,
          rest: { post: vi.fn() },
          now,
          getBotUserId: () => 'bot-1',
          getCachedChannel: () => ({
            id: 'thread-foreign',
            type: 11,
            guildId: 'guild-1',
            parentId: 'channel-root',
            ownerId: 'someone-else',
            name: 'other-thread',
            isThread: true,
          }),
        },
      ),
    ).resolves.toBe('enqueued');

    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('retains direct messages without a mention', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);

    await handleGatewayDispatch(
      {
        t: 'MESSAGE_CREATE',
        d: {
          id: 'message-dm',
          channel_id: 'dm-1',
          content: 'hello',
          author: { id: 'user-1' },
          mentions: [],
        },
      },
      {
        enqueue,
        rest: { post: vi.fn() },
        now,
        getBotUserId: () => 'bot-1',
        getCachedChannel: () => ({
          id: 'dm-1',
          type: 1,
          isThread: false,
        }),
      },
    );

    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('defers application commands before enqueueing', async () => {
    const order: string[] = [];
    const rest = {
      post: vi.fn(async () => {
        order.push('defer');
      }),
    };
    const enqueue = vi.fn(async (_envelope: DiscordInboundEnvelope) => {
      order.push('enqueue');
      return true;
    });

    await expect(
      handleGatewayDispatch(
        {
          t: 'INTERACTION_CREATE',
          d: {
            id: 'interaction-1',
            token: 'callback-token',
            type: 2,
            data: { name: 'new' },
          },
        },
        { enqueue, rest, now },
      ),
    ).resolves.toBe('enqueued');

    expect(order).toEqual(['defer', 'enqueue']);
    expect(rest.post).toHaveBeenCalledWith(
      Routes.interactionCallback('interaction-1', 'callback-token'),
      { body: { type: 5 } },
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ interactionDeferred: true }),
    );
  });

  it.each(['link', 'help'])(
    'defers /%s commands ephemerally',
    async (commandName) => {
      const rest = { post: vi.fn().mockResolvedValue(undefined) };
      const enqueue = vi.fn().mockResolvedValue(true);

      await handleGatewayDispatch(
        {
          t: 'INTERACTION_CREATE',
          d: {
            id: `interaction-${commandName}`,
            token: 'callback-token',
            type: 2,
            data: { name: commandName },
          },
        },
        { enqueue, rest, now },
      );

      expect(rest.post).toHaveBeenCalledWith(expect.any(String), {
        body: { type: 5, data: { flags: 64 } },
      });
    },
  );

  it('defers message components with a deferred update', async () => {
    const rest = { post: vi.fn().mockResolvedValue(undefined) };
    const enqueue = vi.fn().mockResolvedValue(true);

    await handleGatewayDispatch(
      {
        t: 'INTERACTION_CREATE',
        d: { id: 'interaction-2', token: 'callback-token', type: 3 },
      },
      { enqueue, rest, now },
    );

    expect(rest.post).toHaveBeenCalledWith(expect.any(String), {
      body: { type: 6 },
    });
  });

  it('preserves edit-original semantics when replay sees an already-acknowledged interaction', async () => {
    const alreadyAcknowledged = Object.assign(
      new Error('Interaction has already been acknowledged'),
      { status: 400, code: 40060 },
    );
    const rest = {
      post: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(alreadyAcknowledged),
    };
    const enqueue = vi
      .fn()
      .mockRejectedValueOnce(new Error('Redis unavailable'))
      .mockResolvedValueOnce(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const packet = {
      t: 'INTERACTION_CREATE',
      d: { id: 'interaction-3', token: 'callback-token', type: 2 },
    };

    await expect(
      handleGatewayDispatch(packet, { enqueue, rest, now }),
    ).rejects.toThrow('Redis unavailable');
    await expect(
      handleGatewayDispatch(packet, { enqueue, rest, now }),
    ).resolves.toBe('enqueued');

    expect(enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ interactionDeferred: true }),
    );
    warn.mockRestore();
  });

  it('edits the original response first after an ambiguous defer failure', async () => {
    const rest = {
      post: vi.fn().mockRejectedValue(new Error('socket reset')),
    };
    const enqueue = vi.fn().mockResolvedValue(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleGatewayDispatch(
      {
        t: 'INTERACTION_CREATE',
        d: { id: 'interaction-4', token: 'callback-token', type: 2 },
      },
      { enqueue, rest, now },
    );

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ interactionDeferred: true }),
    );
    warn.mockRestore();
  });

  it('uses a channel reply after Discord definitively rejects the defer', async () => {
    const unknownInteraction = Object.assign(new Error('Unknown interaction'), {
      status: 404,
      code: 10062,
    });
    const rest = { post: vi.fn().mockRejectedValue(unknownInteraction) };
    const enqueue = vi.fn().mockResolvedValue(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handleGatewayDispatch(
      {
        t: 'INTERACTION_CREATE',
        d: { id: 'interaction-5', token: 'callback-token', type: 2 },
      },
      { enqueue, rest, now },
    );

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ interactionDeferred: false }),
    );
    warn.mockRestore();
  });

  it('reports duplicate events without reprocessing them', async () => {
    const enqueue = vi.fn().mockResolvedValue(false);

    await expect(
      handleGatewayDispatch(
        {
          t: 'MESSAGE_CREATE',
          d: { id: 'message-3', author: { id: 'user-1' } },
        },
        { enqueue, rest: { post: vi.fn() }, now },
      ),
    ).resolves.toBe('duplicate');
  });
});
