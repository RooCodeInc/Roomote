import type { DiscordGatewayEvent } from '@roomote/communication/discord-event';
import { DiscordApiError } from '@roomote/communication/discord-provider';

const mocks = vi.hoisted(() => ({
  redis: {
    sismember: vi.fn(),
    scard: vi.fn(),
    ttl: vi.fn(),
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
  },
  getBackgroundAgentSettings: vi.fn(),
  syncAutoStartChannelCache: vi.fn(),
  findMappedUserId: vi.fn(),
  evaluateGate: vi.fn(),
  processAttachments: vi.fn(),
  startNewTask: vi.fn(),
  createDirectMessage: vi.fn(),
  postMessage: vi.fn(),
  addReaction: vi.fn(),
}));

vi.mock('@roomote/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/redis')>();
  return {
    ...actual,
    getRedis: () => mocks.redis,
    syncAutoStartChannelCacheBestEffort: mocks.syncAutoStartChannelCache,
  };
});

vi.mock('@roomote/db/server', () => ({
  getBackgroundAgentSettingsForDeployment: mocks.getBackgroundAgentSettings,
}));

vi.mock('@roomote/sdk/server', () => ({
  findDiscordMappedUserId: mocks.findMappedUserId,
}));

vi.mock('../../shared/channel-launch-gate.js', () => ({
  evaluateChannelLaunchGate: mocks.evaluateGate,
}));

vi.mock('../attachments.js', () => ({
  processDiscordAttachments: mocks.processAttachments,
}));

vi.mock('../task-orchestration.js', () => ({
  startNewDiscordTask: mocks.startNewTask,
}));

