const {
  getCommunicationProviderAdapterMock,
  findTeamsConversationServiceUrlMock,
  discordPostMessageMock,
  assertDiscordChannelAccessMock,
  getReplyImagesMock,
  slackPostMessageMock,
  slackResolveChannelIdMock,
  slackIsAppInChannelMock,
  teamsPostMessageMock,
  telegramPostMessageMock,
} = vi.hoisted(() => ({
  getCommunicationProviderAdapterMock: vi.fn(),
  findTeamsConversationServiceUrlMock: vi.fn(),
  discordPostMessageMock: vi.fn(),
  assertDiscordChannelAccessMock: vi.fn(),
  getReplyImagesMock: vi.fn(),
  slackPostMessageMock: vi.fn(),
  slackResolveChannelIdMock: vi.fn(),
  slackIsAppInChannelMock: vi.fn(),
  teamsPostMessageMock: vi.fn(),
  telegramPostMessageMock: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  getCommunicationProviderAdapter: getCommunicationProviderAdapterMock,
  findTeamsConversationServiceUrl: findTeamsConversationServiceUrlMock,
}));

vi.mock('../communication-thread-reply-shared', () => ({
  getCommunicationReplyImages: getReplyImagesMock,
}));

vi.mock('../discord-thread-lookup', () => ({
  assertDiscordChannelAccess: assertDiscordChannelAccessMock,
}));

import { sendCommunicationChannelPost } from '../communication-channel-posts';

const telegramTaskRun = {
  id: 42,
  taskId: 'task-1',
  payload: {
    communicationProvider: 'telegram',
    communicationChannelId: '-1002233445566',
    communicationThreadId: '77',
  },
};

const teamsTaskRun = {
  id: 43,
  taskId: 'task-2',
  payload: {
    communicationProvider: 'teams',
    communicationChannelId: '19:MEETING_MjJkYWJj@thread.v2',
    communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
  },
};

const discordTaskRun = {
  id: 44,
  taskId: 'task-3',
  payload: {
    communicationProvider: 'discord',
    communicationChannelId: 'channel-1',
    communicationThreadId: 'thread-1',
  },
};

