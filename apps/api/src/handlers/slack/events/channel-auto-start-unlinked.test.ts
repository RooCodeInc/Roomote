import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  fastAgentMessageMock,
  findActiveSlackTaskRunMock,
  findCompletedSlackTaskRunWithSnapshotMock,
  hasFastAgentSessionMock,
  hasPendingRoutingConfirmationMock,
  showTaskConfigurationMock,
  showConnectAccountMock,
  startTaskMock,
  userMappingRowsMock,
} = vi.hoisted(() => ({
  fastAgentMessageMock: vi.fn(),
  findActiveSlackTaskRunMock: vi.fn(),
  findCompletedSlackTaskRunWithSnapshotMock: vi.fn(),
  hasFastAgentSessionMock: vi.fn(),
  hasPendingRoutingConfirmationMock: vi.fn(),
  showTaskConfigurationMock: vi.fn(),
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
    R_COMMUNICATIONS_FAST_MODE_SETTING_ENABLED: true,
  },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  hasFastAgentSession: hasFastAgentSessionMock,
  ROUTING_AUTO_CONFIRM_TIMEOUT_MS: 0,
}));

vi.mock('@roomote/cloud-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/cloud-agents')>()),
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
  findActiveSlackTaskRun: findActiveSlackTaskRunMock,
  findCompletedSlackTaskRunWithSnapshot:
    findCompletedSlackTaskRunWithSnapshotMock,
  hasPendingRoutingConfirmation: hasPendingRoutingConfirmationMock,
  showConnectAccount: showConnectAccountMock,
  showTaskConfiguration: showTaskConfigurationMock,
  startAutoRoutedSlackTask: startTaskMock,
}));

vi.mock('../helpers/conversation-log.js', () => ({
  findRoomoteOwnedSlackThread: vi.fn(),
  findTrackedBackgroundAutomationSlackThread: vi.fn(),
  isRoomoteOwnedSlackThread: vi.fn().mockResolvedValue(false),
  recordInboundSlackConversationMessage: vi.fn(),
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
    backgroundAgentSettings.channelAutoStartEnabled = true;
    findActiveSlackTaskRunMock.mockResolvedValue(null);
    findCompletedSlackTaskRunWithSnapshotMock.mockResolvedValue(null);
    hasFastAgentSessionMock.mockResolvedValue(false);
    hasPendingRoutingConfirmationMock.mockResolvedValue(false);
    showTaskConfigurationMock.mockResolvedValue({
      routingUsed: false,
      threadId: 'thread-1',
      startedImmediately: false,
    });
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

  it('routes an opted-in linked author with an image through attachment-aware task handling', async () => {
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
    startTaskMock.mockResolvedValue({
      status: 'started',
      threadId: '113.000',
      runId: 1,
      taskId: 'task-1',
    });
    const processSlackFiles = vi
      .fn()
      .mockResolvedValue(['data:image/png;base64,c2NyZWVuc2hvdA==']);
    const { handleMessageOrAppMentionEvent } =
      await import('./message-entry.js');

    await handleMessageOrAppMentionEvent({
      event: {
        type: 'message',
        subtype: 'file_share',
        channel: 'C123',
        user: 'U456',
        text: 'please fix this',
        ts: '113.000',
        channel_type: 'channel',
        files: [
          {
            id: 'F123',
            name: 'screenshot.png',
            mimetype: 'image/png',
            size: 1024,
          },
        ],
      } as never,
      context: {
        slackInstallation: { teamId: 'T123', botUserId: 'UBOT' } as never,
        slack: {
          addReaction: vi.fn().mockResolvedValue(true),
          processSlackFiles,
        } as never,
        teamId: 'T123',
      } as never,
    });

    expect(fastAgentMessageMock).not.toHaveBeenCalled();
    expect(processSlackFiles).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'F123', mimetype: 'image/png' }),
    ]);
    await vi.waitFor(() => {
      expect(startTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'please fix this',
          processedImages: ['data:image/png;base64,c2NyZWVuc2hvdA=='],
        }),
      );
    });
  }, 30000);

  it('routes explicit fast requests with attachments through standard task handling', async () => {
    backgroundAgentSettings.channelAutoStartEnabled = false;
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
    const event = {
      type: 'app_mention',
      channel: 'C123',
      user: 'U456',
      text: '<@UBOT> /fast inspect this screenshot',
      ts: '114.000',
      files: [
        {
          id: 'F124',
          name: 'screenshot.png',
          mimetype: 'image/png',
          size: 1024,
        },
      ],
    };
    const { handleMessageOrAppMentionEvent } =
      await import('./message-entry.js');

    await handleMessageOrAppMentionEvent({
      event: event as never,
      context: {
        slackInstallation: { teamId: 'T123', botUserId: 'UBOT' } as never,
        slack: {
          addReaction: vi.fn().mockResolvedValue(true),
          processSlackFiles: vi
            .fn()
            .mockResolvedValue(['data:image/png;base64,ZXhwbGljaXQ=']),
        } as never,
        teamId: 'T123',
      } as never,
    });

    await vi.waitFor(() => {
      expect(showTaskConfigurationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            processedImages: ['data:image/png;base64,ZXhwbGljaXQ='],
          }),
        }),
      );
    });
    expect(fastAgentMessageMock).not.toHaveBeenCalled();
  }, 30000);

  it('routes image-only replies in fast threads through standard task handling', async () => {
    backgroundAgentSettings.channelAutoStartEnabled = false;
    hasFastAgentSessionMock.mockResolvedValue(true);
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
        subtype: 'file_share',
        channel: 'D123',
        channel_type: 'im',
        thread_ts: '115.000',
        user: 'U456',
        text: '',
        ts: '116.000',
        files: [
          {
            id: 'F125',
            name: 'screenshot.png',
            mimetype: 'image/png',
            size: 1024,
          },
        ],
      } as never,
      context: {
        slackInstallation: { teamId: 'T123', botUserId: 'UBOT' } as never,
        slack: {
          addReaction: vi.fn().mockResolvedValue(true),
          fetchThreadMessages: vi.fn().mockResolvedValue([]),
          processSlackFiles: vi
            .fn()
            .mockResolvedValue(['data:image/png;base64,Zm9sbG93dXA=']),
        } as never,
        teamId: 'T123',
      } as never,
    });

    await vi.waitFor(() => {
      expect(showTaskConfigurationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            processedImages: ['data:image/png;base64,Zm9sbG93dXA='],
          }),
        }),
      );
    });
    expect(fastAgentMessageMock).not.toHaveBeenCalled();
    expect(hasFastAgentSessionMock).not.toHaveBeenCalled();
  }, 30000);
});