vi.mock('../../../logging.js', () => ({
  apiLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { maybeHandleDiscordChannelAutoStart } from '../channel-auto-start.js';
import type { DiscordChannelContext } from '../task-launch.js';

const provider = {
  createDirectMessage: mocks.createDirectMessage,
  postMessage: mocks.postMessage,
  addReaction: mocks.addReaction,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const MONITORED_CHANNEL_ID = '400000000000000001';

function guildChannel(
  overrides: Partial<DiscordChannelContext> = {},
): DiscordChannelContext {
  return {
    channelId: MONITORED_CHANNEL_ID,
    channelName: 'bugs',
    channelType: 0,
    guildId: 'guild-1',
    isDirectMessage: false,
    isThread: false,
    ...overrides,
  };
}

function messagePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'message-1',
    channel_id: MONITORED_CHANNEL_ID,
    guild_id: 'guild-1',
    type: 0,
    content: 'The login page 500s on refresh',
    author: { id: 'discord-user-1', username: 'matt' },
    mentions: [],
    attachments: [],
    ...overrides,
  };
}

function gatewayEvent(payload: Record<string, unknown>): DiscordGatewayEvent {
  return {
    eventId: String(payload.id),
    eventType: 'MESSAGE_CREATE',
    payload,
    receivedAt: '2026-07-17T15:00:00.000Z',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function settingsWith(
  targets: Array<{
    channelId: string;
    instructions?: string | null;
    launchCriteria?: string | null;
  }>,
) {
  return {
    channelAutoStartEnabled: targets.length > 0,
    channelAutoStartDiscordChannels: targets.map((target) => ({
      channelId: target.channelId,
      instructions: target.instructions ?? null,
      launchMode: 'always_start' as const,
      launchCriteria: target.launchCriteria ?? null,
    })),
  };
}

async function runHandler(input: {
  payload?: Record<string, unknown>;
  channel?: DiscordChannelContext;
}) {
  const payload = input.payload ?? messagePayload();
  return maybeHandleDiscordChannelAutoStart({
    event: gatewayEvent(payload),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    message: payload as any,
    channel: input.channel ?? guildChannel(),
    provider,
    applicationId: 'app-1',
    botUserId: 'bot-1',
  });
}

async function flushBackgroundWork() {
  // The launch pipeline runs in a detached IIFE after the handler returns.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('maybeHandleDiscordChannelAutoStart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Cache: monitored-channel hit with a live TTL.
    mocks.redis.sismember.mockResolvedValue(1);
    mocks.redis.ttl.mockResolvedValue(42);
    mocks.redis.scard.mockResolvedValue(1);
    // Routing lock + nudge dedupe acquire successfully.
    mocks.redis.set.mockResolvedValue('OK');
    mocks.redis.get.mockResolvedValue(null);
    mocks.redis.del.mockResolvedValue(1);
    mocks.getBackgroundAgentSettings.mockResolvedValue(
      settingsWith([
        {
          channelId: MONITORED_CHANNEL_ID,
          instructions: 'Treat each message as a bug report.',
        },
      ]),
    );
    mocks.findMappedUserId.mockResolvedValue('roomote-user-1');
    mocks.evaluateGate.mockResolvedValue({
      shouldLaunch: true,
      debug: { llmDecision: 'launch', reason: 'ok' },
    });
    mocks.processAttachments.mockResolvedValue({
      images: [],
      attachmentTexts: [],
      warnings: [],
    });
    mocks.startNewTask.mockResolvedValue({ status: 'started' });
    mocks.createDirectMessage.mockResolvedValue({ id: 'dm-1' });
    mocks.postMessage.mockResolvedValue({ messageId: 'dm-message-1' });
    mocks.addReaction.mockResolvedValue(undefined);
  });

  describe('qualification', () => {
    it.each([
      ['a DM', { channel: guildChannel({ isDirectMessage: true }) }],
      ['a thread', { channel: guildChannel({ isThread: true }) }],
      ['a forum channel', { channel: guildChannel({ channelType: 15 }) }],
      ['a voice channel', { channel: guildChannel({ channelType: 2 }) }],
      ['a system message', { payload: messagePayload({ type: 6 }) }],
      [
        "Roomote's own message",
        {
          payload: messagePayload({
            author: { id: 'bot-1', username: 'roomote', bot: true },
          }),
        },
      ],
      ['an empty message', { payload: messagePayload({ content: '   ' }) }],
    ])('ignores %s without touching Redis', async (_label, input) => {
      await expect(runHandler(input)).resolves.toBe(false);
      expect(mocks.redis.sismember).not.toHaveBeenCalled();
      expect(mocks.startNewTask).not.toHaveBeenCalled();
    });

    it('accepts reply-type messages (type 19)', async () => {
      await expect(
        runHandler({ payload: messagePayload({ type: 19 }) }),
      ).resolves.toBe(true);
    });
  });

  it('fast-rejects via the empty cache sentinel without loading settings', async () => {
    mocks.redis.sismember
      .mockResolvedValueOnce(0) // channel membership
      .mockResolvedValueOnce(1); // empty sentinel

    await expect(runHandler({})).resolves.toBe(false);
    expect(mocks.getBackgroundAgentSettings).not.toHaveBeenCalled();
  });

  it('declines unconfigured channels and refreshes a stale cache', async () => {
    mocks.getBackgroundAgentSettings.mockResolvedValue(
      settingsWith([{ channelId: '400000000000000999' }]),
    );

    await expect(runHandler({})).resolves.toBe(false);
    expect(mocks.syncAutoStartChannelCache).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'discord:auto-start-channel',
        channelIds: ['400000000000000999'],
      }),
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('launches a linked-human message with instructions as the prompt prefix', async () => {
    await expect(runHandler({})).resolves.toBe(true);
    await flushBackgroundWork();

    expect(mocks.addReaction).toHaveBeenCalledWith({
      channelId: MONITORED_CHANNEL_ID,
      messageId: 'message-1',
      name: '👀',
    });
    expect(mocks.startNewTask).toHaveBeenCalledWith(
      expect.objectContaining({
        skipRoutingConfirmation: true,
        launchOwnerUserId: 'roomote-user-1',
        intakeAckPinned: true,
        channelAutoStart: {
          agentPromptPrefix: 'Treat each message as a bug report.',
          initiator: {
            kind: 'user',
            externalId: 'discord-user-1',
            displayName: 'matt',
            matchedUserId: 'roomote-user-1',
          },
        },
      }),
    );
    // The gate is not consulted when no launch criteria are configured.
    expect(mocks.evaluateGate).not.toHaveBeenCalled();
  });

  it('DMs an unlinked human a link nudge and never launches', async () => {
    mocks.findMappedUserId.mockResolvedValue(null);

    await expect(runHandler({})).resolves.toBe(true);
    await flushBackgroundWork();

    expect(mocks.createDirectMessage).toHaveBeenCalledWith('discord-user-1');
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'dm-1',
        text: expect.stringContaining('/link code:<code>'),
      }),
    );
    expect(mocks.postMessage.mock.calls[0]?.[0]?.text).toMatch(
      /\[Settings → Personal → Linked Accounts\]\([^)]+\/settings\/personal\)/,
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
    expect(mocks.addReaction).not.toHaveBeenCalled();
  });

  it('dedupes the link nudge per user', async () => {
    mocks.findMappedUserId.mockResolvedValue(null);
    mocks.redis.set.mockResolvedValue(null); // dedupe key already present
    mocks.redis.get.mockResolvedValue('sent');

    await expect(runHandler({})).resolves.toBe(true);
    expect(mocks.createDirectMessage).not.toHaveBeenCalled();
  });

  it('releases the nudge dedupe slot when DMs are blocked', async () => {
    mocks.findMappedUserId.mockResolvedValue(null);
    mocks.postMessage.mockRejectedValue(
      new DiscordApiError({
        method: 'POST',
        path: '/channels/dm-1/messages',
        status: 403,
        message: 'Cannot send messages to this user',
        code: 50007,
      }),
    );

    await expect(runHandler({})).resolves.toBe(true);
    expect(mocks.redis.del).toHaveBeenCalledWith(
      'discord:account-link-dm:discord-user-1',
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a bot author',
      messagePayload({
        author: { id: 'alert-bot', username: 'alerts', bot: true },
      }),
    ],
    [
      'a webhook author',
      messagePayload({
        author: { id: 'webhook-1', username: 'deploys' },
        webhook_id: 'webhook-1',
      }),
    ],
  ])(
    'launches %s as an automation-owned task without a launch owner',
    async (_label, payload) => {
      await expect(runHandler({ payload })).resolves.toBe(true);
      await flushBackgroundWork();

      expect(mocks.findMappedUserId).not.toHaveBeenCalled();
      const call = mocks.startNewTask.mock.calls[0]?.[0];
      expect(call.launchOwnerUserId).toBeUndefined();
      expect(call.channelAutoStart.initiator).toEqual({
        kind: 'automation',
        key: 'slack_channel_auto_start',
        actor: {
          externalId: payload.author.id,
          displayName: payload.author.username,
        },
      });
    },
  );

  it('consults the launch gate when criteria are configured and stays silent on skip', async () => {
    mocks.getBackgroundAgentSettings.mockResolvedValue(
      settingsWith([
        {
          channelId: MONITORED_CHANNEL_ID,
          launchCriteria: 'Only launch on new incidents.',
        },
      ]),
    );
    mocks.evaluateGate.mockResolvedValue({
      shouldLaunch: false,
      skipReason: 'criteria_not_met',
      debug: { llmDecision: 'skip', reason: 'not an incident' },
    });

    await expect(runHandler({})).resolves.toBe(true);
    await flushBackgroundWork();

    expect(mocks.evaluateGate).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'discord',
        channelId: MONITORED_CHANNEL_ID,
        launchCriteria: 'Only launch on new incidents.',
        isBotAuthored: false,
      }),
    );
    expect(mocks.startNewTask).not.toHaveBeenCalled();
    expect(mocks.addReaction).not.toHaveBeenCalled();
    // The routing lock is released so a redelivery can re-evaluate.
    expect(mocks.redis.del).toHaveBeenCalledWith(
      'discord:routing-lock:message-1',
    );
  });

  it('dedupes concurrent deliveries via the routing lock', async () => {
    mocks.redis.set.mockResolvedValue(null); // lock already held

    await expect(runHandler({})).resolves.toBe(true);
    await flushBackgroundWork();

    expect(mocks.startNewTask).not.toHaveBeenCalled();
  });

  it('never lets a reaction failure abort the launch', async () => {
    mocks.addReaction.mockRejectedValue(new Error('rate limited'));

    await expect(runHandler({})).resolves.toBe(true);
    await flushBackgroundWork();

    expect(mocks.startNewTask).toHaveBeenCalledTimes(1);
    const startArgs = mocks.startNewTask.mock.calls[0]![0] as {
      intakeAckPinned?: boolean;
    };
    expect(startArgs.intakeAckPinned).toBeUndefined();
  });

  it('releases the routing lock when the launch fails', async () => {
    mocks.startNewTask.mockRejectedValue(new Error('boom'));

    await expect(runHandler({})).resolves.toBe(true);
    await flushBackgroundWork();

    expect(mocks.redis.del).toHaveBeenCalledWith(
      'discord:routing-lock:message-1',
    );
  });
});