async function jsonBody(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

describe('sendCommunicationChannelPost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getReplyImagesMock.mockResolvedValue({ images: [], errorResponse: null });
    findTeamsConversationServiceUrlMock.mockResolvedValue(
      'https://smba.trafficmanager.net/target/',
    );
    getCommunicationProviderAdapterMock.mockImplementation(
      async (provider: string) => {
        switch (provider) {
          case 'slack':
            return {
              provider: 'slack',
              postMessage: slackPostMessageMock,
              resolveChannelId: slackResolveChannelIdMock,
              isAppInChannel: slackIsAppInChannelMock,
            };
          case 'teams':
            return { provider: 'teams', postMessage: teamsPostMessageMock };
          case 'telegram':
            return {
              provider: 'telegram',
              postMessage: telegramPostMessageMock,
            };
          case 'discord':
            return {
              provider: 'discord',
              postMessage: discordPostMessageMock,
            };
          default:
            return null;
        }
      },
    );
    slackResolveChannelIdMock.mockResolvedValue('C123');
    slackIsAppInChannelMock.mockResolvedValue(true);
    slackPostMessageMock.mockResolvedValue({
      provider: 'slack',
      channelId: 'C123',
      messageId: '111.222',
    });
    telegramPostMessageMock.mockResolvedValue({
      provider: 'telegram',
      channelId: '-1002233445566',
      messageId: '901',
    });
    teamsPostMessageMock.mockResolvedValue({
      provider: 'teams',
      channelId: '19:MEETING_MjJkYWJj@thread.v2',
      messageId: 'activity-1',
    });
    assertDiscordChannelAccessMock.mockResolvedValue({
      guildId: 'guild-1',
      type: 0,
    });
    discordPostMessageMock.mockResolvedValue({
      provider: 'discord',
      channelId: 'thread-1',
      messageId: 'message-1',
    });
  });

  it('uses the centralized Slack adapter for tasks without another provider', async () => {
    const response = await sendCommunicationChannelPost({
      taskRun: { id: 1, taskId: 'task-0', payload: {} },
      parsedBody: { channel: '#eng', text: 'hello', images: [] },
    });

    expect(getCommunicationProviderAdapterMock).toHaveBeenCalledWith('slack', {
      slackTeamId: null,
    });
    expect(slackResolveChannelIdMock).toHaveBeenCalledWith('#eng');
    expect(slackPostMessageMock).toHaveBeenCalledWith({
      channelId: 'C123',
      text: 'hello',
      blocks: [{ type: 'markdown', text: 'hello' }],
      images: [],
    });
    await expect(jsonBody(response)).resolves.toEqual({
      messageTs: '111.222',
      channelId: 'C123',
    });
  });

  it('posts to the Telegram chat the task was launched from, defaulting to its topic', async () => {
    const response = await sendCommunicationChannelPost({
      taskRun: telegramTaskRun,
      parsedBody: { channel: '-1002233445566', text: 'update', images: [] },
    });

    expect(telegramPostMessageMock).toHaveBeenCalledWith({
      channelId: '-1002233445566',
      threadId: '77',
      text: 'update',
      textFormat: 'markdown',
      images: [],
    });
    await expect(jsonBody(response!)).resolves.toEqual({
      messageTs: '901',
      channelId: '-1002233445566',
    });
  });

  it('posts to another Telegram chat without reusing the origin topic', async () => {
    const response = await sendCommunicationChannelPost({
      taskRun: telegramTaskRun,
      parsedBody: { channel: '-1009999999999', text: 'update', images: [] },
    });

    expect(telegramPostMessageMock).toHaveBeenCalledWith({
      channelId: '-1009999999999',
      text: 'update',
      textFormat: 'markdown',
      images: [],
    });
    await expect(jsonBody(response!)).resolves.toEqual({
      messageTs: '901',
      channelId: '-1009999999999',
    });
  });

  it('returns 503 when the Telegram bot token is not configured', async () => {
    getCommunicationProviderAdapterMock.mockResolvedValueOnce(null);

    const response = await sendCommunicationChannelPost({
      taskRun: telegramTaskRun,
      parsedBody: { channel: '-1002233445566', text: 'update', images: [] },
    });

    expect(response!.status).toBe(503);
  });

  it('posts to the Teams conversation with its serviceUrl', async () => {
    const response = await sendCommunicationChannelPost({
      taskRun: teamsTaskRun,
      parsedBody: {
        channel: '19:MEETING_MjJkYWJj@thread.v2',
        text: 'update',
        images: [],
      },
    });

    expect(teamsPostMessageMock).toHaveBeenCalledWith({
      channelId: '19:MEETING_MjJkYWJj@thread.v2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      text: 'update',
      textFormat: 'markdown',
      images: [],
    });
    await expect(jsonBody(response!)).resolves.toEqual({
      messageTs: 'activity-1',
      channelId: '19:MEETING_MjJkYWJj@thread.v2',
    });
  });

  it('posts to another Teams conversation with its resolved serviceUrl', async () => {
    const response = await sendCommunicationChannelPost({
      taskRun: teamsTaskRun,
      parsedBody: { channel: '19:other@thread.v2', text: 'update', images: [] },
    });

    expect(teamsPostMessageMock).toHaveBeenCalledWith({
      channelId: '19:other@thread.v2',
      serviceUrl: 'https://smba.trafficmanager.net/target/',
      text: 'update',
      textFormat: 'markdown',
      images: [],
    });
    await expect(jsonBody(response!)).resolves.toEqual({
      messageTs: 'activity-1',
      channelId: '19:other@thread.v2',
    });
    expect(findTeamsConversationServiceUrlMock).toHaveBeenCalledWith(
      '19:other@thread.v2',
    );
  });

  it('rejects a Teams target without an active installation', async () => {
    findTeamsConversationServiceUrlMock.mockResolvedValueOnce(null);

    const response = await sendCommunicationChannelPost({
      taskRun: teamsTaskRun,
      parsedBody: {
        channel: '19:unknown@thread.v2',
        text: 'update',
        images: [],
      },
    });

    expect(response.status).toBe(404);
    await expect(jsonBody(response)).resolves.toEqual({
      error:
        'No active Teams installation found for conversation 19:unknown@thread.v2',
    });
    expect(teamsPostMessageMock).not.toHaveBeenCalled();
  });

  it('returns 503 when the task payload has no serviceUrl', async () => {
    const response = await sendCommunicationChannelPost({
      taskRun: {
        ...teamsTaskRun,
        payload: {
          communicationProvider: 'teams',
          communicationChannelId: '19:MEETING_MjJkYWJj@thread.v2',
        },
      },
      parsedBody: {
        channel: '19:MEETING_MjJkYWJj@thread.v2',
        text: 'update',
        images: [],
      },
    });

    expect(response!.status).toBe(503);
  });

  it('requires text or images', async () => {
    const response = await sendCommunicationChannelPost({
      taskRun: telegramTaskRun,
      parsedBody: { channel: '-1002233445566', text: '   ', images: [] },
    });

    expect(response!.status).toBe(400);
    expect(telegramPostMessageMock).not.toHaveBeenCalled();
  });

  it('posts to the Discord channel the task was launched from, in its own thread', async () => {
    const response = await sendCommunicationChannelPost({
      taskRun: discordTaskRun,
      parsedBody: { channel: 'channel-1', text: 'update', images: [] },
    });

    expect(discordPostMessageMock).toHaveBeenCalledWith({
      channelId: 'channel-1',
      threadId: 'thread-1',
      text: 'update',
      textFormat: 'markdown',
      images: [],
    });
    await expect(jsonBody(response!)).resolves.toEqual({
      messageTs: 'message-1',
      channelId: 'channel-1',
    });
  });

  it('posts to another Discord channel after linked-user access is verified', async () => {
    const response = await sendCommunicationChannelPost({
      taskRun: { ...discordTaskRun, actingUserId: 'user-1' },
      parsedBody: { channel: 'channel-other', text: 'update', images: [] },
    });

    expect(assertDiscordChannelAccessMock).toHaveBeenCalledWith({
      provider: expect.anything(),
      channelId: 'channel-other',
      isExplicitChannel: true,
      actingUserId: 'user-1',
      requireSendPermission: true,
    });
    expect(discordPostMessageMock).toHaveBeenCalledWith({
      channelId: 'channel-other',
      text: 'update',
      textFormat: 'markdown',
      images: [],
    });
    await expect(jsonBody(response!)).resolves.toEqual({
      messageTs: 'message-1',
      channelId: 'channel-other',
    });
  });

  it('returns the access-check error for an unauthorized Discord channel', async () => {
    const { McpProxyError } = await import('../proxy-utils');
    assertDiscordChannelAccessMock.mockRejectedValueOnce(
      new McpProxyError(403, 'Linked Discord user cannot access this channel'),
    );

    const response = await sendCommunicationChannelPost({
      taskRun: { ...discordTaskRun, actingUserId: 'user-1' },
      parsedBody: { channel: 'channel-other', text: 'update', images: [] },
    });

    expect(response!.status).toBe(403);
    await expect(jsonBody(response!)).resolves.toEqual({
      error: 'Linked Discord user cannot access this channel',
    });
    expect(discordPostMessageMock).not.toHaveBeenCalled();
  });

  it('rejects cross-channel Discord posts that target a thread', async () => {
    const response = await sendCommunicationChannelPost({
      taskRun: { ...discordTaskRun, actingUserId: 'user-1' },
      parsedBody: {
        channel: 'channel-other',
        threadTs: 'thread-other',
        text: 'update',
        images: [],
      },
    });

    expect(response!.status).toBe(400);
    expect(discordPostMessageMock).not.toHaveBeenCalled();
  });

  it('rejects a Discord thread supplied as a cross-channel target', async () => {
    assertDiscordChannelAccessMock.mockResolvedValueOnce({
      guildId: 'guild-1',
      type: 11,
    });

    const response = await sendCommunicationChannelPost({
      taskRun: { ...discordTaskRun, actingUserId: 'user-1' },
      parsedBody: { channel: 'thread-other', text: 'update', images: [] },
    });

    expect(response!.status).toBe(400);
    await expect(jsonBody(response!)).resolves.toEqual({
      error: 'Discord cross-channel posts cannot target a thread',
    });
    expect(discordPostMessageMock).not.toHaveBeenCalled();
  });

  it.each([
    ['direct message', 1],
    ['group direct message', 3],
  ])('rejects a cross-channel Discord %s target', async (_label, type) => {
    assertDiscordChannelAccessMock.mockResolvedValueOnce({ type });

    const response = await sendCommunicationChannelPost({
      taskRun: { ...discordTaskRun, actingUserId: 'user-1' },
      parsedBody: { channel: 'dm-other', text: 'update', images: [] },
    });

    expect(response!.status).toBe(403);
    await expect(jsonBody(response!)).resolves.toEqual({
      error: 'Discord cross-channel posts only support guild channels',
    });
    expect(discordPostMessageMock).not.toHaveBeenCalled();
  });

  it.each([
    ['category', 4],
    ['forum', 15],
    ['media', 16],
  ])('rejects a cross-channel Discord %s target', async (_label, type) => {
    assertDiscordChannelAccessMock.mockResolvedValueOnce({
      guildId: 'guild-1',
      type,
    });

    const response = await sendCommunicationChannelPost({
      taskRun: { ...discordTaskRun, actingUserId: 'user-1' },
      parsedBody: { channel: 'forum-other', text: 'update', images: [] },
    });

    expect(response!.status).toBe(400);
    await expect(jsonBody(response!)).resolves.toEqual({
      error:
        'Discord cross-channel posts do not support category, forum, or media channels',
    });
    expect(discordPostMessageMock).not.toHaveBeenCalled();
  });

  it('rejects Discord posts targeting a thread the task does not own', async () => {
    const response = await sendCommunicationChannelPost({
      taskRun: discordTaskRun,
      parsedBody: {
        channel: 'channel-1',
        threadTs: 'someone-elses-thread',
        text: 'update',
        images: [],
      },
    });

    expect(response!.status).toBe(403);
    expect(discordPostMessageMock).not.toHaveBeenCalled();
  });

  it("accepts a Discord threadTs that names the task's own thread", async () => {
    const response = await sendCommunicationChannelPost({
      taskRun: discordTaskRun,
      parsedBody: {
        channel: 'channel-1',
        threadTs: 'thread-1',
        text: 'update',
        images: [],
      },
    });

    expect(discordPostMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'channel-1', threadId: 'thread-1' }),
    );
    expect(response!.status).toBe(200);
  });
});
