import { Hono } from 'hono';
import {
  DiscordApiError,
  DiscordApiTransportError,
} from '@roomote/communication/discord-provider';

const mocks = vi.hoisted(() => ({
  claimEvent: vi.fn(),
  completeEvent: vi.fn(),
  releaseEvent: vi.fn(),
  resolveProvider: vi.fn(),
  findMappedUserId: vi.fn(),
  findInstallation: vi.fn(),
  consumeLinkCode: vi.fn(),
  restoreLinkCode: vi.fn(),
  upsertUserMapping: vi.fn(),
  upsertInstallation: vi.fn(),
  findActiveRun: vi.fn(),
  findCompletedRun: vi.fn(),
  findSourceRun: vi.fn(),
  processAttachments: vi.fn(),
  queueMessage: vi.fn(),
  setLatestInbound: vi.fn(),
  syncActingUser: vi.fn(),
  resumeTask: vi.fn(),
  startNewTask: vi.fn(),
  reply: vi.fn(),
  component: vi.fn(),
  getTaskUrl: vi.fn(),
  getChannel: vi.fn(),
  addReaction: vi.fn(),
  channelAutoStart: vi.fn(),
}));

vi.mock('../event-gate.js', () => ({
  claimDiscordApiEvent: mocks.claimEvent,
  completeDiscordApiEvent: mocks.completeEvent,
  releaseDiscordApiEvent: mocks.releaseEvent,
}));

vi.mock('../provider.js', () => {
  class DiscordProviderNotConfiguredError extends Error {}
  return {
    DiscordProviderNotConfiguredError,
    resolveDiscordProvider: mocks.resolveProvider,
  };
});

vi.mock('@roomote/sdk/server', () => ({
  findDiscordMappedUserId: mocks.findMappedUserId,
  findDiscordInstallationByGuildId: mocks.findInstallation,
  consumeDiscordLinkCode: mocks.consumeLinkCode,
  restoreDiscordLinkCode: mocks.restoreLinkCode,
  upsertDiscordUserMapping: mocks.upsertUserMapping,
  upsertDiscordInstallation: mocks.upsertInstallation,
}));

vi.mock('../../tasks/communication-task-run-lookup.js', () => ({
  findActiveCommunicationTaskRun: mocks.findActiveRun,
  findCompletedCommunicationTaskRunWithSnapshot: mocks.findCompletedRun,
  findCommunicationTaskRunBySourceEvent: mocks.findSourceRun,
}));

vi.mock('../attachments.js', () => ({
  processDiscordAttachments: mocks.processAttachments,
}));

vi.mock('../channel-auto-start.js', () => ({
  maybeHandleDiscordChannelAutoStart: mocks.channelAutoStart,
}));

vi.mock('@roomote/communication/messages', () => ({
  queueCommunicationMessageOnce: mocks.queueMessage,
  setLatestInboundMessageId: mocks.setLatestInbound,
}));

vi.mock('../../tasks/acting-user-sync.js', () => ({
  syncActingUserForInboundMessage: mocks.syncActingUser,
}));

vi.mock('../../tasks/communication-snapshot-resume.js', () => ({
  resumeCommunicationTaskFromSnapshot: mocks.resumeTask,
}));

vi.mock('../task-orchestration.js', () => ({
  startNewDiscordTask: mocks.startNewTask,
}));

vi.mock('../replies.js', () => ({ replyToDiscordEvent: mocks.reply }));

vi.mock('../callback-actions.js', () => ({
  handleDiscordComponentInteraction: mocks.component,
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  getTaskUrl: mocks.getTaskUrl,
}));

import { discord } from '../index.js';

const app = new Hono();
app.route('/api/internal/discord', discord);

const provider = {
  getChannel: mocks.getChannel,
  addReaction: mocks.addReaction,
};

function envelope(
  payload: Record<string, unknown>,
  eventType = 'MESSAGE_CREATE',
) {
  return {
    eventId: String(payload.id),
    eventType,
    payload,
    receivedAt: '2026-07-12T15:00:00.000Z',
    ...(eventType === 'INTERACTION_CREATE'
      ? { interactionDeferred: true }
      : {}),
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 'message-1',
    channel_id: 'dm-1',
    content: 'Fix the flaky tests',
    author: { id: 'discord-user-1', username: 'matt' },
    mentions: [],
    attachments: [],
    ...overrides,
  };
}

