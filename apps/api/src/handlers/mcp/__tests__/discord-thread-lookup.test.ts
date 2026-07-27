import {
  assertDiscordChannelAccess,
  lookupDiscordThread,
  normalizeDiscordChannelTarget,
} from '../discord-thread-lookup';

const {
  getChannelMock,
  fetchThreadMessagesMock,
  isUserInGuildMock,
  canUserAccessChannelMock,
  diagnoseChannelPermissionsMock,
} = vi.hoisted(() => ({
  getChannelMock: vi.fn(),
  fetchThreadMessagesMock: vi.fn(),
  isUserInGuildMock: vi.fn(),
  canUserAccessChannelMock: vi.fn(),
  diagnoseChannelPermissionsMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      discordUserMappings: { findFirst: vi.fn() },
    },
  },
  discordUserMappings: {
    userId: 'userId',
    updatedAt: 'updatedAt',
  },
  desc: vi.fn((value) => value),
  eq: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  createDiscordCommunicationProviderFromRuntimeCredentials: vi.fn(async () => ({
    getChannel: getChannelMock,
    fetchThreadMessages: fetchThreadMessagesMock,
    isUserInGuild: isUserInGuildMock,
    canUserAccessChannel: canUserAccessChannelMock,
    diagnoseChannelPermissions: diagnoseChannelPermissionsMock,
  })),
}));

import { db } from '@roomote/db/server';

describe('normalizeDiscordChannelTarget', () => {
  it('accepts snowflakes and message links', () => {
    expect(normalizeDiscordChannelTarget('456789012345')).toEqual({
      value: '456789012345',
    });
    expect(
      normalizeDiscordChannelTarget(
        'https://discord.com/channels/1/456789012345/9',
      ),
    ).toEqual({ value: '456789012345' });
  });
});

describe('lookupDiscordThread', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('looks up a message link for a Discord-originated job', async () => {
    getChannelMock.mockResolvedValue({
      id: '456',
      name: 'thread',
      type: 11,
      guildId: '123',
    });
    fetchThreadMessagesMock.mockResolvedValue({
      provider: 'discord',
      channelId: '456',
      requestedMessageId: '789',
      threadId: '456',
      matchedMessageIndex: 0,
      messageCount: 1,
      messages: [
        {
          provider: 'discord',
          id: '789',
          user: 'U1',
          username: 'Ada',
          text: 'from link',
          channelId: '456',
          fileCount: 0,
        },
      ],
    });

    const payload = await lookupDiscordThread({
      messageLink: 'https://discord.com/channels/123/456/789',
      taskRun: {
        actingUserId: 'user-1',
        payload: {
          communicationProvider: 'discord',
          communicationChannelId: '456',
        },
      },
    });

    expect(payload).toMatchObject({
      channelId: '456',
      requestedMessageId: '789',
      matchedMessageIndex: 0,
      messageCount: 1,
    });
    expect(isUserInGuildMock).not.toHaveBeenCalled();
    expect(fetchThreadMessagesMock).toHaveBeenCalledWith({
      channelId: '456',
      messageId: '789',
    });
  });

  it('requires a linked Discord user for explicit out-of-origin channels', async () => {
    getChannelMock.mockResolvedValue({
      id: '999000000000000001',
      name: 'other',
      type: 0,
      guildId: '123',
    });
    vi.mocked(db.query.discordUserMappings.findFirst).mockResolvedValueOnce(
      undefined as never,
    );

    await expect(
      lookupDiscordThread({
        channel: '999000000000000001',
        messageId: '789000000000000001',
        taskRun: {
          actingUserId: 'user-1',
          payload: {
            communicationProvider: 'discord',
            communicationChannelId: '456000000000000001',
          },
        },
      }),
    ).rejects.toThrow(
      'Explicit Discord lookup requires the acting user to have a linked Discord account.',
    );
  });

  it('rejects an explicit channel the linked Discord user cannot view', async () => {
    getChannelMock.mockResolvedValue({
      id: '999000000000000001',
      name: 'private',
      type: 0,
      guildId: '123',
    });
    vi.mocked(db.query.discordUserMappings.findFirst).mockResolvedValueOnce({
      discordUserId: 'discord-user-1',
    } as never);
    canUserAccessChannelMock.mockResolvedValueOnce(false);

    await expect(
      assertDiscordChannelAccess({
        provider: {
          getChannel: getChannelMock,
          canUserAccessChannel: canUserAccessChannelMock,
        } as never,
        channelId: '999000000000000001',
        isExplicitChannel: true,
        actingUserId: 'user-1',
      }),
    ).rejects.toThrow(
      'Linked Discord user cannot access channel 999000000000000001',
    );
    expect(canUserAccessChannelMock).toHaveBeenCalledWith({
      guildId: '123',
      channelId: '999000000000000001',
      userId: 'discord-user-1',
    });
  });
});
