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
  renewEvent: vi.fn(),
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
  suggestionReaction: vi.fn(),
  getTaskUrl: vi.fn(),
  getChannel: vi.fn(),
  getMessage: vi.fn(),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  createDirectMessage: vi.fn(),
  createThreadFromMessage: vi.fn(),
  postMessage: vi.fn(),
  channelAutoStart: vi.fn(),
  findPendingRoutingReply: vi.fn(),
  hasPendingRouteCallback: vi.fn(),
  handleRoutingReply: vi.fn(),
  attachOutOfBand: vi.fn(),
  releaseOutOfBand: vi.fn(),
  redisSet: vi.fn(),
  redisEval: vi.fn(),
  redisGet: vi.fn(),
  redisGetdel: vi.fn(),
  redisDel: vi.fn(),
  buildContinuation: vi.fn(),
  releaseContinuation: vi.fn(),
  markThreadHistoryDelivered: vi.fn(),
  fetchThreadHistory: vi.fn(),
  shouldRouteUnmentioned: vi.fn(),
  enqueueGatewayEvent: vi.fn(),
  callViaEmojiConfig: vi.fn(),
  appendAccountLinkHelpText: vi.fn(async (message: string) => message),
  startGoal: vi.fn(),
  acquireFastTurnLock: vi.fn(),
  answerFast: vi.fn(),
  hasFastSession: vi.fn(),
  findFastMessageSession: vi.fn(),
  findFastReplySession: vi.fn(),
  isFastProviderMessage: vi.fn(),
  recordProviderMessage: vi.fn(),
  queueFastSurfaceReply: vi.fn(),
}));

vi.mock('../../account-link-help.js', () => ({
  appendAccountLinkHelpText: mocks.appendAccountLinkHelpText,
}));

vi.mock('@roomote/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/redis')>();
  return {
    ...actual,
    getRedis: () => ({
      set: mocks.redisSet,
      eval: mocks.redisEval,
      get: mocks.redisGet,
      getdel: mocks.redisGetdel,
      del: mocks.redisDel,
    }),
  };
});

