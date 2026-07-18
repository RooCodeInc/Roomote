import { describe, expect, it, vi } from 'vitest';

import { MockDiscordServer } from '../mock-discord-server';
import {
  chunkDiscordMessage,
  DiscordApiTransportError,
  DiscordCommunicationProvider,
  isDiscordUnknownMessageError,
} from '../discord-provider';

function createHarness() {
  const server = new MockDiscordServer();
  const sleep = vi.fn(async () => undefined);
  const provider = new DiscordCommunicationProvider({
    botToken: server.botToken,
    applicationId: server.application.id,
    apiBaseUrl: 'https://discord.example.test/api/v10',
    fetch: server.fetch as typeof fetch,
    nonceFactory: vi.fn(() => '123456789012345678'),
    sleep,
  });
  return { server, provider, sleep };
}

describe('DiscordCommunicationProvider', () => {
  it('chunks messages at 2000 characters and disables every allowed mention', async () => {
    const { server, provider } = createHarness();
    const channelId = '400000000000000001';
    const text = `${'a'.repeat(2_000)}${'b'.repeat(25)}`;

    const result = await provider.postMessage({
      channelId,
      text,
      buttons: [
        [
          { text: 'Follow task', url: 'https://roomote.example/tasks/1' },
          { text: 'Cancel', callbackData: 'cancel:1' },
        ],
      ],
      images: [
        {
          url: 'https://images.example/screenshot.png',
          altText: 'Screenshot',
        },
      ],
    });

    expect(result).toMatchObject({ provider: 'discord', channelId });
    const requests = server.state.requests.filter(
      (request) =>
        request.method === 'POST' && request.path.endsWith('/messages'),
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toMatchObject({
      content: 'a'.repeat(2_000),
      allowed_mentions: { parse: [] },
      nonce: '123456789012345678',
      enforce_nonce: true,
      embeds: [{ description: 'Screenshot' }],
    });
    // SUPPRESS_EMBEDS hides embeds the message carries itself, so a chunk
    // sending images must not set it.
    expect(requests[0]?.body).not.toHaveProperty('flags');
    expect(requests[1]?.body).toMatchObject({
      content: 'b'.repeat(25),
      allowed_mentions: { parse: [] },
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 5, label: 'Follow task' },
            { type: 2, style: 2, label: 'Cancel', custom_id: 'cancel:1' },
          ],
        },
      ],
    });
  });

  it('suppresses link unfurls on messages that carry no embeds of their own', async () => {
    // Discord unfurls any link into a preview card. Roomote posts task links
    // constantly, and Slack has always sent `unfurl_links: false`.
    const { server, provider } = createHarness();
    const channelId = '400000000000000001';

    await provider.postMessage({
      channelId,
      text: 'Open the task: https://roomote.example/tasks/1',
    });

    const posted = server.state.requests.find(
      (request) =>
        request.method === 'POST' && request.path.endsWith('/messages'),
    );
    expect(posted?.body).toMatchObject({ flags: 4 });
  });

  it('never rewrites flags while editing a message', async () => {
    // Editing `flags` replaces the whole bitfield. Discord retains embeds the
    // original carried, so suppressing on an edit would hide images that were
    // posted deliberately, and an interaction deferral's flags may carry
    // EPHEMERAL — rewriting them could expose an ephemeral reply.
    const { server, provider } = createHarness();
    const channelId = '400000000000000001';

    const sent = await provider.postMessage({ channelId, text: 'working' });
    await provider.editMessage({
      channelId,
      messageId: sent.messageId,
      text: 'Open the task: https://roomote.example/tasks/1',
    });
    await provider.editInteractionResponse({
      applicationId: '600000000000000001',
      interactionToken: 'token-1',
      text: 'Open the task: https://roomote.example/tasks/1',
    });

    for (const request of server.state.requests.filter(
      (candidate) => candidate.method === 'PATCH',
    )) {
      expect(request.body).not.toHaveProperty('flags');
    }
  });

  it('retries rate limits and deduplicates retried sends with a nonce', async () => {
    const { server, provider, sleep } = createHarness();
    server.enqueueRateLimit(0.01);

    await provider.postMessage({
      channelId: '400000000000000001',
      text: 'hello',
    });

    expect(server.state.requests).toHaveLength(2);
    expect(server.state.messages['400000000000000001']).toHaveLength(1);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('does not retry ambiguous thread creation server failures', async () => {
    const { server, provider } = createHarness();
    server.enqueueFailure({
      status: 500,
      body: { message: 'Temporary server failure' },
    });

    await expect(
      provider.createPublicThread({
        channelId: '400000000000000001',
        name: 'Fix the tests',
      }),
    ).rejects.toThrow('Temporary server failure');
    expect(server.state.requests).toHaveLength(1);
  });

  it('types exhausted network failures separately from Discord responses', async () => {
    const socketError = new TypeError('socket reset');
    const fetchMock = vi.fn().mockRejectedValue(socketError);
    const provider = new DiscordCommunicationProvider({
      botToken: 'discord-token',
      apiBaseUrl: 'https://discord.example.test/api/v10',
      fetch: fetchMock,
      maxRetries: 0,
    });

    const error = await provider
      .getChannel('400000000000000001')
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(DiscordApiTransportError);
    expect(error).toMatchObject({
      method: 'GET',
      path: '/channels/400000000000000001',
      cause: socketError,
    });
  });

  it('registers global slash commands and resolves bot/application identity', async () => {
    const { server, provider } = createHarness();

    await expect(provider.getBotInfo()).resolves.toMatchObject({
      id: server.bot.id,
      username: 'RoomoteBot',
    });
    await expect(provider.getApplicationInfo()).resolves.toMatchObject({
      id: server.application.id,
      name: 'Roomote',
    });
    await provider.registerCommands();

    expect(server.state.registeredCommands).toMatchObject([
      {
        name: 'new',
        type: 1,
        options: [expect.objectContaining({ name: 'request', required: true })],
      },
      { name: 'link', type: 1 },
      { name: 'help', type: 1 },
    ]);
  });

  it('lists destinations and reports effective channel permissions', async () => {
    const { server, provider } = createHarness();

    await expect(provider.listGuilds()).resolves.toEqual([
      {
        id: server.guildId,
        name: 'Mock Guild',
        icon: null,
        owner: false,
      },
    ]);
    await expect(provider.listGuildChannels(server.guildId)).resolves.toEqual([
      expect.objectContaining({
        id: '400000000000000001',
        name: 'roomote',
        type: 0,
      }),
    ]);
    await expect(
      provider.diagnoseChannelPermissions({
        guildId: server.guildId,
        channelId: '400000000000000001',
      }),
    ).resolves.toMatchObject({
      canUseChannel: true,
      missingPermissions: [],
      requiredPermissions: expect.arrayContaining([
        'view_channel',
        'send_messages',
        'read_message_history',
        'embed_links',
        'attach_files',
        'add_reactions',
        'create_public_threads',
        'send_messages_in_threads',
      ]),
      permissions: {
        view_channel: true,
        send_messages: true,
        send_messages_in_threads: true,
        create_public_threads: true,
        read_message_history: true,
        embed_links: true,
        attach_files: true,
        add_reactions: true,
      },
    });
  });

  it('treats a denied add_reactions overwrite as missing required channel permission', async () => {
    const { server, provider } = createHarness();
    const channelId = '400000000000000001';
    const addReactions = String(1n << 6n);
    server.addChannel({
      id: channelId,
      guild_id: server.guildId,
      name: 'no-reactions',
      type: 0,
      permission_overwrites: [
        {
          id: 'role-roomote',
          type: 0,
          allow: '0',
          deny: addReactions,
        },
      ],
    });

    await expect(
      provider.diagnoseChannelPermissions({
        guildId: server.guildId,
        channelId,
      }),
    ).resolves.toMatchObject({
      canUseChannel: false,
      missingPermissions: ['add_reactions'],
      permissions: { add_reactions: false },
    });
  });

  it('applies the everyone overwrite separately from member role overwrites', async () => {
    const { server, provider } = createHarness();
    const channelId = '400000000000000001';
    const sendMessages = String(1n << 11n);
    server.addChannel({
      id: channelId,
      guild_id: server.guildId,
      name: 'restricted',
      type: 0,
      permission_overwrites: [
        {
          id: server.guildId,
          type: 0,
          allow: sendMessages,
          deny: '0',
        },
        {
          id: 'role-roomote',
          type: 0,
          allow: '0',
          deny: sendMessages,
        },
      ],
    });

    await expect(
      provider.diagnoseChannelPermissions({
        guildId: server.guildId,
        channelId,
      }),
    ).resolves.toMatchObject({
      canUseChannel: false,
      missingPermissions: ['send_messages'],
      permissions: { send_messages: false },
    });
  });

  it('paginates the complete guild list before setup reconciliation', async () => {
    const guilds = Array.from({ length: 201 }, (_, index) => ({
      id: String(300_000_000_000_000_000n + BigInt(index)),
      name: `Guild ${index + 1}`,
      icon: null,
      owner: false,
    }));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      const after = url.searchParams.get('after');
      const startIndex = after
        ? guilds.findIndex((guild) => guild.id === after) + 1
        : 0;
      return new Response(
        JSON.stringify(guilds.slice(startIndex, startIndex + 200)),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const provider = new DiscordCommunicationProvider({
      botToken: 'discord-token',
      apiBaseUrl: 'https://discord.example.test/api/v10',
      fetch: fetchMock as typeof fetch,
    });

    await expect(provider.listGuilds()).resolves.toHaveLength(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/users/@me/guilds?limit=200',
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      `limit=200&after=${guilds[199]?.id}`,
    );
  });

  it('creates task threads for text channels and forum posts for forum channels', async () => {
    const { server, provider } = createHarness();

    const thread = await provider.createTaskThread({
      channelId: '400000000000000001',
      name: 'Build Discord support',
      initialText: 'Starting the task.',
    });
    expect(thread).toMatchObject({
      parentChannelId: '400000000000000001',
      name: 'Build Discord support',
      kind: 'thread',
    });
    expect(server.state.messages[thread.channelId]).toHaveLength(1);

    server.addChannel({
      id: '400000000000000005',
      guild_id: server.guildId,
      name: 'announcements',
      type: 5,
    });
    await provider.createTaskThread({
      channelId: '400000000000000005',
      name: 'Announcement task',
      initialText: 'Starting from announcements.',
    });
    expect(
      server.state.requests.find(
        (request) =>
          request.method === 'POST' &&
          request.path === '/channels/400000000000000005/threads',
      )?.body,
    ).toMatchObject({ type: 10 });

    server.addChannel({
      id: '400000000000000015',
      guild_id: server.guildId,
      name: 'tasks',
      type: 15,
    });
    const forumPost = await provider.createTaskThread({
      channelId: '400000000000000015',
      name: 'Forum task',
      initialText: 'a'.repeat(2_500),
    });
    expect(forumPost).toMatchObject({
      parentChannelId: '400000000000000015',
      kind: 'forum_post',
      messageId: expect.any(String),
    });
    const forumStarter =
      server.state.messages[forumPost.channelId]?.[0]?.content;
    expect(forumStarter).toHaveLength(2_000);
    expect(forumStarter?.endsWith('…')).toBe(true);
  });

  it('anchors threads to an existing message and recovers the thread on retry', async () => {
    const { provider } = createHarness();
    const channelId = '400000000000000001';
    const posted = await provider.postMessage({
      channelId,
      text: 'Please fix the login flow',
    });

    const thread = await provider.createThreadFromMessage({
      channelId,
      messageId: posted.messageId,
      name: 'Fix the login flow',
    });
    expect(thread).toMatchObject({
      channelId: posted.messageId,
      parentChannelId: channelId,
      name: 'Fix the login flow',
      kind: 'thread',
      messageId: posted.messageId,
    });

    // A message can only have one thread; a duplicate creation (e.g. an
    // ambiguous retry) recovers the existing thread instead of failing.
    const recovered = await provider.createThreadFromMessage({
      channelId,
      messageId: posted.messageId,
      name: 'Fix the login flow',
    });
    expect(recovered).toMatchObject({
      channelId: posted.messageId,
      parentChannelId: channelId,
      kind: 'thread',
      messageId: posted.messageId,
    });

    await expect(
      provider.createThreadFromMessage({
        channelId,
        messageId: '999999999999999999',
        name: 'Anchor on a deleted message',
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isDiscordUnknownMessageError(error),
    );
  });

  it('can resume a public-thread starter failure without creating another thread', async () => {
    const { server, provider } = createHarness();
    const thread = await provider.reserveTaskThread({
      channelId: '400000000000000001',
      name: 'Keep this thread',
      initialText: 'Starting the task.',
    });

    expect(server.state.messages[thread.channelId]).toHaveLength(0);
    server.enqueueFailure({
      status: 400,
      body: { message: 'Starter rejected' },
    });
    await expect(
      provider.completeTaskThread({
        thread,
        initialText: 'Starting the task.',
      }),
    ).rejects.toThrow('Starter rejected');

    const completed = await provider.completeTaskThread({
      thread,
      initialText: 'Starting the task.',
    });
    expect(completed).toMatchObject({
      channelId: thread.channelId,
      messageId: expect.any(String),
    });
    expect(
      server.state.requests.filter(
        (request) =>
          request.method === 'POST' &&
          request.path === '/channels/400000000000000001/threads',
      ),
    ).toHaveLength(1);
    expect(server.state.messages[thread.channelId]).toHaveLength(1);
  });

  it('reads history, edits, deletes, and reacts in a task channel', async () => {
    const { server, provider } = createHarness();
    const channelId = '400000000000000001';
    const sent = await provider.postMessage({ channelId, text: 'first' });
    await provider.editMessage({
      channelId,
      messageId: sent.messageId,
      text: 'edited',
    });
    await provider.addReaction({
      channelId,
      messageId: sent.messageId,
      name: '👀',
    });

    await expect(
      provider.fetchChannelMessages({ channelId }),
    ).resolves.toMatchObject({
      provider: 'discord',
      messageCount: 1,
      messages: [{ id: sent.messageId, text: 'edited' }],
    });
    await expect(
      provider.fetchThreadMessages({
        channelId,
        messageId: sent.messageId,
      }),
    ).resolves.toMatchObject({ matchedMessageIndex: 0, messageCount: 1 });
    expect(server.state.reactions).toEqual([
      { channelId, messageId: sent.messageId, emoji: '👀' },
    ]);

    await provider.deleteMessage({ channelId, messageId: sent.messageId });
    expect(server.state.messages[channelId]).toHaveLength(0);
  });

  it('maps Slack-style reaction names onto Discord unicode emoji', async () => {
    const { server, provider } = createHarness();
    const channelId = '400000000000000002';
    const sent = await provider.postMessage({ channelId, text: 'ack me' });

    for (const [name, emoji] of [
      ['eyes', '👀'],
      [':white_check_mark:', '✅'],
      ['x', '❌'],
      ['thumbsdown', '👎'],
      ['+1', '👍'],
    ] as const) {
      await provider.addReaction({
        channelId,
        messageId: sent.messageId,
        name,
      });
      expect(server.state.reactions.at(-1)).toEqual({
        channelId,
        messageId: sent.messageId,
        emoji,
      });
    }
  });

  it('defers and completes interaction responses without bot authorization', async () => {
    const { server, provider } = createHarness();

    await provider.deferInteraction({
      interactionId: 'interaction-1',
      interactionToken: 'secret-token',
      ephemeral: true,
    });
    await expect(
      provider.editInteractionResponse({
        applicationId: server.application.id,
        interactionToken: 'secret-token',
        text: 'Task started.',
      }),
    ).resolves.toEqual({
      provider: 'discord',
      channelId: 'interaction-channel',
      messageId: 'interaction-response',
    });
    await provider.deleteInteractionResponse({
      applicationId: server.application.id,
      interactionToken: 'secret-token',
    });

    const interactionRequests = server.state.requests.slice(-3);
    expect(interactionRequests[0]).toMatchObject({
      method: 'POST',
      body: { type: 5, data: { flags: 64 } },
    });
    expect(interactionRequests[1]).toMatchObject({
      method: 'PATCH',
      body: {
        content: 'Task started.',
        allowed_mentions: { parse: [] },
      },
    });
  });

  it('retains forum tags and rejects required-tag forums before creating a post', async () => {
    const { server, provider } = createHarness();
    const forumId = '400000000000000016';
    server.addChannel({
      id: forumId,
      guild_id: server.guildId,
      name: 'triage',
      type: 16,
      flags: 1 << 4,
      available_tags: [
        {
          id: '600000000000000001',
          name: 'Engineering',
          moderated: false,
          emoji_id: null,
          emoji_name: '🛠️',
        },
      ],
    });

    await expect(provider.getChannel(forumId)).resolves.toMatchObject({
      flags: 1 << 4,
      availableTags: [
        {
          id: '600000000000000001',
          name: 'Engineering',
          moderated: false,
          emojiId: null,
          emojiName: '🛠️',
        },
      ],
    });
    await expect(
      provider.diagnoseChannelPermissions({
        guildId: server.guildId,
        channelId: forumId,
      }),
    ).resolves.toMatchObject({
      canUseChannel: false,
      requiresTag: true,
      unsupportedReason: 'forum_requires_tag',
      availableTags: [expect.objectContaining({ name: 'Engineering' })],
    });
    await expect(
      provider.createTaskThread({
        channelId: forumId,
        name: 'Required tag task',
        initialText: 'This should not launch.',
      }),
    ).rejects.toThrow(
      'Roomote does not yet support Discord forum or media channels that require a tag.',
    );
    expect(
      server.state.requests.filter(
        (request) =>
          request.method === 'POST' &&
          request.path === `/channels/${forumId}/threads`,
      ),
    ).toHaveLength(0);
  });
});

describe('chunkDiscordMessage', () => {
  it('prefers newline boundaries without losing text', () => {
    expect(chunkDiscordMessage('first line\nsecond line', 12)).toEqual([
      'first line',
      'second line',
    ]);
  });
});
