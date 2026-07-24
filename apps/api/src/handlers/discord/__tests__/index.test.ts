import { Hono } from 'hono';
import {
  DiscordApiError,
  DiscordApiTransportError,
} from '@roomote/communication/discord-provider';

import { accountLinkDmInFlightWait } from '../account-link.js';

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
  findAutomationReportRun: vi.fn(),
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
  removeReaction: vi.fn(),
  createDirectMessage: vi.fn(),
  postMessage: vi.fn(),
  channelAutoStart: vi.fn(),
  findPendingRoutingReply: vi.fn(),
  hasPendingRouteCallback: vi.fn(),
  handleRoutingReply: vi.fn(),
  attachOutOfBand: vi.fn(),
  releaseOutOfBand: vi.fn(),
  redisSet: vi.fn(),
  redisGet: vi.fn(),
  redisDel: vi.fn(),
  buildContinuation: vi.fn(),
  releaseContinuation: vi.fn(),
  markThreadHistoryDelivered: vi.fn(),
  fetchThreadHistory: vi.fn(),
  shouldRouteUnmentioned: vi.fn(),
  enqueueGatewayEvent: vi.fn(),
}));

vi.mock('@roomote/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/redis')>();
  return {
    ...actual,
    getRedis: () => ({
      set: mocks.redisSet,
      get: mocks.redisGet,
      del: mocks.redisDel,
    }),
  };
});

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
  enqueueDiscordGatewayEvent: mocks.enqueueGatewayEvent,
  claimPendingPrReviewActionsForThread: vi.fn(async () => []),
}));

vi.mock('@roomote/sdk/server/communication', () => ({
  findActiveCommunicationTaskRun: mocks.findActiveRun,
  findCompletedCommunicationTaskRunWithSnapshot: mocks.findCompletedRun,
  findTaskBackedAutomationReportRun: mocks.findAutomationReportRun,
  findCommunicationTaskRunBySourceEvent: mocks.findSourceRun,
  resumeCommunicationTaskFromSnapshot: mocks.resumeTask,
  attachOutOfBandContextToCommunicationMessage: mocks.attachOutOfBand,
  releaseCommunicationOutOfBandClaim: mocks.releaseOutOfBand,
}));

vi.mock('../attachments.js', () => ({
  processDiscordAttachments: mocks.processAttachments,
}));

vi.mock('../channel-auto-start.js', () => ({
  maybeHandleDiscordChannelAutoStart: mocks.channelAutoStart,
}));

vi.mock('../routing-confirmation.js', () => ({
  findDiscordPendingRoutingReply: mocks.findPendingRoutingReply,
  hasPendingDiscordRouteCallback: mocks.hasPendingRouteCallback,
  handleDiscordRoutingReply: mocks.handleRoutingReply,
}));

vi.mock('@roomote/communication/messages', () => ({
  queueCommunicationMessageOnce: mocks.queueMessage,
  setLatestInboundMessageId: mocks.setLatestInbound,
}));

vi.mock('../../tasks/acting-user-sync.js', () => ({
  syncActingUserForInboundMessage: mocks.syncActingUser,
}));

vi.mock('../thread-context.js', () => ({
  buildDiscordContinuationPrompt: mocks.buildContinuation,
  fetchDiscordThreadHistoryBestEffort: mocks.fetchThreadHistory,
  releaseDiscordContinuationClaim: mocks.releaseContinuation,
  markDiscordThreadHistoryDelivered: mocks.markThreadHistoryDelivered,
}));

vi.mock('../unmentioned-thread-reply.js', () => ({
  shouldRouteUnmentionedDiscordThreadReplyToAgent: mocks.shouldRouteUnmentioned,
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
  removeReaction: mocks.removeReaction,
  createDirectMessage: mocks.createDirectMessage,
  postMessage: mocks.postMessage,
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
  return app.request('http://localhost/api/internal/discord/events/process', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-roomote-discord-gateway-secret': secret,
    },
    body: JSON.stringify(body),
  });
}

