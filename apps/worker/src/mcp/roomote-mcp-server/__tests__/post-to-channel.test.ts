vi.mock('../local-file-upload.js', () => ({
  prepareLocalArtifactUpload: vi.fn(),
  uploadPreparedArtifact: vi.fn(),
}));

vi.mock('../slack-api-client.js', () => ({
  postToChannel: vi.fn(),
}));

import {
  prepareLocalArtifactUpload,
  uploadPreparedArtifact,
} from '../local-file-upload.js';
import { postToChannel } from '../slack-api-client.js';
import { handlePostToChannel } from '../post-to-channel.js';
import type { ArtifactConfig, RoomoteConfig } from '../types.js';

const artifactConfig: ArtifactConfig = {
  token: 'artifact-token',
  platformApiUrl: 'https://app.example.com',
  workspacePath: '/workspace',
};

const roomoteConfig: RoomoteConfig = {
  token: 'run-token',
  platformApiUrl: 'https://platform.example.com',
};

describe('handlePostToChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires a channel', async () => {
    const result = await handlePostToChannel(
      { taskId: 'task-1', channel: '   ', text: 'hello' },
      artifactConfig,
      roomoteConfig,
    );

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: false,
      error: 'channel is required',
    });
  });

  it('accepts channel IDs and Slack channel mentions', async () => {
    vi.mocked(postToChannel).mockResolvedValue({
      messageTs: '111.222',
      channelId: 'C123ABC456',
    });

    const channelIdResult = await handlePostToChannel(
      { taskId: 'task-1', channel: 'C123ABC456', text: 'hello' },
      artifactConfig,
      roomoteConfig,
    );
    const mentionResult = await handlePostToChannel(
      {
        taskId: 'task-1',
        channel: '<#C123ABC456|eng>',
        text: 'hello',
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToChannel).toHaveBeenNthCalledWith(1, roomoteConfig, {
      channel: 'C123ABC456',
      text: 'hello',
    });
    expect(postToChannel).toHaveBeenNthCalledWith(2, roomoteConfig, {
      channel: 'C123ABC456',
      text: 'hello',
    });
    expect(JSON.parse(channelIdResult.content[0]!.text)).toEqual({
      success: true,
      messageTs: '111.222',
      channelId: 'C123ABC456',
    });
    expect(JSON.parse(mentionResult.content[0]!.text)).toEqual({
      success: true,
      messageTs: '111.222',
      channelId: 'C123ABC456',
    });
  });

  it('normalizes lowercase channel IDs and mentions', async () => {
    vi.mocked(postToChannel).mockResolvedValue({
      messageTs: '111.222',
      channelId: 'C123ABC456',
    });

    await handlePostToChannel(
      { taskId: 'task-1', channel: 'c123abc456', text: 'hello' },
      artifactConfig,
      roomoteConfig,
    );
    await handlePostToChannel(
      {
        taskId: 'task-1',
        channel: '<#c123abc456|eng>',
        text: 'hello',
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToChannel).toHaveBeenNthCalledWith(1, roomoteConfig, {
      channel: 'C123ABC456',
      text: 'hello',
    });
    expect(postToChannel).toHaveBeenNthCalledWith(2, roomoteConfig, {
      channel: 'C123ABC456',
      text: 'hello',
    });
  });

  it('accepts direct-message IDs', async () => {
    vi.mocked(postToChannel).mockResolvedValue({
      messageTs: '111.222',
      channelId: 'D123ABC456',
    });

    await handlePostToChannel(
      { taskId: 'task-1', channel: 'D123ABC456', text: 'hello' },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToChannel).toHaveBeenCalledWith(roomoteConfig, {
      channel: 'D123ABC456',
      text: 'hello',
    });
  });

  it('normalizes lowercase direct-message IDs', async () => {
    vi.mocked(postToChannel).mockResolvedValue({
      messageTs: '111.222',
      channelId: 'D123ABC456',
    });

    await handlePostToChannel(
      { taskId: 'task-1', channel: 'd123abc456', text: 'hello' },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToChannel).toHaveBeenCalledWith(roomoteConfig, {
      channel: 'D123ABC456',
      text: 'hello',
    });
  });

  it('accepts Slack user IDs and mentions for direct messages', async () => {
    vi.mocked(postToChannel).mockResolvedValue({
      messageTs: '111.222',
      channelId: 'D123ABC456',
    });

    await handlePostToChannel(
      { taskId: 'task-1', channel: 'U123ABC456', text: 'hello' },
      artifactConfig,
      roomoteConfig,
    );
    await handlePostToChannel(
      { taskId: 'task-1', channel: '<@U123ABC456|person>', text: 'hello' },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToChannel).toHaveBeenNthCalledWith(1, roomoteConfig, {
      channel: 'U123ABC456',
      text: 'hello',
    });
    expect(postToChannel).toHaveBeenNthCalledWith(2, roomoteConfig, {
      channel: 'U123ABC456',
      text: 'hello',
    });
  });

  it('rejects calls without text or images', async () => {
    const result = await handlePostToChannel(
      { taskId: 'task-1', channel: '#eng' },
      artifactConfig,
      roomoteConfig,
    );

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: false,
      error:
        'At least one of text, imagePaths, or imageArtifactIds is required',
    });
  });

  it('posts text-only messages', async () => {
    vi.mocked(postToChannel).mockResolvedValue({
      messageTs: '111.222',
      channelId: 'C123',
    });

    const result = await handlePostToChannel(
      {
        taskId: 'task-1',
        channel: 'eng',
        threadTs: '999.000',
        text: 'share this update',
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToChannel).toHaveBeenCalledWith(roomoteConfig, {
      channel: '#eng',
      threadTs: '999.000',
      text: 'share this update',
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: true,
      messageTs: '111.222',
      channelId: 'C123',
    });
  });

  it('strips citation artifacts from Slack channel posts', async () => {
    vi.mocked(postToChannel).mockResolvedValue({
      messageTs: '777.888',
      channelId: 'C123',
    });

    await handlePostToChannel(
      {
        taskId: 'task-1',
        channel: 'eng',
        text: 'Current status is available. \uE200cite\uE202turn0open0\uE202turn0find0\uE201',
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToChannel).toHaveBeenCalledWith(roomoteConfig, {
      channel: '#eng',
      text: 'Current status is available.',
    });
  });

  it('uploads image paths before posting to Slack', async () => {
    vi.mocked(prepareLocalArtifactUpload).mockResolvedValue({
      filePath: '/workspace/screenshots/after.png',
      artifactPath: 'screenshots/after.png',
      contentType: 'image/png',
      content: Buffer.from([0x89, 0x50]),
    });
    vi.mocked(uploadPreparedArtifact).mockResolvedValue({
      artifactId: 'art-1',
      version: 1,
      artifactType: 'general',
      viewUrl:
        'https://app.example.com/task/task-1/artifacts/screenshots/after.png?v=1',
      rawUrl: 'https://app.example.com/api/artifacts/art-1/raw',
    });
    vi.mocked(postToChannel).mockResolvedValue({
      messageTs: '111.222',
      channelId: 'C123',
    });

    const result = await handlePostToChannel(
      {
        taskId: 'task-1',
        channel: 'eng',
        imagePaths: ['screenshots/after.png'],
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(prepareLocalArtifactUpload).toHaveBeenCalledWith(
      'screenshots/after.png',
      '/workspace',
    );
    expect(uploadPreparedArtifact).toHaveBeenCalledTimes(1);
    expect(postToChannel).toHaveBeenCalledWith(roomoteConfig, {
      channel: '#eng',
      images: [{ artifactId: 'art-1' }],
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: true,
      messageTs: '111.222',
      channelId: 'C123',
      uploadedArtifactIds: ['art-1'],
    });
  });

  it('passes through existing image artifact ids', async () => {
    vi.mocked(postToChannel).mockResolvedValue({
      messageTs: '333.444',
      channelId: 'C999',
    });

    const result = await handlePostToChannel(
      {
        taskId: 'task-1',
        channel: 'eng',
        imageArtifactIds: ['art-1', 'art-2'],
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToChannel).toHaveBeenCalledWith(roomoteConfig, {
      channel: '#eng',
      images: [{ artifactId: 'art-1' }, { artifactId: 'art-2' }],
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: true,
      messageTs: '333.444',
      channelId: 'C999',
      imageArtifactIds: ['art-1', 'art-2'],
    });
  });

  it('returns created artifact ids when Slack posting fails after upload', async () => {
    vi.mocked(prepareLocalArtifactUpload).mockResolvedValue({
      filePath: '/workspace/screenshots/after.png',
      artifactPath: 'screenshots/after.png',
      contentType: 'image/png',
      content: Buffer.from([0x89, 0x50]),
    });
    vi.mocked(uploadPreparedArtifact).mockResolvedValue({
      artifactId: 'art-1',
      version: 1,
      artifactType: 'general',
      viewUrl: 'https://app.example.com/view',
    });
    vi.mocked(postToChannel).mockRejectedValue(
      new Error('Slack API unavailable'),
    );

    const result = await handlePostToChannel(
      {
        taskId: 'task-1',
        channel: 'eng',
        imagePaths: ['screenshots/after.png'],
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: false,
      error: 'Slack API unavailable',
      uploadedArtifactIds: ['art-1'],
    });
  });
});

describe('handlePostToChannel', () => {
  const originalProvider = process.env.ROOMOTE_COMMUNICATION_PROVIDER;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalProvider === undefined) {
      delete process.env.ROOMOTE_COMMUNICATION_PROVIDER;
    } else {
      process.env.ROOMOTE_COMMUNICATION_PROVIDER = originalProvider;
    }
  });

  it('passes opaque conversation ids through untouched on Teams', async () => {
    process.env.ROOMOTE_COMMUNICATION_PROVIDER = 'teams';
    vi.mocked(postToChannel).mockResolvedValue({
      messageTs: 'activity-1',
      channelId: '19:conversation@thread.v2',
    });

    const result = await handlePostToChannel(
      {
        taskId: 'task-1',
        channel: '19:conversation@thread.v2',
        text: 'update',
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToChannel).toHaveBeenCalledWith(roomoteConfig, {
      channel: '19:conversation@thread.v2',
      text: 'update',
    });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      success: true,
      messageTs: 'activity-1',
    });
  });

  it('passes Telegram chat ids through untouched', async () => {
    process.env.ROOMOTE_COMMUNICATION_PROVIDER = 'telegram';
    vi.mocked(postToChannel).mockResolvedValue({
      messageTs: '901',
      channelId: '-1002233445566',
    });

    await handlePostToChannel(
      { taskId: 'task-1', channel: '-1002233445566', text: 'update' },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToChannel).toHaveBeenCalledWith(roomoteConfig, {
      channel: '-1002233445566',
      text: 'update',
    });
  });

  it('passes Discord channel ids through untouched', async () => {
    process.env.ROOMOTE_COMMUNICATION_PROVIDER = 'discord';
    vi.mocked(postToChannel).mockResolvedValue({
      messageTs: 'message-1',
      channelId: '1527713580311642272',
    });

    await handlePostToChannel(
      { taskId: 'task-1', channel: '1527713580311642272', text: 'update' },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToChannel).toHaveBeenCalledWith(roomoteConfig, {
      channel: '1527713580311642272',
      text: 'update',
    });
  });

  it('falls back to Slack channel normalization without a chat provider', async () => {
    delete process.env.ROOMOTE_COMMUNICATION_PROVIDER;
    vi.mocked(postToChannel).mockResolvedValue({
      messageTs: '111.222',
      channelId: 'C123ABC456',
    });

    await handlePostToChannel(
      { taskId: 'task-1', channel: '#Eng', text: 'update' },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToChannel).toHaveBeenCalledWith(roomoteConfig, {
      channel: '#eng',
      text: 'update',
    });
  });
});
