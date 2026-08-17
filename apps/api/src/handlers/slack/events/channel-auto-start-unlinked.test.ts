import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  fastAgentMessageMock,
  showConnectAccountMock,
  startTaskMock,
  userMappingRowsMock,
  evaluateGateMock,
  postRoutingDebugMock,
} = vi.hoisted(() => ({
  fastAgentMessageMock: vi.fn(),
  showConnectAccountMock: vi.fn(),
  startTaskMock: vi.fn(),
  userMappingRowsMock: vi.fn(),
  evaluateGateMock: vi.fn(),
  postRoutingDebugMock: vi.fn(),
}));

const { enrichSlackMessageEventMock, isRoomoteAuthoredSlackEventMock } =
  vi.hoisted(() => ({
    enrichSlackMessageEventMock: vi.fn(),
    isRoomoteAuthoredSlackEventMock: vi.fn(() => false),
  }));

vi.mock('@roomote/env', () => ({
  Env: {
    TRPC_URL: null,
    R_APP_URL: 'http://localhost:3000',
    R_COMMUNICATIONS_FAST_MODE_SETTING_ENABLED: true,
  },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  ROUTING_AUTO_CONFIRM_TIMEOUT_MS: 0,
}));

vi.mock('@roomote/cloud-agents', () => ({
  stripLeadingRawSlackMention: vi.fn((text: string) => text),
  stripLeadingSlackProductMention: vi.fn((text: string) => text),
}));

vi.mock('../helpers/event-normalization.js', () => ({
  enrichSlackMessageEvent: enrichSlackMessageEventMock,
  isRoomoteAuthoredSlackEvent: isRoomoteAuthoredSlackEventMock,
  isRoutableAutomatedSlackAppMention: vi.fn(() => false),
}));

vi.mock('@roomote/slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/slack')>()),
  resolveSlackReactionNames: vi.fn().mockResolvedValue({
    ackEmoji: 'eyes',
    completionEmoji: 'white_check_mark',
  }),
  showConnectAccount: showConnectAccountMock,
  startAutoRoutedSlackTask: startTaskMock,
}));

vi.mock('./fast-agent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fast-agent.js')>()),
  processFastAgentMessage: fastAgentMessageMock,
}));

vi.mock('../../shared/channel-launch-gate.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../shared/channel-launch-gate.js')
  >()),
  evaluateChannelLaunchGate: evaluateGateMock,
}));

vi.mock('../helpers/channel-auto-start-routing-debug.js', () => ({
  postChannelAutoStartRoutingDebug: postRoutingDebugMock,
}));

const redisClientMock = {
  sismember: vi.fn().mockResolvedValue(1),
  ttl: vi.fn().mockResolvedValue(60),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  sadd: vi.fn().mockResolvedValue(1),
};

vi.mock('@roomote/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/redis')>()),
  getRedis: () => redisClientMock,
}));

const backgroundAgentSettings = {
  channelAutoStartEnabled: true,
  channelAutoStartSlackChannels: [
    {
      channelId: 'C123',
      instructions: null,
      launchMode: 'always',
      launchCriteria: 'Only respond when the message is directed at Roomote.',
    },
  ],
  channelAutoStartSlackChannelIds: ['C123'],
  channelAutoStartInstructions: null,
};

const userMappingSelectChain = () => ({
  from: vi.fn(() => ({
    leftJoin: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: userMappingRowsMock,
      })),
    })),
  })),
});

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  db: { select: vi.fn(() => userMappingSelectChain()) },
  getBackgroundAgentSettingsForDeployment: vi
    .fn()
    .mockResolvedValue(backgroundAgentSettings),
}));

