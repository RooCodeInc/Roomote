const {
  createTeamsProviderMock,
  createTelegramProviderMock,
  getReplyImagesMock,
  teamsPostMessageMock,
  telegramPostMessageMock,
} = vi.hoisted(() => ({
  createTeamsProviderMock: vi.fn(),
  createTelegramProviderMock: vi.fn(),
  getReplyImagesMock: vi.fn(),
  teamsPostMessageMock: vi.fn(),
  telegramPostMessageMock: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  createTeamsCommunicationProviderFromRuntimeCredentials:
    createTeamsProviderMock,
  createTelegramCommunicationProviderFromRuntimeCredentials:
    createTelegramProviderMock,
}));

vi.mock('../communication-thread-reply-shared', () => ({
  getCommunicationReplyImages: getReplyImagesMock,
}));

import { maybeSendCommunicationChannelPost } from '../communication-channel-posts';

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
    communicationChannelId: '19:conversation@thread.v2',
    communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
  },
};

async function jsonBody(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

describe('maybeSendCommunicationChannelPost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getReplyImagesMock.mockResolvedValue({ images: [], errorResponse: null });
    createTelegramProviderMock.mockResolvedValue({
      postMessage: telegramPostMessageMock,
    });
    createTeamsProviderMock.mockResolvedValue({
      postMessage: teamsPostMessageMock,
    });
    telegramPostMessageMock.mockResolvedValue({
      provider: 'telegram',
      channelId: '-1002233445566',
      messageId: '901',
    });
    teamsPostMessageMock.mockResolvedValue({
      provider: 'teams',
      channelId: '19:conversation@thread.v2',
      messageId: 'activity-1',
    });
  });

  it('returns null for non-communication tasks so the Slack path runs', async () => {
    await expect(
      maybeSendCommunicationChannelPost({
        taskRun: { id: 1, taskId: 'task-0', payload: {} },
        parsedBody: { channel: 'C123', text: 'hello', images: [] },
      }),
    ).resolves.toBeNull();
  });

  it('posts to the Telegram chat the task was launched from, defaulting to its topic', async () => {
    const response = await maybeSendCommunicationChannelPost({
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

  it('rejects Telegram posts targeting a different chat', async () => {
    const response = await maybeSendCommunicationChannelPost({
      taskRun: telegramTaskRun,
      parsedBody: { channel: '-1009999999999', text: 'update', images: [] },
    });

    expect(response!.status).toBe(403);
    expect(telegramPostMessageMock).not.toHaveBeenCalled();
  });

  it('returns 503 when the Telegram bot token is not configured', async () => {
    createTelegramProviderMock.mockResolvedValue(null);

    const response = await maybeSendCommunicationChannelPost({
      taskRun: telegramTaskRun,
      parsedBody: { channel: '-1002233445566', text: 'update', images: [] },
    });

    expect(response!.status).toBe(503);
  });

  it('posts to the Teams conversation with its serviceUrl', async () => {
    const response = await maybeSendCommunicationChannelPost({
      taskRun: teamsTaskRun,
      parsedBody: {
        channel: '19:conversation@thread.v2',
        text: 'update',
        images: [],
      },
    });

    expect(teamsPostMessageMock).toHaveBeenCalledWith({
      channelId: '19:conversation@thread.v2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      text: 'update',
      textFormat: 'markdown',
      images: [],
    });
    await expect(jsonBody(response!)).resolves.toEqual({
      messageTs: 'activity-1',
      channelId: '19:conversation@thread.v2',
    });
  });

  it('rejects Teams posts targeting a different conversation', async () => {
    const response = await maybeSendCommunicationChannelPost({
      taskRun: teamsTaskRun,
      parsedBody: { channel: '19:other@thread.v2', text: 'update', images: [] },
    });

    expect(response!.status).toBe(403);
    expect(teamsPostMessageMock).not.toHaveBeenCalled();
  });

  it('rejects Teams posts when the task payload has no serviceUrl', async () => {
    const response = await maybeSendCommunicationChannelPost({
      taskRun: {
        ...teamsTaskRun,
        payload: {
          communicationProvider: 'teams',
          communicationChannelId: '19:conversation@thread.v2',
        },
      },
      parsedBody: {
        channel: '19:conversation@thread.v2',
        text: 'update',
        images: [],
      },
    });

    expect(response!.status).toBe(403);
  });

  it('requires text or images', async () => {
    const response = await maybeSendCommunicationChannelPost({
      taskRun: telegramTaskRun,
      parsedBody: { channel: '-1002233445566', text: '   ', images: [] },
    });

    expect(response!.status).toBe(400);
    expect(telegramPostMessageMock).not.toHaveBeenCalled();
  });
});
