vi.mock('../local-file-upload.js', () => ({
  prepareLocalArtifactUpload: vi.fn(),
  uploadPreparedArtifact: vi.fn(),
}));

vi.mock('../slack-api-client.js', () => ({
  postToSlackChannel: vi.fn(),
}));

import {
  prepareLocalArtifactUpload,
  uploadPreparedArtifact,
} from '../local-file-upload.js';
import { postToSlackChannel } from '../slack-api-client.js';
import {
  handlePostToChannel,
  handlePostToSlackChannel,
} from '../post-to-slack-channel.js';
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

describe('handlePostToSlackChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires a channel', async () => {
    const result = await handlePostToSlackChannel(
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
    vi.mocked(postToSlackChannel).mockResolvedValue({
      messageTs: '111.222',
      channelId: 'C123ABC456',
    });

    const channelIdResult = await handlePostToSlackChannel(
      { taskId: 'task-1', channel: 'C123ABC456', text: 'hello' },
      artifactConfig,
      roomoteConfig,
    );
    const mentionResult = await handlePostToSlackChannel(
      {
        taskId: 'task-1',
        channel: '<#C123ABC456|eng>',
        text: 'hello',
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToSlackChannel).toHaveBeenNthCalledWith(1, roomoteConfig, {
      channel: 'C123ABC456',
      text: 'hello',
    });
    expect(postToSlackChannel).toHaveBeenNthCalledWith(2, roomoteConfig, {
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
    vi.mocked(postToSlackChannel).mockResolvedValue({
      messageTs: '111.222',
      channelId: 'C123ABC456',
    });

    await handlePostToSlackChannel(
      { taskId: 'task-1', channel: 'c123abc456', text: 'hello' },
      artifactConfig,
      roomoteConfig,
    );
    await handlePostToSlackChannel(
      {
        taskId: 'task-1',
        channel: '<#c123abc456|eng>',
        text: 'hello',
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToSlackChannel).toHaveBeenNthCalledWith(1, roomoteConfig, {
      channel: 'C123ABC456',
      text: 'hello',
    });
    expect(postToSlackChannel).toHaveBeenNthCalledWith(2, roomoteConfig, {
      channel: 'C123ABC456',
      text: 'hello',
    });
  });

  it('rejects direct-message IDs', async () => {
    const dmResult = await handlePostToSlackChannel(
      { taskId: 'task-1', channel: 'D123ABC456', text: 'hello' },
      artifactConfig,
      roomoteConfig,
    );

    expect(JSON.parse(dmResult.content[0]!.text)).toEqual({
      success: false,
      error:
        'direct message IDs are not supported; use a Slack channel ID or channel name instead',
    });
  });

  it('rejects lowercase direct-message IDs', async () => {
    const dmResult = await handlePostToSlackChannel(
      { taskId: 'task-1', channel: 'd123abc456', text: 'hello' },
      artifactConfig,
      roomoteConfig,
    );

    expect(JSON.parse(dmResult.content[0]!.text)).toEqual({
      success: false,
      error:
        'direct message IDs are not supported; use a Slack channel ID or channel name instead',
    });
  });

  it('rejects calls without text or images', async () => {
    const result = await handlePostToSlackChannel(
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
    vi.mocked(postToSlackChannel).mockResolvedValue({
      messageTs: '111.222',
      channelId: 'C123',
    });

    const result = await handlePostToSlackChannel(
      {
        taskId: 'task-1',
        channel: 'eng',
        threadTs: '999.000',
        text: 'share this update',
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToSlackChannel).toHaveBeenCalledWith(roomoteConfig, {
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
    vi.mocked(postToSlackChannel).mockResolvedValue({
      messageTs: '777.888',
      channelId: 'C123',
    });

    await handlePostToSlackChannel(
      {
        taskId: 'task-1',
        channel: 'eng',
        text: 'Current status is available. \uE200cite\uE202turn0open0\uE202turn0find0\uE201',
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToSlackChannel).toHaveBeenCalledWith(roomoteConfig, {
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
    vi.mocked(postToSlackChannel).mockResolvedValue({
      messageTs: '111.222',
      channelId: 'C123',
    });

    const result = await handlePostToSlackChannel(
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
    expect(postToSlackChannel).toHaveBeenCalledWith(roomoteConfig, {
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
    vi.mocked(postToSlackChannel).mockResolvedValue({
      messageTs: '333.444',
      channelId: 'C999',
    });

    const result = await handlePostToSlackChannel(
      {
        taskId: 'task-1',
        channel: 'eng',
        imageArtifactIds: ['art-1', 'art-2'],
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToSlackChannel).toHaveBeenCalledWith(roomoteConfig, {
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
    vi.mocked(postToSlackChannel).mockRejectedValue(
      new Error('Slack API unavailable'),
    );

    const result = await handlePostToSlackChannel(
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
    vi.mocked(postToSlackChannel).mockResolvedValue({
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

    expect(postToSlackChannel).toHaveBeenCalledWith(roomoteConfig, {
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
    vi.mocked(postToSlackChannel).mockResolvedValue({
      messageTs: '901',
      channelId: '-1002233445566',
    });

    await handlePostToChannel(
      { taskId: 'task-1', channel: '-1002233445566', text: 'update' },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToSlackChannel).toHaveBeenCalledWith(roomoteConfig, {
      channel: '-1002233445566',
      text: 'update',
    });
  });

  it('falls back to Slack channel normalization without a chat provider', async () => {
    delete process.env.ROOMOTE_COMMUNICATION_PROVIDER;
    vi.mocked(postToSlackChannel).mockResolvedValue({
      messageTs: '111.222',
      channelId: 'C123ABC456',
    });

    await handlePostToChannel(
      { taskId: 'task-1', channel: '#Eng', text: 'update' },
      artifactConfig,
      roomoteConfig,
    );

    expect(postToSlackChannel).toHaveBeenCalledWith(roomoteConfig, {
      channel: '#eng',
      text: 'update',
    });
  });
});