vi.mock('../event-gate.js', () => ({
  claimDiscordApiEvent: mocks.claimEvent,
  completeDiscordApiEvent: mocks.completeEvent,
  discordApiEventLeaseRenewal: { intervalMs: 60 * 1000 },
  releaseDiscordApiEvent: mocks.releaseEvent,
  renewDiscordApiEvent: mocks.renewEvent,
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
  findFastAgentSessionForProviderMessage: mocks.findFastMessageSession,
  findFastAgentSessionForProviderReply: mocks.findFastReplySession,
  isFastAgentProviderMessage: mocks.isFastProviderMessage,
  recordFastAgentConversationMessageBestEffort: mocks.recordProviderMessage,
  queueFastAgentSurfaceReply: mocks.queueFastSurfaceReply,
  resolveUserMcpServerConfigs: vi.fn(async () => ({})),
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

vi.mock('@roomote/communication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/communication')>()),
  resolveFastSessionReplyFooterContext: vi.fn(async () => ({
    linkedPrs: [],
    livePreviewUrl: null,
  })),
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

vi.mock('../../call-roomote-via-emoji.js', () => ({
  getCallRoomoteViaEmojiConfiguration: mocks.callViaEmojiConfig,
}));

vi.mock('../task-orchestration.js', () => ({
  startNewDiscordTask: mocks.startNewTask,
}));

vi.mock('../goal-command.js', () => ({
  startDiscordTaskGoal: mocks.startGoal,
}));

vi.mock('../replies.js', () => ({ replyToDiscordEvent: mocks.reply }));

vi.mock('../callback-actions.js', () => ({
  handleDiscordComponentInteraction: mocks.component,
  handleDiscordSuggestionReaction: mocks.suggestionReaction,
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireFastTurnLock,
  answerFastAgentQuestion: mocks.answerFast,
  buildFastAgentReactionExternalInputQuestion: vi.fn(
    (input: unknown) =>
      `<external_input>${JSON.stringify(input)}</external_input>`,
  ),
  resolveApiBaseUrl: () => 'https://roomote.example.com',
  getTaskUrl: mocks.getTaskUrl,
  hasFastAgentSession: mocks.hasFastSession,
  getOrCreateFastAgentSession: vi
    .fn()
    .mockResolvedValue({ id: 'fast-session-1' }),
}));

import { discord, discordGatewayEventProcessingTimeout } from '../index.js';
import { discordApiEventLeaseRenewal } from '../event-gate.js';

const app = new Hono();
app.route('/api/internal/discord', discord);

const provider = {
  getChannel: mocks.getChannel,
  getMessage: mocks.getMessage,
  addReaction: mocks.addReaction,
  removeReaction: mocks.removeReaction,
  createDirectMessage: mocks.createDirectMessage,
  createThreadFromMessage: mocks.createThreadFromMessage,
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

const IMAGE_ATTACHMENT = {
  id: 'attachment-1',
  filename: 'context.png',
  content_type: 'image/png',
  size: 1234,
  url: 'https://cdn.discordapp.com/attachments/context.png',
};

// Fast mode always answers linked-human text messages, so task-orchestration
// tests use attachment-only messages (no text for Fast mode to answer).
function attachmentMessage(overrides: Record<string, unknown> = {}) {
  return message({
    content: '',
    attachments: [IMAGE_ATTACHMENT],
    ...overrides,
  });
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
    mocks.appendAccountLinkHelpText.mockImplementation(
      async (message: string) => message,
    );
    process.env.R_DISCORD_GATEWAY_SECRET = 'gateway-secret';
    mocks.claimEvent.mockResolvedValue({
      status: 'claimed',
      token: 'claim-token',
    });
    mocks.completeEvent.mockResolvedValue(true);
    mocks.releaseEvent.mockResolvedValue(undefined);
    mocks.renewEvent.mockResolvedValue(true);
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
    mocks.getMessage.mockResolvedValue(null);
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
    mocks.startGoal.mockResolvedValue({ success: true });
    mocks.acquireFastTurnLock.mockResolvedValue(
      vi.fn().mockResolvedValue(undefined),
    );
    mocks.answerFast.mockResolvedValue('A quick answer');
    mocks.hasFastSession.mockResolvedValue(false);
    mocks.findFastMessageSession.mockResolvedValue(null);
    mocks.findFastReplySession.mockResolvedValue(null);
    mocks.isFastProviderMessage.mockResolvedValue(false);
    mocks.recordProviderMessage.mockResolvedValue(true);
    mocks.queueFastSurfaceReply.mockResolvedValue(true);
    mocks.reply.mockResolvedValue({ messageId: 'reply-1' });
    mocks.createDirectMessage.mockResolvedValue({ id: 'dm-private-1' });
    mocks.createThreadFromMessage.mockResolvedValue({
      channelId: 'message-1',
      parentChannelId: 'channel-1',
      name: 'Fix the flaky tests',
      kind: 'thread',
      messageId: 'message-1',
    });
    mocks.postMessage.mockResolvedValue({ messageId: 'dm-msg-1' });
    mocks.redisSet.mockResolvedValue('OK');
    mocks.redisEval.mockResolvedValue(1);
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisGetdel.mockResolvedValue(null);
    mocks.redisDel.mockResolvedValue(1);
    mocks.component.mockResolvedValue('handled');
    mocks.suggestionReaction.mockResolvedValue(false);
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
    mocks.callViaEmojiConfig.mockResolvedValue(null);
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
        attachmentMessage({
          channel_id: 'thread-1',
          guild_id: 'guild-1',
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
        queuedMessage: expect.objectContaining({ text: 'Image: context.png' }),
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

  it('routes a configured reaction into the fast agent in a thread anchored on the reacted-on message', async () => {
    mocks.callViaEmojiConfig.mockResolvedValue({
      emoji: 'white_check_mark',
      prompt: 'Act on this\n\nAdditional instructions:\nPrioritize safety.',
    });
    mocks.getChannel.mockResolvedValue({
      id: 'channel-1',
      name: 'general',
      type: 0,
      guildId: 'guild-1',
    });
    mocks.getMessage.mockResolvedValue({
      provider: 'discord',
      id: 'message-1',
      user: 'discord-user-2',
      text: 'Deploys are failing on main',
      channelId: 'channel-1',
      fileCount: 0,
    });

    const response = await postEvent({
      eventId: 'channel-1:message-1:discord-user-1:white_check_mark',
      eventType: 'MESSAGE_REACTION_ADD',
      receivedAt: '2026-07-12T15:00:00.000Z',
      payload: {
        user_id: 'discord-user-1',
        channel_id: 'channel-1',
        message_id: 'message-1',
        guild_id: 'guild-1',
        emoji: { id: null, name: 'white_check_mark' },
        member: {
          user: { id: 'discord-user-1', username: 'matt' },
        },
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      fastAnswered: true,
      fastDefaulted: true,
    });
    expect(mocks.channelAutoStart).not.toHaveBeenCalled();
    expect(mocks.getMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'message-1',
    });
    // The fast thread anchors on the real reacted-on message, not the
    // synthesized event id.
    expect(mocks.createThreadFromMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'message-1',
      name: expect.stringContaining('Act on this'),
    });
    expect(mocks.answerFast).toHaveBeenCalledWith(
      expect.objectContaining({
        question:
          'Act on this\n\nAdditional instructions:\nPrioritize safety.\n\nMessage to act on:\nDeploys are failing on main',
        userId: 'roomote-user-1',
        currentMessageId: 'message-1',
        conversation: expect.objectContaining({
          surface: 'discord',
          workspaceId: 'guild-1',
          conversationId: 'message-1',
        }),
      }),
    );
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: 'message-1',
        text: expect.stringContaining('A quick answer'),
      }),
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
    expect(mocks.queueMessage).not.toHaveBeenCalled();
    expect(mocks.queueFastSurfaceReply).not.toHaveBeenCalled();
  });

  it('answers a configured reaction through the fast agent when the reacted-on message cannot be fetched', async () => {
    mocks.callViaEmojiConfig.mockResolvedValue({
      emoji: 'white_check_mark',
      prompt: 'Act on this',
    });
    mocks.getChannel.mockResolvedValue({
      id: 'channel-1',
      name: 'general',
      type: 0,
      guildId: 'guild-1',
    });
    mocks.getMessage.mockRejectedValue(new Error('rate limited'));

    const response = await postEvent({
      eventId: 'channel-1:message-1:discord-user-1:white_check_mark',
      eventType: 'MESSAGE_REACTION_ADD',
      receivedAt: '2026-07-12T15:00:00.000Z',
      payload: {
        user_id: 'discord-user-1',
        channel_id: 'channel-1',
        message_id: 'message-1',
        guild_id: 'guild-1',
        emoji: { id: null, name: 'white_check_mark' },
        member: {
          user: { id: 'discord-user-1', username: 'matt' },
        },
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      fastAnswered: true,
      fastDefaulted: true,
    });
    expect(mocks.answerFast).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'Act on this' }),
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('starts an exactly tracked suggestion before configured emoji routing', async () => {
    mocks.suggestionReaction.mockResolvedValue(true);
    mocks.getChannel.mockResolvedValue({
      id: 'thread-1',
      name: 'Task thread',
      type: 11,
      guildId: 'guild-1',
      parentId: 'channel-1',
    });

    const response = await postEvent({
      eventId: 'thread-1:suggestion-message:discord-user-1:thumbsup',
      eventType: 'MESSAGE_REACTION_ADD',
      receivedAt: '2026-07-12T15:00:00.000Z',
      payload: {
        user_id: 'discord-user-1',
        channel_id: 'thread-1',
        message_id: 'suggestion-message',
        guild_id: 'guild-1',
        emoji: { id: null, name: '👍' },
        member: {
          nick: 'Matt',
          user: { id: 'discord-user-1', username: 'matt' },
        },
      },
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      suggestionStarted: true,
    });
    expect(mocks.suggestionReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'thread-1',
        messageId: 'suggestion-message',
        sender: expect.objectContaining({ id: 'discord-user-1' }),
      }),
    );
    expect(mocks.callViaEmojiConfig).not.toHaveBeenCalled();
    expect(mocks.queueFastSurfaceReply).not.toHaveBeenCalled();
  });

  it('queues an unconfigured reaction on the owner’s bound Fast message', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'thread-1',
      name: 'Task thread',
      type: 11,
      guildId: 'guild-1',
      parentId: 'channel-1',
    });
    mocks.findFastMessageSession.mockResolvedValue({
      id: 'fast-session-1',
      userId: 'roomote-user-1',
      conversation: {
        surface: 'discord',
        workspaceId: 'guild-1',
        conversationId: 'thread-1',
        replyTarget: { channelId: 'channel-1', threadId: 'thread-1' },
      },
    });

    const response = await postEvent({
      eventId: 'thread-1:message-1:discord-user-1:heart',
      eventType: 'MESSAGE_REACTION_ADD',
      receivedAt: '2026-07-12T15:00:00.000Z',
      payload: {
        user_id: 'discord-user-1',
        channel_id: 'thread-1',
        message_id: 'message-1',
        guild_id: 'guild-1',
        emoji: { id: null, name: 'heart' },
        member: {
          nick: 'Matt',
          user: { id: 'discord-user-1', username: 'matt' },
        },
      },
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      fastReactionQueued: true,
    });
    expect(mocks.findFastMessageSession).toHaveBeenCalledWith({
      provider: 'discord',
      workspaceId: 'guild-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      messageId: 'message-1',
    });
    expect(mocks.queueFastSurfaceReply).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'fast-session-1',
        userId: 'roomote-user-1',
        currentMessageId: expect.stringContaining('discord-reaction:'),
        replyToMessageId: 'message-1',
        externalInput: expect.objectContaining({
          provider: 'discord',
          reactions: [{ name: 'heart' }],
        }),
      }),
    );
  });

  it('rejects a reaction from a different Fast session owner', async () => {
    mocks.findFastMessageSession.mockResolvedValue({
      id: 'fast-session-1',
      userId: 'another-roomote-user',
      conversation: {
        surface: 'discord',
        workspaceId: 'dm',
        conversationId: 'dm-1',
        replyTarget: { channelId: 'dm-1' },
      },
    });

    const response = await postEvent({
      eventId: 'dm-1:message-1:discord-user-1:heart',
      eventType: 'MESSAGE_REACTION_ADD',
      receivedAt: '2026-07-12T15:00:00.000Z',
      payload: {
        user_id: 'discord-user-1',
        channel_id: 'dm-1',
        message_id: 'message-1',
        emoji: { id: null, name: 'heart' },
      },
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      ignored: 'discord_fast_session_user_mismatch',
    });
    expect(mocks.queueFastSurfaceReply).not.toHaveBeenCalled();
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

  it('keeps a timed-out event lease until slow processing finishes', async () => {
    const originalTimeout = discordGatewayEventProcessingTimeout.timeoutMs;
    const originalLeaseRenewalInterval = discordApiEventLeaseRenewal.intervalMs;
    vi.useFakeTimers();
    discordGatewayEventProcessingTimeout.timeoutMs = 10;
    discordApiEventLeaseRenewal.intervalMs = 15;
    let resolveChannel: (value: {
      id: string;
      name: string;
      type: number;
    }) => void;
    mocks.getChannel.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveChannel = resolve;
        }),
    );

    try {
      const responsePromise = postEvent(envelope(message()));
      await vi.advanceTimersByTimeAsync(10);
      const response = await responsePromise;

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: 'discord_api_unavailable',
      });
      expect(mocks.releaseEvent).not.toHaveBeenCalled();
      expect(mocks.completeEvent).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(15);
      expect(mocks.renewEvent).toHaveBeenCalledWith({
        eventType: 'MESSAGE_CREATE',
        eventId: 'message-1',
        token: 'claim-token',
      });

      resolveChannel!({ id: 'dm-1', name: 'Direct message', type: 1 });
      await vi.runAllTimersAsync();

      expect(mocks.completeEvent).toHaveBeenCalledWith({
        eventType: 'MESSAGE_CREATE',
        eventId: 'message-1',
        token: 'claim-token',
      });
    } finally {
      discordGatewayEventProcessingTimeout.timeoutMs = originalTimeout;
      discordApiEventLeaseRenewal.intervalMs = originalLeaseRenewalInterval;
      vi.useRealTimers();
    }
  });

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

  it('launches a linked DM attachment request through the Discord task orchestrator', async () => {
    const response = await postEvent(envelope(attachmentMessage()));

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
          text: 'Image: context.png',
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

  it('routes an ordinary linked DM message through Fast mode when the user default is enabled', async () => {
    const response = await postEvent(envelope(message()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      fastAnswered: true,
      fastDefaulted: true,
    });
    expect(mocks.answerFast).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Fix the flaky tests',
        userId: 'roomote-user-1',
        conversation: {
          surface: 'discord',
          workspaceId: 'dm',
          conversationId: 'dm-1',
          replyTarget: { channelId: 'dm-1' },
        },
        activeTasks: [],
      }),
    );
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: 'message-1',
        text: expect.stringMatching(
          /^A quick answer\n\n-# Reply or use the \[web app\]\(.*\/sessions\/fast-session-1.*\)\.$/,
        ),
      }),
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
    expect(mocks.queueMessage).not.toHaveBeenCalled();
  });

  it('starts a new guild-channel Fast conversation in an anchored thread', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'channel-1',
      name: 'general',
      type: 0,
      guildId: 'guild-1',
    });

    const response = await postEvent(
      envelope(
        message({
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          content: '<@bot-1> Fix the flaky tests',
          mentions: [{ id: 'bot-1', username: 'Roomote' }],
        }),
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      fastAnswered: true,
      fastDefaulted: true,
    });
    expect(mocks.createThreadFromMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'message-1',
      name: 'Fix the flaky tests',
    });
    expect(mocks.answerFast).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: {
          surface: 'discord',
          workspaceId: 'guild-1',
          conversationId: 'message-1',
          replyTarget: { channelId: 'channel-1', threadId: 'message-1' },
        },
      }),
    );
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: expect.objectContaining({
          channelId: 'message-1',
          parentChannelId: 'channel-1',
          isThread: true,
        }),
      }),
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('passes the model-authored Fast kickoff through the Discord enqueue gate', async () => {
    const postKickoff = vi.fn().mockResolvedValue(undefined);
    mocks.startNewTask.mockImplementation(
      async (input: {
        beforeEnqueueKickoff: (task: {
          taskId: string;
          taskUrl?: string;
        }) => Promise<void>;
      }) => {
        await input.beforeEnqueueKickoff({
          taskId: 'task-17',
          taskUrl: 'https://roomote.example/task/task-17',
        });
        return {
          status: 'started',
          launchResult: { id: 17, taskId: 'task-17' },
          taskUrl: 'https://roomote.example/task/task-17',
        };
      },
    );
    mocks.answerFast.mockImplementation(
      async (input: {
        adapter: {
          launchTask: (params: {
            prompt: string;
            environmentId: null;
            model?: string | null;
            parentSessionId: string;
            postKickoff: typeof postKickoff;
          }) => Promise<unknown>;
        };
      }) => {
        await input.adapter.launchTask({
          prompt: 'Fix checkout',
          environmentId: null,
          model: 'anthropic/claude-sonnet-5',
          parentSessionId: 'fast-session-1',
          postKickoff,
        });
        return '';
      },
    );

    const response = await postEvent(envelope(message()));

    expect(response.status).toBe(200);
    expect(mocks.startNewTask).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeEnqueueKickoff: postKickoff,
        model: 'anthropic/claude-sonnet-5',
      }),
    );
    expect(postKickoff).toHaveBeenCalledWith({
      taskId: 'task-17',
      taskUrl: 'https://roomote.example/task/task-17',
    });
  });

  it('serializes complete Fast turns before the next Discord message enters the agent', async () => {
    let grantSecondLock!: (release: () => Promise<void>) => void;
    const secondLock = new Promise<() => Promise<void>>((resolve) => {
      grantSecondLock = resolve;
    });
    const releaseSecondLock = vi.fn().mockResolvedValue(undefined);
    const releaseFirstLock = vi.fn(async () => {
      grantSecondLock(releaseSecondLock);
    });
    mocks.acquireFastTurnLock
      .mockResolvedValueOnce(releaseFirstLock)
      .mockImplementationOnce(async () => secondLock);

    let finishFirstTurn!: (response: string) => void;
    const firstTurn = new Promise<string>((resolve) => {
      finishFirstTurn = resolve;
    });
    mocks.answerFast
      .mockImplementationOnce(async () => firstTurn)
      .mockResolvedValueOnce('Second answer');

    const firstResponse = postEvent(
      envelope(message({ id: 'message-concurrent-1', content: 'Launch it' })),
    );
    await vi.waitFor(() => expect(mocks.answerFast).toHaveBeenCalledOnce());

    const secondResponse = postEvent(
      envelope(
        message({
          id: 'message-concurrent-2',
          content: 'Send it another message',
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(mocks.acquireFastTurnLock).toHaveBeenCalledTimes(2),
    );
    expect(mocks.answerFast).toHaveBeenCalledOnce();
    expect(mocks.acquireFastTurnLock).toHaveBeenNthCalledWith(1, {
      conversation: {
        surface: 'discord',
        workspaceId: 'dm',
        conversationId: 'dm-1',
        replyTarget: { channelId: 'dm-1' },
      },
    });
    expect(mocks.acquireFastTurnLock).toHaveBeenNthCalledWith(2, {
      conversation: {
        surface: 'discord',
        workspaceId: 'dm',
        conversationId: 'dm-1',
        replyTarget: { channelId: 'dm-1' },
      },
    });

    finishFirstTurn('First answer');
    expect((await firstResponse).status).toBe(200);
    expect((await secondResponse).status).toBe(200);

    expect(mocks.answerFast).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ question: 'Launch it' }),
    );
    expect(mocks.answerFast).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ question: 'Send it another message' }),
    );
    expect(releaseFirstLock).toHaveBeenCalledOnce();
    expect(releaseSecondLock).toHaveBeenCalledOnce();
  });

  it('gives defaulted Discord Fast mode the active task for thread continuation', async () => {
    mocks.findActiveRun.mockResolvedValue({
      id: 23,
      taskId: 'task-23',
      userId: 'roomote-user-1',
    });
    const response = await postEvent(envelope(message()));

    expect(response.status).toBe(200);
    expect(mocks.shouldRouteUnmentioned).not.toHaveBeenCalled();
    expect(mocks.answerFast).toHaveBeenCalledWith(
      expect.objectContaining({ activeTasks: [{ taskId: 'task-23' }] }),
    );
    expect(mocks.queueMessage).not.toHaveBeenCalled();
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
        attachmentMessage({
          id: 'message-2',
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          content: '<@bot-1>',
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
        attachmentMessage({
          id: 'message-2',
          channel_id: 'channel-1',
          guild_id: 'guild-1',
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
        attachmentMessage({
          id: 'message-2',
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          content: '<@bot-1>',
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
      expect.objectContaining({ text: 'Image: context.png' }),
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
        attachmentMessage({
          id: 'message-2',
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          content: '<@bot-1>',
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

    const response = await postEvent(envelope(attachmentMessage()));

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

  it('queues an attachment-only message in an active Discord task thread with full thread context', async () => {
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
        attachmentMessage({
          channel_id: 'thread-1',
          guild_id: 'guild-1',
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.buildContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'thread-1',
        botUserId: 'bot-1',
        queuedMessage: expect.objectContaining({
          text: 'Image: context.png',
        }),
      }),
    );
    expect(mocks.attachOutOfBand).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-23',
        provider: 'discord',
        message: expect.objectContaining({
          text: 'Image: context.png',
          formattedPrompt: expect.stringContaining('<thread_context>'),
        }),
      }),
    );
    expect(mocks.queueMessage).toHaveBeenCalledWith(
      'discord',
      23,
      expect.objectContaining({
        text: 'Image: context.png',
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
        attachmentMessage({
          channel_id: 'thread-1',
          guild_id: 'guild-1',
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
          text: 'Image: context.png',
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
        attachmentMessage({
          channel_id: 'thread-1',
          guild_id: 'guild-1',
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

    const response = await postEvent(envelope(attachmentMessage()));

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

  it("lets Matt join Dan's existing fast-agent thread and receive a response", async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'thread-1',
      guildId: 'guild-1',
      parentId: 'channel-1',
      name: 'fast-thread',
      type: 11,
    });
    mocks.hasFastSession.mockResolvedValue(true);
    mocks.shouldRouteUnmentioned.mockResolvedValue(true);

    const response = await postEvent(
      envelope(
        message({
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          content: 'Hey Roomote, can you check this too?',
          author: { id: 'discord-user-matt', username: 'matt' },
        }),
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ fastAnswered: true, fastContinued: true }),
    );
    expect(mocks.hasFastSession).toHaveBeenCalledWith({
      surface: 'discord',
      workspaceId: 'guild-1',
      conversationId: 'thread-1',
      replyTarget: { channelId: 'channel-1', threadId: 'thread-1' },
    });
    expect(mocks.shouldRouteUnmentioned).toHaveBeenCalledWith(
      expect.objectContaining({
        isOpenConversationThread: true,
        isRoomoteThread: true,
      }),
    );
    expect(mocks.answerFast).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Hey Roomote, can you check this too?',
        conversation: expect.objectContaining({ surface: 'discord' }),
      }),
    );
  });

  it('continues an existing fast-agent DM without Fast mode being the default', async () => {
    mocks.hasFastSession.mockResolvedValue(true);

    const response = await postEvent(
      envelope(
        message({
          content: 'What did I ask you to remember?',
        }),
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ fastAnswered: true, fastContinued: true }),
    );
    expect(mocks.hasFastSession).toHaveBeenCalledWith({
      surface: 'discord',
      workspaceId: 'dm',
      conversationId: 'dm-1',
      replyTarget: { channelId: 'dm-1' },
    });
    expect(mocks.answerFast).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'What did I ask you to remember?',
        conversation: {
          surface: 'discord',
          workspaceId: 'dm',
          conversationId: 'dm-1',
          replyTarget: { channelId: 'dm-1' },
        },
      }),
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('continues the Fast session bound to a Discord DM report reply', async () => {
    mocks.findFastReplySession.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      userId: 'roomote-user-1',
      conversation: {
        surface: 'discord',
        workspaceId: 'dm',
        conversationId: 'automation-run-1',
        replyTarget: { channelId: 'dm-1' },
      },
    });

    const response = await postEvent(
      envelope(
        message({
          content: 'Investigate the second finding',
          message_reference: { message_id: 'fast-report-1' },
        }),
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ fastAnswered: true, fastContinued: true }),
    );
    expect(mocks.findFastReplySession).toHaveBeenCalledWith({
      provider: 'discord',
      workspaceId: 'dm',
      channelId: 'dm-1',
      replyToMessageId: 'fast-report-1',
    });
    expect(mocks.answerFast).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Investigate the second finding',
        allowSilentAmbientReply: false,
        conversation: expect.objectContaining({
          conversationId: 'automation-run-1',
        }),
      }),
    );
    expect(mocks.findAutomationReportRun).not.toHaveBeenCalled();
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('requires a response for a native reply to Roomote in a shared Fast thread', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'thread-1',
      guildId: 'guild-1',
      parentId: 'channel-1',
      name: 'fast-thread',
      type: 11,
    });
    mocks.findFastReplySession.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      userId: 'roomote-user-1',
      conversation: {
        surface: 'discord',
        workspaceId: 'guild-1',
        conversationId: 'thread-1',
        replyTarget: { channelId: 'channel-1', threadId: 'thread-1' },
      },
    });
    mocks.shouldRouteUnmentioned.mockResolvedValue(false);
    mocks.fetchThreadHistory.mockResolvedValue([
      {
        id: 'earlier-message',
        user: 'discord-user-2',
        text: 'Earlier participant message',
        attachments: [],
      },
    ]);

    const response = await postEvent(
      envelope(
        message({
          channel_id: 'thread-1',
          guild_id: 'guild-1',
          content: 'Can you expand on that?',
          message_reference: { message_id: 'fast-reply-1' },
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.answerFast).toHaveBeenCalledWith(
      expect.objectContaining({ allowSilentAmbientReply: false }),
    );
  });

  it('preserves the root channel for a provider-bound guild Fast continuation', async () => {
    mocks.getChannel.mockResolvedValue({
      id: 'channel-1',
      guildId: 'guild-1',
      name: 'general',
      type: 0,
    });
    mocks.findFastReplySession.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      userId: 'roomote-user-1',
      conversation: {
        surface: 'discord',
        workspaceId: 'guild-1',
        conversationId: 'automation-run-1',
        replyTarget: { channelId: 'channel-1' },
      },
    });

    const response = await postEvent(
      envelope(
        message({
          channel_id: 'channel-1',
          guild_id: 'guild-1',
          content: '<@bot-1> Investigate the second finding',
          mentions: [{ id: 'bot-1', username: 'Roomote' }],
          message_reference: { message_id: 'fast-report-1' },
        }),
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ fastAnswered: true, fastContinued: true }),
    );
    expect(mocks.createThreadFromMessage).not.toHaveBeenCalled();
    expect(mocks.answerFast).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: {
          surface: 'discord',
          workspaceId: 'guild-1',
          conversationId: 'automation-run-1',
          replyTarget: { channelId: 'channel-1' },
        },
      }),
    );
  });

  it('fails closed when a different Discord DM user replies to a Fast report', async () => {
    mocks.findFastReplySession.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      userId: 'another-roomote-user',
      conversation: {
        surface: 'discord',
        workspaceId: 'dm',
        conversationId: 'automation-run-1',
        replyTarget: { channelId: 'dm-1' },
      },
    });

    const response = await postEvent(
      envelope(message({ message_reference: { message_id: 'fast-report-1' } })),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      ignored: 'discord_fast_session_user_mismatch',
    });
    expect(mocks.answerFast).not.toHaveBeenCalled();
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('does not fall through when a Discord Fast message is replayed from another route', async () => {
    mocks.isFastProviderMessage.mockResolvedValue(true);

    const response = await postEvent(
      envelope(message({ message_reference: { message_id: 'fast-report-1' } })),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      ignored: 'discord_fast_session_route_mismatch',
    });
    expect(mocks.findAutomationReportRun).not.toHaveBeenCalled();
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
    mocks.appendAccountLinkHelpText.mockImplementation(
      async (message: string) => `${message} Ask an admin for an invite.`,
    );
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
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Ask an admin for an invite.'),
      }),
    );
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'I sent you a DM to link your Discord account.',
      }),
    );
  });

  it('falls back to public link instructions when the account-link DM is blocked', async () => {
    mocks.appendAccountLinkHelpText.mockImplementation(
      async (message: string) => `${message} Ask an admin for an invite.`,
    );
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
    expect(mocks.reply.mock.calls[0]?.[0]?.text).toContain(
      'Ask an admin for an invite.',
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
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          'keep working toward an objective across multiple turns',
        ),
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

  it('uses /goal to enable Goal Mode on the active task', async () => {
    mocks.findActiveRun.mockResolvedValue({
      id: 23,
      taskId: 'task-23',
      actingUserId: 'roomote-user-1',
    });
    const interaction = {
      id: 'interaction-goal',
      application_id: 'app-1',
      type: 2,
      token: 'interaction-token',
      channel_id: 'dm-1',
      user: { id: 'discord-user-1', username: 'matt' },
      data: {
        name: 'goal',
        type: 1,
        options: [{ name: 'objective', type: 3, value: 'Ship the release' }],
      },
    };

    const response = await postEvent(
      envelope(interaction, 'INTERACTION_CREATE'),
    );

    expect(response.status).toBe(200);
    expect(mocks.startGoal).toHaveBeenCalledWith({
      taskId: 'task-23',
      userId: 'roomote-user-1',
      objective: 'Ship the release',
      clientMessageId: 'interaction-goal',
    });
    expect(mocks.startNewTask).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        interaction: { interaction, interactionDeferred: true },
        text: 'Goal Mode enabled.',
        ephemeral: true,
      }),
    );
  });

  it('does not create a task when /goal has no active task', async () => {
    const interaction = {
      id: 'interaction-goal',
      application_id: 'app-1',
      type: 2,
      token: 'interaction-token',
      channel_id: 'dm-1',
      user: { id: 'discord-user-1', username: 'matt' },
      data: {
        name: 'goal',
        type: 1,
        options: [{ name: 'objective', type: 3, value: 'Ship the release' }],
      },
    };

    const response = await postEvent(
      envelope(interaction, 'INTERACTION_CREATE'),
    );

    expect(response.status).toBe(200);
    expect(mocks.startGoal).not.toHaveBeenCalled();
    expect(mocks.startNewTask).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('active Roomote task'),
        ephemeral: true,
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
        attachmentMessage({
          channel_id: 'discussion-thread',
          guild_id: 'guild-1',
          content: '<@bot-1>',
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
        attachmentMessage({
          channel_id: 'thread-1',
          guild_id: 'guild-1',
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.buildContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'thread-1',
        botUserId: 'bot-1',
        queuedMessage: expect.objectContaining({
          text: 'Image: context.png',
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
          text: 'Image: context.png',
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
        attachmentMessage({
          channel_id: 'thread-1',
          guild_id: 'guild-1',
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

  it('continues the most recent task request after linking', async () => {
    mocks.findMappedUserId.mockResolvedValueOnce(null);
    mocks.getChannel.mockImplementation(async (channelId: string) =>
      channelId === 'dm-1'
        ? { id: 'dm-1', name: 'Direct message', type: 1 }
        : {
            id: 'channel-1',
            guildId: 'guild-1',
            name: 'general',
            type: 0,
          },
    );
    const originalEvent = envelope(
      attachmentMessage({
        channel_id: 'channel-1',
        guild_id: 'guild-1',
        content: '<@bot-1>',
        mentions: [{ id: 'bot-1', username: 'Roomote', bot: true }],
      }),
    );

    const unlinkedResponse = await postEvent(originalEvent);

    expect(unlinkedResponse.status).toBe(200);
    const pendingTaskCall = mocks.redisEval.mock.calls.find(
      ([, , key]) => key === 'discord:pending_account_link_task:discord-user-1',
    );
    expect(pendingTaskCall?.slice(1, 6)).toEqual([
      1,
      'discord:pending_account_link_task:discord-user-1',
      originalEvent.receivedAt,
      originalEvent.eventId,
      expect.any(String),
    ]);
    expect(pendingTaskCall?.[6]).toBe(String(10 * 60));
    expect(JSON.parse(pendingTaskCall?.[5] as string)).toMatchObject(
      originalEvent,
    );

    mocks.consumeLinkCode.mockResolvedValue('roomote-user-1');
    mocks.findMappedUserId.mockResolvedValue('roomote-user-1');
    mocks.redisGetdel.mockResolvedValue(pendingTaskCall?.[5]);
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

    const linkedResponse = await postEvent(
      envelope(interaction, 'INTERACTION_CREATE'),
    );

    expect(linkedResponse.status).toBe(200);
    expect(mocks.startNewTask).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterDiscordUserId: 'discord-user-1',
        launchOwnerUserId: 'roomote-user-1',
        queuedMessage: expect.objectContaining({
          text: 'Image: context.png',
          ts: 'message-1',
          userId: 'roomote-user-1',
        }),
        channel: expect.objectContaining({ channelId: 'channel-1' }),
      }),
    );
    expect(mocks.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          'I also picked up your most recent task request.',
        ),
      }),
    );
  });

  it('restores the pending request and link code when continuation fails', async () => {
    const originalEvent = envelope(attachmentMessage());
    mocks.consumeLinkCode.mockResolvedValue('roomote-user-1');
    mocks.findMappedUserId.mockResolvedValue('roomote-user-1');
    mocks.redisGetdel.mockResolvedValue(JSON.stringify(originalEvent));
    mocks.startNewTask.mockRejectedValue(new Error('launch failed'));
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

    expect(response.status).toBe(500);
    expect(mocks.redisEval).toHaveBeenCalledWith(
      expect.stringContaining('current.receivedAt > ARGV[1]'),
      1,
      'discord:pending_account_link_task:discord-user-1',
      originalEvent.receivedAt,
      originalEvent.eventId,
      JSON.stringify(originalEvent),
      String(10 * 60),
    );
    expect(mocks.restoreLinkCode).toHaveBeenCalledWith(
      'link-abcdefghijklmnop',
      'roomote-user-1',
    );
  });

  it('replays a pending configured-channel request after linking', async () => {
    const originalEvent = envelope(
      message({
        channel_id: 'channel-1',
        guild_id: 'guild-1',
        content: 'A new bug report',
      }),
    );
    mocks.consumeLinkCode.mockResolvedValue('roomote-user-1');
    mocks.redisGetdel.mockResolvedValue(JSON.stringify(originalEvent));
    mocks.channelAutoStart.mockResolvedValue(true);
    mocks.getChannel.mockImplementation(async (channelId: string) =>
      channelId === 'dm-1'
        ? { id: 'dm-1', name: 'Direct message', type: 1 }
        : {
            id: 'channel-1',
            guildId: 'guild-1',
            name: 'bugs',
            type: 0,
          },
    );
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
    expect(mocks.channelAutoStart).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining(originalEvent),
      }),
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          'I also picked up your most recent task request.',
        ),
      }),
    );
  });

  it('preserves a pending reaction target after account linking', async () => {
    const eventId =
      'channel-1:message-target:discord-user-1:white_check_mark:42';
    const originalEvent = {
      eventId,
      eventType: 'MESSAGE_CREATE' as const,
      receivedAt: '2026-07-12T15:00:00.000Z',
      reactionTarget: {
        channelId: 'channel-1',
        messageId: 'message-target',
      },
      payload: {
        id: eventId,
        channel_id: 'channel-1',
        guild_id: 'guild-1',
        content: '<@bot-1> Act on this',
        author: { id: 'discord-user-1', username: 'matt' },
        mentions: [{ id: 'bot-1', username: 'Roomote', bot: true }],
        attachments: [],
        message_reference: {
          message_id: 'message-target',
          channel_id: 'channel-1',
        },
      },
    };
    mocks.consumeLinkCode.mockResolvedValue('roomote-user-1');
    mocks.redisGetdel.mockResolvedValue(JSON.stringify(originalEvent));
    mocks.getChannel.mockImplementation(async (channelId: string) =>
      channelId === 'dm-1'
        ? { id: 'dm-1', name: 'Direct message', type: 1 }
        : {
            id: 'channel-1',
            guildId: 'guild-1',
            name: 'general',
            type: 0,
          },
    );
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

    mocks.getMessage.mockResolvedValue({
      provider: 'discord',
      id: 'message-target',
      user: 'discord-user-2',
      text: 'Deploys are failing on main',
      channelId: 'channel-1',
      fileCount: 0,
    });

    const response = await postEvent(
      envelope(interaction, 'INTERACTION_CREATE'),
    );

    expect(response.status).toBe(200);
    // The replayed reaction summon enters the fast agent anchored on the
    // reacted-on message, matching direct reaction entry.
    expect(mocks.getMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'message-target',
    });
    expect(mocks.createThreadFromMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'channel-1',
        messageId: 'message-target',
      }),
    );
    expect(mocks.answerFast).toHaveBeenCalledWith(
      expect.objectContaining({
        question:
          'Act on this\n\nMessage to act on:\nDeploys are failing on main',
        currentMessageId: 'message-target',
      }),
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
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
