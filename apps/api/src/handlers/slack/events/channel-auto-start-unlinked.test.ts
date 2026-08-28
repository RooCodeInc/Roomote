import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  fastAgentMessageMock,
  showConnectAccountMock,
  startTaskMock,
  userMappingRowsMock,
} = vi.hoisted(() => ({
  fastAgentMessageMock: vi.fn(),
  showConnectAccountMock: vi.fn(),
  startTaskMock: vi.fn(),
  userMappingRowsMock: vi.fn(),
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
  createFastAgentSlackLiveTaskLauncher: vi.fn(() => vi.fn()),
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
    { channelId: 'C123', instructions: null, launchMode: 'always' },
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
        slack: {} as never,
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

  it('routes an opted-in linked author to fast mode before channel auto-start', async () => {
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
      },
    ]);
    const { handleMessageOrAppMentionEvent } =
      await import('./message-entry.js');

    await handleMessageOrAppMentionEvent({
      event: {
        type: 'message',
        channel: 'C123',
        user: 'U456',
        text: 'please look into this',
        ts: '112.000',
        channel_type: 'channel',
      } as never,
      context: {
        slackInstallation: { teamId: 'T123', botUserId: 'UBOT' } as never,
        slack: {} as never,
        teamId: 'T123',
      } as never,
    });

    expect(fastAgentMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        continuation: true,
        event: expect.objectContaining({
          text: 'please look into this',
          user: 'U456',
        }),
        teamId: 'T123',
        userId: 'user-1',
      }),
    );
    expect(startTaskMock).not.toHaveBeenCalled();
  }, 30000);
});