async function postIngressEvent(body: unknown, secret = 'gateway-secret') {
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
    mocks.findAutomationReportRun.mockResolvedValue(null);
    mocks.findSourceRun.mockResolvedValue(null);
    mocks.removeReaction.mockResolvedValue(undefined);
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
    mocks.createDirectMessage.mockResolvedValue({ id: 'dm-private-1' });
    mocks.postMessage.mockResolvedValue({ messageId: 'dm-msg-1' });
    mocks.redisSet.mockResolvedValue('OK');
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisDel.mockResolvedValue(1);
    mocks.component.mockResolvedValue('handled');
    mocks.channelAutoStart.mockResolvedValue(false);
    mocks.findPendingRoutingReply.mockResolvedValue(null);
    mocks.hasPendingRouteCallback.mockResolvedValue(null);
    mocks.handleRoutingReply.mockResolvedValue(false);
    mocks.attachOutOfBand.mockImplementation(
      async ({ message }: { message: Record<string, unknown> }) => ({
        message,
        claim: null,
      }),
    );
    mocks.releaseOutOfBand.mockResolvedValue(undefined);
    mocks.buildContinuation.mockImplementation(
      async ({
        queuedMessage,
      }: {
        queuedMessage: Record<string, unknown>;
      }) => ({
        message: {
          ...queuedMessage,
          formattedPrompt: `<thread_context>\nearlier\n</thread_context>\n\n${queuedMessage.text}`,
          turnPolicy: { reactionsAllowed: true },
        },
        claimedMessageIds: ['100'],
        channelId: 'thread-1',
      }),
    );
    mocks.releaseContinuation.mockResolvedValue(undefined);
    mocks.markThreadHistoryDelivered.mockResolvedValue(undefined);
    mocks.fetchThreadHistory.mockResolvedValue([]);
    mocks.shouldRouteUnmentioned.mockResolvedValue(true);
    mocks.queueMessage.mockResolvedValue(true);
    mocks.enqueueGatewayEvent.mockResolvedValue({ jobId: 'event-message-1' });
  });

  afterEach(() => {
    delete process.env.R_DISCORD_GATEWAY_SECRET;
  });

  it('treats an unmentioned task-thread message as a pending routing reply', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'thread-1',
      name: 'Fix the flaky tests',
      type: 11,
      guildId: 'guild-1',
      parentId: 'channel-1',
    });
    mocks.findPendingRoutingReply.mockResolvedValue({
      pendingRouteId: 'pending-route-1',
    });
    mocks.handleRoutingReply.mockResolvedValue(true);

    const response = await postEvent(
      envelope(
        message({
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          content: 'use API instead',
          channel: {
            id: 'thread-1',
            type: 11,
            guild_id: 'guild-1',
            parent_id: 'channel-1',
          },
        }),
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      routingReplyHandled: true,
    });
    expect(mocks.handleRoutingReply).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingRouteId: 'pending-route-1',
        queuedMessage: expect.objectContaining({ text: 'use API instead' }),
      }),
    );
    expect(mocks.addReaction).toHaveBeenCalledWith({
      channelId: 'thread-1',
      messageId: 'message-1',
      name: '👀',
    });
    expect(mocks.removeReaction).toHaveBeenCalledWith({
      channelId: 'thread-1',
      messageId: 'message-1',
      name: 'eyes',
    });
    expect(mocks.startNewTask).not.toHaveBeenCalled();
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

  it('durably queues a valid event without invoking its processing pipeline', async () => {
    const body = envelope(message());

    const response = await postIngressEvent(body);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, queued: true });
    expect(mocks.enqueueGatewayEvent).toHaveBeenCalledWith(body);
    expect(mocks.claimEvent).not.toHaveBeenCalled();
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
  });

  it('rejects unauthorized ingress before enqueueing', async () => {
    const response = await postIngressEvent(
      envelope(message()),
      'wrong-secret',
    );

    expect(response.status).toBe(401);
    expect(mocks.enqueueGatewayEvent).not.toHaveBeenCalled();
  });

  it('rejects invalid ingress payloads before enqueueing', async () => {
    const response = await postIngressEvent({ eventType: 'MESSAGE_CREATE' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'invalid_discord_event',
    });
    expect(mocks.enqueueGatewayEvent).not.toHaveBeenCalled();
  });

  it('returns 503 when durable event enqueueing fails', async () => {
    mocks.enqueueGatewayEvent.mockRejectedValue(new Error('Redis unavailable'));

    const response = await postIngressEvent(envelope(message()));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'discord_event_enqueue_failed',
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
    expect(mocks.addReaction).toHaveBeenCalledWith({
      channelId: 'dm-1',
      messageId: 'message-1',
      name: '👀',
    });
    expect(mocks.startNewTask).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterDiscordUserId: 'discord-user-1',
        launchOwnerUserId: 'roomote-user-1',
        intakeAckPinned: true,
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

  it('forwards message_reference into startNewDiscordTask for channel reply mentions', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'channel-1',
      guildId: 'guild-1',
      name: 'general',
      type: 0,
    });
    const response = await postEvent(
      envelope(
        message({
          id: 'message-2',
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          content: '<@bot-1> can you check if this issue already exists?',
          mentions: [{ id: 'bot-1', username: 'roomote' }],
          message_reference: {
            message_id: 'message-parent',
            channel_id: 'channel-1',
          },
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.startNewTask).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: 'message-parent',
        replyToChannelId: 'channel-1',
        queuedMessage: expect.objectContaining({
          ts: 'message-2',
        }),
      }),
    );
  });

  it('treats an unmentioned reply to an announcer report root as a task entry', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'channel-1',
      guildId: 'guild-1',
      name: 'general',
      type: 0,
    });
    mocks.findAutomationReportRun.mockResolvedValue({
      id: 11,
      taskId: 'announcer-task',
      userId: null,
    });

    const response = await postEvent(
      envelope(
        message({
          id: 'message-2',
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          content: 'Could you expand on the migration note?',
          message_reference: {
            message_id: 'announcer-root',
            channel_id: 'channel-1',
          },
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.findAutomationReportRun).toHaveBeenCalledWith({
      provider: 'discord',
      channelId: 'channel-1',
      messageId: 'announcer-root',
    });
    expect(mocks.shouldRouteUnmentioned).toHaveBeenCalledWith(
      expect.objectContaining({
        isRoomoteThread: true,
        ownedThreadUserId: null,
        isAutomationReportThread: true,
      }),
    );
    expect(mocks.startNewTask).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: 'announcer-root' }),
    );
  });

  it('routes an exact active announcer root ahead of a newer run in the channel', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'channel-1',
      guildId: 'guild-1',
      name: 'general',
      type: 0,
    });
    mocks.findAutomationReportRun.mockResolvedValue({
      id: 11,
      status: 'running',
      taskId: 'announcer-task-one',
      userId: 'roomote-user-1',
    });
    mocks.findActiveRun.mockResolvedValue({
      id: 22,
      status: 'running',
      taskId: 'announcer-task-two',
    });

    const response = await postEvent(
      envelope(
        message({
          id: 'message-2',
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          content: '<@bot-1> follow up on the first report',
          mentions: [{ id: 'bot-1', username: 'roomote' }],
          message_reference: {
            message_id: 'announcer-root-one',
            channel_id: 'channel-1',
          },
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.queueMessage).toHaveBeenCalledWith(
      'discord',
      11,
      expect.objectContaining({ text: 'follow up on the first report' }),
    );
    expect(mocks.findActiveRun).not.toHaveBeenCalled();
  });

  it('resumes an exact announcer root snapshot ahead of a newer run in the channel', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'channel-1',
      guildId: 'guild-1',
      name: 'general',
      type: 0,
    });
    const reportRun = {
      id: 11,
      status: 'completed',
      taskId: 'announcer-task-one',
      payload: {},
      port: null,
      snapshotId: 'snapshot-one',
      snapshotCreatedAt: new Date(),
    };
    mocks.findAutomationReportRun.mockResolvedValue(reportRun);
    mocks.findActiveRun.mockResolvedValue({
      id: 22,
      status: 'running',
      taskId: 'announcer-task-two',
    });
    mocks.resumeTask.mockResolvedValue({ id: 12, taskId: 'task-resumed' });

    const response = await postEvent(
      envelope(
        message({
          id: 'message-2',
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          content: '<@bot-1> follow up on the first report',
          mentions: [{ id: 'bot-1', username: 'roomote' }],
          message_reference: {
            message_id: 'announcer-root-one',
            channel_id: 'channel-1',
          },
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.resumeTask).toHaveBeenCalledWith(
      expect.objectContaining({ completedRun: reportRun }),
    );
    expect(mocks.findActiveRun).not.toHaveBeenCalled();
    expect(mocks.findCompletedRun).not.toHaveBeenCalled();
  });

  it('still launches when the initial eyes reaction fails', async () => {
    mocks.addReaction.mockRejectedValueOnce(new Error('rate limited'));

    const response = await postEvent(envelope(message()));

    expect(response.status).toBe(200);
    expect(mocks.addReaction).toHaveBeenCalledWith({
      channelId: 'dm-1',
      messageId: 'message-1',
      name: '👀',
    });
    expect(mocks.startNewTask).toHaveBeenCalledTimes(1);
    const startArgs = mocks.startNewTask.mock.calls.at(-1)?.[0] as {
      intakeAckPinned?: boolean;
    };
    expect(startArgs.intakeAckPinned).toBeUndefined();
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        status: 'started',
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

  it('queues an ordinary message in an active Discord task thread with full thread context', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'thread-1',
      guildId: 'guild-1',
      parentId: 'channel-1',
      name: 'Fix tests',
      type: 11,
    });
    mocks.findActiveRun.mockResolvedValue({
      id: 23,
      taskId: 'task-23',
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
    expect(mocks.buildContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'thread-1',
        botUserId: 'bot-1',
        queuedMessage: expect.objectContaining({
          text: 'Also fix the type error',
        }),
      }),
    );
    expect(mocks.attachOutOfBand).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-23',
        provider: 'discord',
        message: expect.objectContaining({
          text: 'Also fix the type error',
          formattedPrompt: expect.stringContaining('<thread_context>'),
        }),
      }),
    );
    expect(mocks.queueMessage).toHaveBeenCalledWith(
      'discord',
      23,
      expect.objectContaining({
        text: 'Also fix the type error',
        formattedPrompt: expect.stringContaining('<thread_context>'),
        turnPolicy: { reactionsAllowed: true },
      }),
    );
    expect(mocks.setLatestInbound).toHaveBeenCalledWith(
      'discord',
      23,
      'message-1',
    );
    // Slack only platform-acks the first intake message; follow-ups stay silent.
    expect(mocks.addReaction).not.toHaveBeenCalled();
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('forwards message_reference into continuation prompts for active follow-ups', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'thread-1',
      guildId: 'guild-1',
      parentId: 'channel-1',
      name: 'Fix tests',
      type: 11,
    });
    mocks.findActiveRun.mockResolvedValue({
      id: 23,
      taskId: 'task-23',
      actingUserId: 'roomote-user-1',
    });

    const response = await postEvent(
      envelope(
        message({
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          content: 'what about that earlier note?',
          message_reference: {
            message_id: 'earlier-1',
            channel_id: 'thread-1',
          },
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.buildContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'thread-1',
        replyToMessageId: 'earlier-1',
        replyToChannelId: 'thread-1',
        queuedMessage: expect.objectContaining({
          text: 'what about that earlier note?',
        }),
      }),
    );
  });

  it('releases claimed out-of-band context when the queue duplicates', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'thread-1',
      guildId: 'guild-1',
      parentId: 'channel-1',
      name: 'Fix tests',
      type: 11,
    });
    mocks.findActiveRun.mockResolvedValue({
      id: 23,
      taskId: 'task-23',
      actingUserId: 'roomote-user-1',
    });
    mocks.attachOutOfBand.mockResolvedValue({
      message: {
        text: 'yes fix those',
        user: 'matt',
        ts: 'message-1',
        formattedPrompt:
          '<out_of_band_context>\nnotice\n</out_of_band_context>',
      },
      claim: { messageIds: ['oob-1'] },
    });
    mocks.queueMessage.mockResolvedValue(false);

    const response = await postEvent(
      envelope(
        message({
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          content: 'yes fix those',
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.releaseOutOfBand).toHaveBeenCalledWith({
      messageIds: ['oob-1'],
    });
    expect(mocks.releaseContinuation).toHaveBeenCalledWith({
      channelId: 'thread-1',
      claimedMessageIds: ['100'],
    });
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

  it('ignores unmentioned task-thread follow-ups that Slack-style gating rejects', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'thread-1',
      guildId: 'guild-1',
      parentId: 'channel-1',
      name: 'task-thread',
      type: 11,
    });
    mocks.findActiveRun.mockResolvedValue({
      id: 23,
      taskId: 'task-23',
      userId: 'roomote-user-1',
      actingUserId: 'roomote-user-1',
    });
    mocks.shouldRouteUnmentioned.mockResolvedValue(false);

    const response = await postEvent(
      envelope(
        message({
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          content: 'keep going after chatter',
        }),
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        ignored: 'discord_unmentioned_requires_mention',
      }),
    );
    expect(mocks.shouldRouteUnmentioned).toHaveBeenCalled();
    expect(mocks.queueMessage).not.toHaveBeenCalled();
    expect(mocks.startNewTask).not.toHaveBeenCalled();
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
    // Full setup instructions go to DM; the channel only gets a short ack.
    expect(mocks.createDirectMessage).toHaveBeenCalledWith('discord-user-1');
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'dm-private-1',
        text: expect.stringContaining('/link'),
      }),
    );
    // The pending claim expires quickly so a crashed claimant cannot wedge
    // the slot for the full dedupe window; only confirmed delivery holds it
    // for 24h.
    expect(mocks.redisSet).toHaveBeenCalledWith(
      'discord:account-link-dm:discord-user-1',
      'pending',
      'EX',
      120,
      'NX',
    );
    expect(mocks.redisSet).toHaveBeenCalledWith(
      'discord:account-link-dm:discord-user-1',
      'sent',
      'EX',
      24 * 60 * 60,
    );
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'I sent you a DM to link your Discord account.',
        replyToMessageId: 'message-1',
      }),
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('skips the duplicate link DM when one went out recently and still acks in channel', async () => {
    mocks.findMappedUserId.mockResolvedValue(null);
    // Dedupe slot already holds a confirmed delivery.
    mocks.redisSet.mockResolvedValue(null);
    mocks.redisGet.mockResolvedValue('sent');
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
    expect(mocks.createDirectMessage).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'I sent you a DM to link your Discord account.',
        replyToMessageId: 'message-1',
      }),
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('waits for an in-flight link DM before acknowledging it as sent', async () => {
    mocks.findMappedUserId.mockResolvedValue(null);
    // Another path already claimed the pending slot.
    mocks.redisSet.mockResolvedValue(null);
    mocks.redisGet
      .mockResolvedValueOnce('pending')
      .mockResolvedValueOnce('pending')
      .mockResolvedValue('sent');
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
    expect(mocks.createDirectMessage).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'I sent you a DM to link your Discord account.',
      }),
    );
  });

  it('does not claim a pending in-flight DM was sent when it never settles', async () => {
    mocks.findMappedUserId.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue(null);
    mocks.redisGet.mockResolvedValue('pending');
    mocks.getChannel.mockResolvedValue({
      id: 'channel-1',
      guildId: 'guild-1',
      name: 'general',
      type: 0,
    });

    const originalWait = { ...accountLinkDmInFlightWait };
    accountLinkDmInFlightWait.timeoutMs = 20;
    accountLinkDmInFlightWait.intervalMs = 5;
    accountLinkDmInFlightWait.sleep = async () => undefined;

    try {
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

      // Still pending after the wait window — keep the event so the Gateway can
      // retry instead of lying that a DM went out.
      expect(response.status).toBe(503);
      expect(mocks.reply).not.toHaveBeenCalled();
      expect(mocks.createDirectMessage).not.toHaveBeenCalled();
    } finally {
      accountLinkDmInFlightWait.timeoutMs = originalWait.timeoutMs;
      accountLinkDmInFlightWait.intervalMs = originalWait.intervalMs;
      accountLinkDmInFlightWait.sleep = originalWait.sleep;
    }
  });

  it('sends the link DM even when the dedupe check is unavailable', async () => {
    mocks.findMappedUserId.mockResolvedValue(null);
    // Redis down: the mention flow fails open so the user is not left silent.
    mocks.redisSet.mockRejectedValue(new Error('redis unavailable'));
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
    expect(mocks.createDirectMessage).toHaveBeenCalledWith('discord-user-1');
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'I sent you a DM to link your Discord account.',
      }),
    );
  });

  it('falls back to public link instructions when the account-link DM is blocked', async () => {
    mocks.findMappedUserId.mockResolvedValue(null);
    mocks.createDirectMessage.mockRejectedValue(
      new DiscordApiError({
        method: 'POST',
        path: '/users/@me/channels',
        status: 403,
        code: 50007,
        message: 'Cannot send messages to this user',
      }),
    );
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
    expect(mocks.postMessage).not.toHaveBeenCalled();
    // The failed delivery releases the dedupe slot so a later attempt can
    // retry once the user unblocks DMs.
    expect(mocks.redisDel).toHaveBeenCalledWith(
      'discord:account-link-dm:discord-user-1',
    );
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('/link code:<code>'),
        replyToMessageId: 'message-1',
      }),
    );
    expect(mocks.reply.mock.calls[0]?.[0]?.text).toMatch(
      /\[Settings → Personal → Linked Accounts\]\([^)]+\/settings\/personal\)/,
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('returns 503 for a transient account-link DM failure so the Gateway can retry', async () => {
    mocks.findMappedUserId.mockResolvedValue(null);
    mocks.createDirectMessage.mockRejectedValue(
      new DiscordApiError({
        method: 'POST',
        path: '/users/@me/channels',
        status: 503,
        message: 'Service Unavailable',
      }),
    );
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

    expect(response.status).toBe(503);
    // The slot is released before the rethrow so the Gateway retry can send
    // the DM instead of skipping it as a duplicate.
    expect(mocks.redisDel).toHaveBeenCalledWith(
      'discord:account-link-dm:discord-user-1',
    );
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('does not public-fallback on a non-blocked Discord 403 when opening the account-link DM', async () => {
    mocks.findMappedUserId.mockResolvedValue(null);
    mocks.createDirectMessage.mockRejectedValue(
      new DiscordApiError({
        method: 'POST',
        path: '/users/@me/channels',
        status: 403,
        code: 50001,
        message: 'Missing Access',
      }),
    );
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
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        ignored: 'discord_resource_unavailable',
      }),
    );
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('keeps the full link prompt in the existing DM for unlinked DM senders', async () => {
    mocks.findMappedUserId.mockResolvedValue(null);
    mocks.getChannel.mockResolvedValue({
      id: 'dm-1',
      name: 'Direct message',
      type: 1,
    });

    const response = await postEvent(envelope(message()));

    expect(response.status).toBe(200);
    expect(mocks.createDirectMessage).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('/link code:<code>'),
        replyToMessageId: 'message-1',
      }),
    );
    expect(mocks.reply.mock.calls[0]?.[0]?.text).toMatch(
      /\[Settings → Personal → Linked Accounts\]\([^)]+\/settings\/personal\)/,
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('DMs the link prompt and acks through the interaction for an unlinked guild /new', async () => {
    mocks.findMappedUserId.mockResolvedValue(null);
    mocks.getChannel.mockResolvedValue({
      id: 'channel-1',
      guildId: 'guild-1',
      name: 'general',
      type: 0,
    });
    const interaction = {
      id: 'interaction-new-unlinked',
      application_id: 'app-1',
      type: 2,
      token: 'interaction-token',
      channel_id: 'channel-1',
      guild_id: 'guild-1',
      member: {
        user: { id: 'discord-user-1', username: 'matt' },
      },
      data: {
        name: 'new',
        type: 1,
        options: [{ name: 'request', type: 3, value: 'Build a dashboard' }],
      },
    };

    const response = await postEvent(
      envelope(interaction, 'INTERACTION_CREATE'),
    );

    expect(response.status).toBe(200);
    expect(mocks.createDirectMessage).toHaveBeenCalledWith('discord-user-1');
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'dm-private-1',
        text: expect.stringContaining('/link'),
      }),
    );
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        interaction: { interaction, interactionDeferred: true },
        text: 'I sent you a DM to link your Discord account.',
      }),
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('ignores unlinked task-thread messages without a bot mention', async () => {
    // Same as Slack: drive-by chat in a task thread from an unlinked user
    // should not get a "link your account" nudge.
    mocks.findMappedUserId.mockResolvedValue(null);
    mocks.findActiveRun.mockResolvedValue({
      id: 23,
      actingUserId: 'roomote-user-1',
    });
    mocks.getChannel.mockResolvedValue({
      id: 'thread-1',
      guildId: 'guild-1',
      name: 'task-thread',
      type: 11,
      parentId: 'channel-1',
    });

    const response = await postEvent(
      envelope(
        message({
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          content: 'Just chiming in without a mention',
        }),
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        ignored: 'discord_sender_not_linked_unmentioned',
      }),
    );
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(mocks.queueMessage).not.toHaveBeenCalled();
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
    // Interaction ids are not reaction targets; eyes belong to message launches
    // or the post-launch acknowledgement path.
    expect(mocks.addReaction).not.toHaveBeenCalled();
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

  it('continues in the same thread when mentioned in an existing thread reply', async () => {
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
        // Match Slack: stay in the tagged thread. Only `/new` forces a sibling.
        forceNewThread: false,
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
    expect(mocks.buildContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'thread-1',
        botUserId: 'bot-1',
        queuedMessage: expect.objectContaining({
          text: 'Make one more change',
        }),
      }),
    );
    expect(mocks.addReaction).toHaveBeenCalledWith({
      channelId: 'thread-1',
      messageId: 'message-1',
      name: '👀',
    });
    expect(mocks.resumeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'discord',
        completedRun,
        channelId: 'channel-1',
        threadId: 'thread-1',
        guildId: 'guild-1',
        preservePayloadFlags: ['discordTaskThread'],
        discordWakeAckReaction: {
          channelId: 'thread-1',
          messageId: 'message-1',
          intakeAckPinned: true,
        },
        queuedMessage: expect.objectContaining({
          text: 'Make one more change',
          formattedPrompt: expect.stringContaining('<thread_context>'),
        }),
      }),
    );
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('clears wake eyes when snapshot resume fails after pinning', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'thread-1',
      guildId: 'guild-1',
      parentId: 'channel-1',
      name: 'Completed task',
      type: 11,
    });
    mocks.findCompletedRun.mockResolvedValue({
      id: 31,
      payload: {},
      port: null,
      snapshotId: 'snapshot-1',
    });
    mocks.resumeTask.mockRejectedValueOnce(new Error('enqueue failed'));

    const response = await postEvent(
      envelope(
        message({
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          content: 'Make one more change',
        }),
      ),
    );

    expect(response.status).toBe(500);
    expect(mocks.addReaction).toHaveBeenCalledWith({
      channelId: 'thread-1',
      messageId: 'message-1',
      name: '👀',
    });
    expect(mocks.removeReaction).toHaveBeenCalledWith({
      channelId: 'thread-1',
      messageId: 'message-1',
      name: 'eyes',
    });
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

  it('acknowledges a routing interaction whose pending state expired', async () => {
    mocks.hasPendingRouteCallback.mockResolvedValue(false);
    const interaction = {
      id: 'interaction-route-expired',
      application_id: 'app-1',
      type: 3,
      token: 'interaction-token',
      channel_id: 'channel-1',
      member: {
        user: { id: 'discord-user-1', username: 'matt' },
      },
      data: {
        custom_id: 'discord:route:abcdefghijkl:0',
        component_type: 2,
      },
    };

    const response = await postEvent(
      envelope(interaction, 'INTERACTION_CREATE'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ignored: 'expired_routing_interaction',
    });
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
    expect(mocks.getChannel).not.toHaveBeenCalled();
    expect(mocks.component).not.toHaveBeenCalled();
    expect(mocks.completeEvent).toHaveBeenCalledWith({
      eventType: 'INTERACTION_CREATE',
      eventId: 'interaction-route-expired',
      token: 'claim-token',
    });
    expect(mocks.releaseEvent).not.toHaveBeenCalled();
  });

  it('dispatches a routing interaction while its pending state exists', async () => {
    mocks.hasPendingRouteCallback.mockResolvedValue(true);
    const interaction = {
      id: 'interaction-route-live',
      application_id: 'app-1',
      type: 3,
      token: 'interaction-token',
      channel_id: 'dm-1',
      user: { id: 'discord-user-1', username: 'matt' },
      data: {
        custom_id: 'discord:route:abcdefghijkl:0',
        component_type: 2,
      },
    };

    const response = await postEvent(
      envelope(interaction, 'INTERACTION_CREATE'),
    );

    expect(response.status).toBe(200);
    expect(mocks.component).toHaveBeenCalledOnce();
  });
});