async function postEvent(body: unknown, secret = 'gateway-secret') {
  return app.request('http://localhost/api/internal/discord/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-roomote-discord-gateway-secret': secret,
    },
    body: JSON.stringify(body),
  });
}

describe('Discord Gateway event handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.R_DISCORD_GATEWAY_SECRET = 'gateway-secret';
    mocks.claimEvent.mockResolvedValue({
      status: 'claimed',
      token: 'claim-token',
    });
    mocks.completeEvent.mockResolvedValue(true);
    mocks.releaseEvent.mockResolvedValue(undefined);
    mocks.resolveProvider.mockResolvedValue({
      applicationId: 'app-1',
      botToken: 'never-exposed-token',
      botUserId: 'bot-1',
      provider,
    });
    mocks.getChannel.mockResolvedValue({
      id: 'dm-1',
      name: 'Direct message',
      type: 1,
    });
    mocks.upsertInstallation.mockResolvedValue(undefined);
    mocks.upsertUserMapping.mockResolvedValue(undefined);
    mocks.findMappedUserId.mockResolvedValue('roomote-user-1');
    mocks.findInstallation.mockResolvedValue(null);
    mocks.findActiveRun.mockResolvedValue(undefined);
    mocks.findCompletedRun.mockResolvedValue(null);
    mocks.findSourceRun.mockResolvedValue(null);
    mocks.processAttachments.mockResolvedValue({
      images: [],
      attachmentTexts: [],
      warnings: [],
    });
    mocks.startNewTask.mockResolvedValue({
      status: 'started',
      launchResult: { id: 17, taskId: 'task-17' },
    });
    mocks.reply.mockResolvedValue({ messageId: 'reply-1' });
    mocks.component.mockResolvedValue('handled');
    mocks.channelAutoStart.mockResolvedValue(false);
  });

  afterEach(() => {
    delete process.env.R_DISCORD_GATEWAY_SECRET;
  });

  it('rejects an invalid Gateway secret before claiming the event', async () => {
    const response = await postEvent(envelope(message()), 'wrong-secret');

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'discord_gateway_unauthorized',
    });
    expect(mocks.claimEvent).not.toHaveBeenCalled();
  });

  it('returns 409 for an event already processed by the API', async () => {
    mocks.claimEvent.mockResolvedValue({ status: 'completed' });

    const response = await postEvent(envelope(message()));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      duplicate: true,
    });
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
  });

  it('returns a retryable response while another delivery is processing', async () => {
    mocks.claimEvent.mockResolvedValue({ status: 'processing' });

    const response = await postEvent(envelope(message()));

    expect(response.status).toBe(425);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'discord_event_in_progress',
    });
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a network failure',
      new DiscordApiTransportError({
        method: 'GET',
        path: '/channels/dm-1',
        cause: new TypeError('socket reset'),
      }),
    ],
    [
      'a Discord rate limit',
      new DiscordApiError({
        method: 'GET',
        path: '/channels/dm-1',
        status: 429,
        message: 'Rate limited',
      }),
    ],
    [
      'a Discord outage',
      new DiscordApiError({
        method: 'GET',
        path: '/channels/dm-1',
        status: 502,
        message: 'Bad gateway',
      }),
    ],
  ])(
    'returns 503 for %s so the Gateway retains the event',
    async (_label, error) => {
      mocks.getChannel.mockRejectedValueOnce(error);

      const response = await postEvent(envelope(message()));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: 'discord_api_unavailable',
      });
      expect(mocks.releaseEvent).toHaveBeenCalledWith({
        eventType: 'MESSAGE_CREATE',
        eventId: 'message-1',
        token: 'claim-token',
      });
      expect(mocks.completeEvent).not.toHaveBeenCalled();
    },
  );

  it.each([403, 404])(
    'acknowledges an event whose Discord resource returns %s',
    async (status) => {
      mocks.getChannel.mockRejectedValueOnce(
        new DiscordApiError({
          method: 'GET',
          path: '/channels/dm-1',
          status,
          message: status === 403 ? 'Missing access' : 'Unknown channel',
        }),
      );

      const response = await postEvent(envelope(message()));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        ignored: 'discord_resource_unavailable',
      });
      expect(mocks.completeEvent).toHaveBeenCalledWith({
        eventType: 'MESSAGE_CREATE',
        eventId: 'message-1',
        token: 'claim-token',
      });
      expect(mocks.releaseEvent).not.toHaveBeenCalled();
    },
  );

  it('launches a linked DM request through the Discord task orchestrator', async () => {
    const response = await postEvent(envelope(message()));

    expect(response.status).toBe(200);
    expect(mocks.completeEvent).toHaveBeenCalledWith({
      eventType: 'MESSAGE_CREATE',
      eventId: 'message-1',
      token: 'claim-token',
    });
    expect(mocks.startNewTask).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterDiscordUserId: 'discord-user-1',
        launchOwnerUserId: 'roomote-user-1',
        queuedMessage: expect.objectContaining({
          provider: 'discord',
          text: 'Fix the flaky tests',
          userId: 'roomote-user-1',
        }),
        metadata: {
          communicationProvider: 'discord',
          communicationChannelId: 'dm-1',
          communicationMessageId: 'message-1',
          // A real channel message carries an anchor for its task thread.
          communicationAnchorMessageId: 'message-1',
        },
      }),
    );
  });

  it('treats an attachment-only DM as a task entry and passes safe image data', async () => {
    const attachment = {
      id: 'attachment-1',
      filename: 'screen.png',
      content_type: 'image/png',
      size: 4,
      url: 'https://cdn.discordapp.com/attachments/1/2/screen.png?sig=signed',
    };
    mocks.processAttachments.mockResolvedValue({
      images: ['data:image/png;base64,aW1n'],
      attachmentTexts: [],
      warnings: [],
    });

    const response = await postEvent(
      envelope(message({ content: '', attachments: [attachment] })),
    );

    expect(response.status).toBe(200);
    expect(mocks.processAttachments).toHaveBeenCalledWith([attachment]);
    expect(mocks.startNewTask).toHaveBeenCalledWith(
      expect.objectContaining({
        queuedMessage: expect.objectContaining({
          text: 'Image: screen.png',
          images: ['data:image/png;base64,aW1n'],
        }),
      }),
    );
    expect(JSON.stringify(mocks.startNewTask.mock.calls)).not.toContain(
      'cdn.discordapp.com',
    );
    expect(JSON.stringify(mocks.startNewTask.mock.calls)).not.toContain(
      'never-exposed-token',
    );
  });

  it('queues an ordinary message in an active Discord task thread', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'thread-1',
      guildId: 'guild-1',
      parentId: 'channel-1',
      name: 'Fix tests',
      type: 11,
    });
    mocks.findActiveRun.mockResolvedValue({
      id: 23,
      actingUserId: 'roomote-user-1',
    });

    const response = await postEvent(
      envelope(
        message({
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          content: 'Also fix the type error',
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.queueMessage).toHaveBeenCalledWith(
      'discord',
      23,
      expect.objectContaining({ text: 'Also fix the type error' }),
    );
    expect(mocks.setLatestInbound).toHaveBeenCalledWith(
      'discord',
      23,
      'message-1',
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('does not redeliver a DM launch request as a follow-up after task creation', async () => {
    mocks.findActiveRun.mockResolvedValue({ id: 23 });
    mocks.findSourceRun.mockResolvedValue({ id: 23, taskId: 'task-23' });
    mocks.getTaskUrl.mockReturnValue('https://roomote.example/task/task-23');

    const response = await postEvent(envelope(message()));

    expect(response.status).toBe(200);
    expect(mocks.queueMessage).not.toHaveBeenCalled();
    expect(mocks.startNewTask).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('task-23') }),
    );
  });

  it('nudges an unlinked mentioned user without launching work', async () => {
    mocks.findMappedUserId.mockResolvedValue(null);
    mocks.getChannel.mockResolvedValue({
      id: 'channel-1',
      guildId: 'guild-1',
      name: 'general',
      type: 0,
    });

    const response = await postEvent(
      envelope(
        message({
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          content: '<@bot-1> fix this',
          mentions: [{ id: 'bot-1', username: 'Roomote', bot: true }],
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('/link') }),
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('lets channel auto-start consume a message before mention gating', async () => {
    mocks.channelAutoStart.mockResolvedValue(true);
    mocks.getChannel.mockResolvedValue({
      id: 'channel-1',
      guildId: 'guild-1',
      name: 'bugs',
      type: 0,
    });

    const response = await postEvent(
      envelope(
        message({
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          content: 'The login page 500s on refresh',
        }),
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ ok: true, channelAutoStart: true }),
    );
    expect(mocks.channelAutoStart).toHaveBeenCalledWith(
      expect.objectContaining({ botUserId: 'bot-1' }),
    );
    // Consumed entirely by auto-start: no mention gating, no reply, no launch.
    expect(mocks.startNewTask).not.toHaveBeenCalled();
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it('offers bot-authored messages to channel auto-start instead of dropping them outright', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'channel-1',
      guildId: 'guild-1',
      name: 'alerts',
      type: 0,
    });

    const response = await postEvent(
      envelope(
        message({
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          content: 'Deploy failed for api@1.2.3',
          author: { id: 'alert-bot', username: 'alerts', bot: true },
        }),
      ),
    );

    expect(response.status).toBe(200);
    // The auto-start hook saw it (and declined) before the bot early-return.
    expect(mocks.channelAutoStart).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ ignored: 'bot_or_missing_sender' }),
    );
  });

  it('invalidates stale destination state when the configured bot identity changed', async () => {
    mocks.findInstallation.mockResolvedValue({
      guildId: 'guild-1',
      guildName: 'Engineering',
      applicationId: 'old-app',
      botUserId: 'old-bot',
    });
    mocks.getChannel.mockResolvedValue({
      id: 'channel-1',
      guildId: 'guild-1',
      name: 'general',
      type: 0,
    });

    const response = await postEvent(
      envelope(
        message({
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          content: '<@bot-1> fix this',
          mentions: [{ id: 'bot-1', username: 'Roomote', bot: true }],
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.upsertInstallation).toHaveBeenCalledWith({
      guildId: 'guild-1',
      guildName: 'Engineering',
      applicationId: 'app-1',
      botUserId: 'bot-1',
    });
  });

  it('handles deferred /help commands ephemerally', async () => {
    const interaction = {
      id: 'interaction-1',
      application_id: 'app-1',
      type: 2,
      token: 'interaction-token',
      channel_id: 'dm-1',
      user: { id: 'discord-user-1', username: 'matt' },
      data: { name: 'help', type: 1 },
    };

    const response = await postEvent(
      envelope(interaction, 'INTERACTION_CREATE'),
    );

    expect(response.status).toBe(200);
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        interaction: {
          interaction,
          interactionDeferred: true,
        },
        ephemeral: true,
        text: expect.stringContaining('/new'),
      }),
    );
  });

  it('uses /new to start fresh even when the DM has an active task', async () => {
    mocks.findActiveRun.mockResolvedValue({ id: 23 });
    const interaction = {
      id: 'interaction-new',
      application_id: 'app-1',
      type: 2,
      token: 'interaction-token',
      channel_id: 'dm-1',
      user: { id: 'discord-user-1', username: 'matt' },
      data: {
        name: 'new',
        type: 1,
        options: [
          { name: 'request', type: 3, value: 'Build a fresh dashboard' },
        ],
      },
    };

    const response = await postEvent(
      envelope(interaction, 'INTERACTION_CREATE'),
    );

    expect(response.status).toBe(200);
    expect(mocks.findActiveRun).not.toHaveBeenCalled();
    expect(mocks.queueMessage).not.toHaveBeenCalled();
    expect(mocks.startNewTask).toHaveBeenCalledWith(
      expect.objectContaining({
        queuedMessage: expect.objectContaining({
          text: 'Build a fresh dashboard',
        }),
        interaction: { interaction, interactionDeferred: true },
        forceNewThread: true,
      }),
    );
  });

  it('creates a sibling task thread for a mention in an unrelated thread', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'discussion-thread',
      guildId: 'guild-1',
      parentId: 'channel-1',
      name: 'General discussion',
      type: 11,
    });

    const response = await postEvent(
      envelope(
        message({
          channel_id: 'discussion-thread',
          guild_id: 'guild-1',
          content: '<@bot-1> investigate the flaky build',
          mentions: [{ id: 'bot-1', username: 'Roomote', bot: true }],
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.startNewTask).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: expect.objectContaining({
          channelId: 'discussion-thread',
          parentChannelId: 'channel-1',
          isThread: true,
        }),
        forceNewThread: true,
      }),
    );
  });

  it('resumes a completed thread snapshot when a linked user follows up', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'thread-1',
      guildId: 'guild-1',
      parentId: 'channel-1',
      name: 'Completed task',
      type: 11,
    });
    const completedRun = {
      id: 31,
      payload: {},
      port: null,
      snapshotId: 'snapshot-1',
    };
    mocks.findCompletedRun.mockResolvedValue(completedRun);
    mocks.resumeTask.mockResolvedValue({ id: 32, taskId: 'task-32' });
    mocks.getTaskUrl.mockReturnValue('https://roomote.example/tasks/task-32');

    const response = await postEvent(
      envelope(
        message({
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          content: 'Make one more change',
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.resumeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'discord',
        completedRun,
        channelId: 'channel-1',
        threadId: 'thread-1',
        guildId: 'guild-1',
        preservePayloadFlags: ['discordTaskThread'],
      }),
    );
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('task-32'),
      }),
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('links a Discord user with a one-shot /link code', async () => {
    mocks.consumeLinkCode.mockResolvedValue('roomote-user-1');
    const interaction = {
      id: 'interaction-link',
      application_id: 'app-1',
      type: 2,
      token: 'interaction-token',
      channel_id: 'dm-1',
      user: { id: 'discord-user-1', username: 'matt' },
      data: {
        name: 'link',
        type: 1,
        options: [{ name: 'code', type: 3, value: 'link-abcdefghijklmnop' }],
      },
    };

    const response = await postEvent(
      envelope(interaction, 'INTERACTION_CREATE'),
    );

    expect(response.status).toBe(200);
    expect(mocks.upsertUserMapping).toHaveBeenCalledWith({
      discordUserId: 'discord-user-1',
      discordUsername: 'matt',
      discordGlobalName: null,
      discordDmChannelId: 'dm-1',
      userId: 'roomote-user-1',
    });
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('✅ Linked!') }),
    );
  });

  it('requires /link in a DM without consuming the one-shot code', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'channel-1',
      name: 'general',
      type: 0,
      guild_id: 'guild-1',
    });
    const interaction = {
      id: 'interaction-link-guild',
      application_id: 'app-1',
      type: 2,
      token: 'interaction-token',
      channel_id: 'channel-1',
      guild_id: 'guild-1',
      member: {
        user: { id: 'discord-user-1', username: 'matt' },
      },
      data: {
        name: 'link',
        type: 1,
        options: [{ name: 'code', type: 3, value: 'link-abcdefghijklmnop' }],
      },
    };

    const response = await postEvent(
      envelope(interaction, 'INTERACTION_CREATE'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      linked: false,
      reason: 'link_requires_dm',
    });
    expect(mocks.consumeLinkCode).not.toHaveBeenCalled();
    expect(mocks.upsertUserMapping).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        text: expect.stringContaining('direct message'),
      }),
    );
  });

  it('dispatches component interactions to the callback handler', async () => {
    const interaction = {
      id: 'interaction-button',
      application_id: 'app-1',
      type: 3,
      token: 'interaction-token',
      channel_id: 'dm-1',
      user: { id: 'discord-user-1', username: 'matt' },
      data: { custom_id: 'discord:cancel:17', component_type: 2 },
    };

    const response = await postEvent(
      envelope(interaction, 'INTERACTION_CREATE'),
    );

    expect(response.status).toBe(200);
    expect(mocks.component).toHaveBeenCalledWith({
      provider,
      applicationId: 'app-1',
      interaction,
      interactionDeferred: true,
      channel: expect.objectContaining({ channelId: 'dm-1' }),
    });
  });
});
