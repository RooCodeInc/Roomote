vi.mock('../local-file-upload.js', () => ({
  prepareLocalArtifactUpload: vi.fn(),
  uploadPreparedArtifact: vi.fn(),
}));

vi.mock('../chat-api-client.js', () => ({
  replyToChatThread: vi.fn(),
}));

import {
  prepareLocalArtifactUpload,
  uploadPreparedArtifact,
} from '../local-file-upload.js';
import { replyToChatThread } from '../chat-api-client.js';
import { handleSendChatReply } from '../send-chat-reply.js';
import type { ArtifactConfig, RoomoteConfig } from '../types.js';

const artifactConfig: ArtifactConfig = {
  token: 'artifact-token',
  platformApiUrl: 'https://app.example.com',
  workspacePath: '/workspace',
};

const roomoteConfig: RoomoteConfig = {
  token: 'job-token',
  platformApiUrl: 'https://platform.example.com',
};

describe('handleReplyToSlackThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects calls without text or images', async () => {
    const result = await handleSendChatReply(
      { taskId: 'task-1' },
      artifactConfig,
      roomoteConfig,
    );

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: false,
      error:
        'At least one of message, summary, imagePaths, or imageArtifactIds is required',
    });
  });

  it('posts concise investigation summaries as-is', async () => {
    vi.mocked(replyToChatThread).mockResolvedValue({ messageTs: '111.222' });

    const summary =
      'Deeper work should acknowledge first, then close out in the same Slack thread.';

    const result = await handleSendChatReply(
      {
        taskId: 'task-1',
        summary,
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(replyToChatThread).toHaveBeenCalledWith(roomoteConfig, {
      text: summary,
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: true,
      messageTs: '111.222',
      summary,
    });
  });

  it('renders natural-language questions directly in the summary text', async () => {
    vi.mocked(replyToChatThread).mockResolvedValue({ messageTs: '222.333' });

    const result = await handleSendChatReply(
      {
        taskId: 'task-1',
        summary:
          'I need one detail before I can continue: which Slack workspace should I target?',
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(replyToChatThread).toHaveBeenCalledWith(roomoteConfig, {
      text: 'I need one detail before I can continue: which Slack workspace should I target?',
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: true,
      messageTs: '222.333',
      summary:
        'I need one detail before I can continue: which Slack workspace should I target?',
    });
  });

  it('strips citation artifacts from Slack summaries', async () => {
    vi.mocked(replyToChatThread).mockResolvedValue({ messageTs: '444.555' });

    await handleSendChatReply(
      {
        taskId: 'task-1',
        summary:
          'Slack does expose app-level mutation APIs. \uE200cite\uE202turn0open1\uE202turn0find1\uE201',
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(replyToChatThread).toHaveBeenCalledWith(roomoteConfig, {
      text: 'Slack does expose app-level mutation APIs.',
    });
  });

  it('posts the full multi-paragraph summary markdown without truncation', async () => {
    vi.mocked(replyToChatThread).mockResolvedValue({ messageTs: '777.888' });

    const summary = [
      'First paragraph with **Markdown**.',
      '',
      'Second paragraph keeps its spacing and [link](https://example.com).',
      '',
      '- Bullet one',
      '- Bullet two',
    ].join('\n\n');

    await handleSendChatReply(
      {
        taskId: 'task-1',
        summary,
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(replyToChatThread).toHaveBeenCalledWith(roomoteConfig, {
      text: summary,
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
    vi.mocked(replyToChatThread).mockResolvedValue({ messageTs: '111.222' });

    const result = await handleSendChatReply(
      {
        taskId: 'task-1',
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
    expect(replyToChatThread).toHaveBeenCalledWith(roomoteConfig, {
      images: [{ artifactId: 'art-1' }],
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: true,
      messageTs: '111.222',
      uploadedArtifactIds: ['art-1'],
    });
  });

  it('passes through existing image artifact ids', async () => {
    vi.mocked(replyToChatThread).mockResolvedValue({ messageTs: '333.444' });

    const result = await handleSendChatReply(
      {
        taskId: 'task-1',
        imageArtifactIds: ['art-1', 'art-2'],
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(replyToChatThread).toHaveBeenCalledWith(roomoteConfig, {
      images: [{ artifactId: 'art-1' }, { artifactId: 'art-2' }],
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: true,
      messageTs: '333.444',
      imageArtifactIds: ['art-1', 'art-2'],
    });
  });

  it('supports mixed text and image inputs', async () => {
    vi.mocked(prepareLocalArtifactUpload).mockResolvedValue({
      filePath: '/tmp/capture.png',
      artifactPath: 'tmp/capture.png',
      contentType: 'image/png',
      content: Buffer.from([0x89, 0x50]),
    });
    vi.mocked(uploadPreparedArtifact).mockResolvedValue({
      artifactId: 'art-uploaded',
      version: 1,
      artifactType: 'general',
      viewUrl: 'https://app.example.com/view',
    });
    vi.mocked(replyToChatThread).mockResolvedValue({ messageTs: '555.666' });

    await handleSendChatReply(
      {
        taskId: 'task-1',
        summary: 'see both images',
        imagePaths: ['/tmp/capture.png'],
        imageArtifactIds: ['art-existing'],
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(replyToChatThread).toHaveBeenCalledWith(roomoteConfig, {
      text: 'see both images',
      images: [{ artifactId: 'art-existing' }, { artifactId: 'art-uploaded' }],
    });
  });

  it('rejects non-image paths before posting to Slack', async () => {
    vi.mocked(prepareLocalArtifactUpload).mockResolvedValue({
      filePath: '/workspace/logs/build.txt',
      artifactPath: 'logs/build.txt',
      contentType: 'text/plain',
      content: Buffer.from('not an image'),
    });

    const result = await handleSendChatReply(
      {
        taskId: 'task-1',
        imagePaths: ['logs/build.txt'],
      },
      artifactConfig,
      roomoteConfig,
    );

    expect(uploadPreparedArtifact).not.toHaveBeenCalled();
    expect(replyToChatThread).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: false,
      error:
        'Only image attachments are supported. logs/build.txt resolved to content type text/plain.',
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
    vi.mocked(replyToChatThread).mockRejectedValue(
      new Error('Slack API unavailable'),
    );

    const result = await handleSendChatReply(
      {
        taskId: 'task-1',
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