describe('channel auto-start unlinked author', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    showConnectAccountMock.mockResolvedValue(undefined);
    fastAgentMessageMock.mockResolvedValue(undefined);
    userMappingRowsMock.mockResolvedValue([]);
    evaluateGateMock.mockResolvedValue({
      shouldLaunch: true,
      debug: { llmDecision: 'launch', reason: 'Roomote was addressed.' },
    });
    postRoutingDebugMock.mockResolvedValue(undefined);
  });

  it('prompts an unlinked human author to connect their account instead of silently skipping', async () => {
    const { handleMessageOrAppMentionEvent } =
      await import('./message-entry.js');

    const event = {
      type: 'message',
      channel: 'C123',
      user: 'U456',
      text: 'please look into this',
      ts: '111.000',
      channel_type: 'channel',
    };

    await handleMessageOrAppMentionEvent({
      event: event as never,
      context: {
        slackInstallation: { teamId: 'T123', botUserId: 'UBOT' } as never,
        slack: {
          getChannelName: vi.fn().mockResolvedValue('general'),
          normalizeIncomingText: vi.fn(async (value: string) => value),
          postMessage: vi.fn(),
        } as never,
        teamId: 'T123',
      } as never,
    });

    expect(showConnectAccountMock).toHaveBeenCalledTimes(1);
    expect(showConnectAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message',
        channel: 'C123',
        user: 'U456',
        ts: '111.000',
      }),
      expect.objectContaining({ teamId: 'T123' }),
      expect.anything(),
    );
  }, 30000);

  it('routes an opted-in linked author to Fast mode after the shared gate accepts a Roomote-directed message', async () => {
    userMappingRowsMock.mockResolvedValue([
      {
        id: 'mapping-1',
        slackUserId: 'U456',
        slackTeamId: 'T123',
        userId: 'user-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        matchedUserId: 'user-1',
        userDeletedAt: null,
        userMetadata: { communications_fast_mode_default: true },
      },
    ]);
    const { handleMessageOrAppMentionEvent } =
      await import('./message-entry.js');

    await handleMessageOrAppMentionEvent({
      event: {
        type: 'message',
        channel: 'C123',
        user: 'U456',
        text: '<@UBOT> please look into this',
        ts: '112.000',
        channel_type: 'channel',
      } as never,
      context: {
        slackInstallation: { teamId: 'T123', botUserId: 'UBOT' } as never,
        slack: {
          getChannelName: vi.fn().mockResolvedValue('general'),
          normalizeIncomingText: vi.fn(async (value: string) => value),
          postMessage: vi.fn(),
        } as never,
        teamId: 'T123',
      } as never,
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(fastAgentMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        continuation: true,
        event: expect.objectContaining({
          text: '<@UBOT> please look into this',
          user: 'U456',
        }),
        teamId: 'T123',
        userId: 'user-1',
      }),
    );
    expect(evaluateGateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        botMentioned: true,
        launchCriteria: 'Only respond when the message is directed at Roomote.',
      }),
    );
    expect(startTaskMock).not.toHaveBeenCalled();
  }, 30000);

  it.each([
    ['a message addressing another user', '<@U999> what do you think?'],
    ['an ambiguous conversational message', 'I think that is probably right'],
  ])(
    'keeps Fast mode silent for %s when the shared gate skips it',
    async (_label, text) => {
      userMappingRowsMock.mockResolvedValue([
        {
          id: 'mapping-1',
          slackUserId: 'U456',
          slackTeamId: 'T123',
          userId: 'user-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          matchedUserId: 'user-1',
          userDeletedAt: null,
          userMetadata: { communications_fast_mode_default: true },
        },
      ]);
      evaluateGateMock.mockResolvedValue({
        shouldLaunch: false,
        skipReason: 'criteria_not_met',
        debug: { llmDecision: 'skip', reason: 'Peer conversation.' },
      });
      const { handleMessageOrAppMentionEvent } =
        await import('./message-entry.js');

      await handleMessageOrAppMentionEvent({
        event: {
          type: 'message',
          channel: 'C123',
          user: 'U456',
          text,
          ts: '113.000',
          channel_type: 'channel',
        } as never,
        context: {
          slackInstallation: { teamId: 'T123', botUserId: 'UBOT' } as never,
          slack: {
            getChannelName: vi.fn().mockResolvedValue('general'),
            normalizeIncomingText: vi.fn(async (value: string) => value),
          } as never,
          teamId: 'T123',
        } as never,
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(evaluateGateMock).toHaveBeenCalled();
      expect(fastAgentMessageMock).not.toHaveBeenCalled();
      expect(startTaskMock).not.toHaveBeenCalled();
    },
    30000,
  );
});
