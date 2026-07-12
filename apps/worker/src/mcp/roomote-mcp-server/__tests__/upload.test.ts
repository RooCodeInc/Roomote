import { writeFile, mkdir, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { handleUpload } from '../upload.js';
import { resetPostedProofThreadsForTest } from '../chat-proof-auto-post.js';
import type { ArtifactConfig } from '../types.js';

describe('handleUpload', () => {
  let testDir: string;
  const originalSlackChannel = process.env.ROOMOTE_SLACK_CHANNEL;
  const originalSlackThreadTs = process.env.ROOMOTE_SLACK_THREAD_TS;
  const originalCommunicationProvider =
    process.env.ROOMOTE_COMMUNICATION_PROVIDER;
  const originalCommunicationChannelId =
    process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID;
  const originalSlackProofAutoPost = process.env.ROOMOTE_SLACK_PROOF_AUTO_POST;

  const config: ArtifactConfig = {
    token: 'test-token',
    platformApiUrl: 'https://test-api.example.com',
  };

  beforeEach(async () => {
    const rawDir = join(tmpdir(), `upload-mcp-test-${Date.now()}`);
    await mkdir(rawDir, { recursive: true });
    // Use realpathSync so the canonical path matches what the handler sees
    // (on macOS, /tmp → /private/tmp).
    testDir = realpathSync(rawDir);
    delete process.env.ROOMOTE_SLACK_CHANNEL;
    delete process.env.ROOMOTE_SLACK_THREAD_TS;
    delete process.env.ROOMOTE_COMMUNICATION_PROVIDER;
    delete process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID;
    delete process.env.ROOMOTE_SLACK_PROOF_AUTO_POST;
    resetPostedProofThreadsForTest();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
    if (originalSlackChannel === undefined) {
      delete process.env.ROOMOTE_SLACK_CHANNEL;
    } else {
      process.env.ROOMOTE_SLACK_CHANNEL = originalSlackChannel;
    }
    if (originalSlackThreadTs === undefined) {
      delete process.env.ROOMOTE_SLACK_THREAD_TS;
    } else {
      process.env.ROOMOTE_SLACK_THREAD_TS = originalSlackThreadTs;
    }
    if (originalCommunicationProvider === undefined) {
      delete process.env.ROOMOTE_COMMUNICATION_PROVIDER;
    } else {
      process.env.ROOMOTE_COMMUNICATION_PROVIDER =
        originalCommunicationProvider;
    }
    if (originalCommunicationChannelId === undefined) {
      delete process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID;
    } else {
      process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID =
        originalCommunicationChannelId;
    }
    if (originalSlackProofAutoPost === undefined) {
      delete process.env.ROOMOTE_SLACK_PROOF_AUTO_POST;
    } else {
      process.env.ROOMOTE_SLACK_PROOF_AUTO_POST = originalSlackProofAutoPost;
    }
  });

  it('should upload a file and return artifact ID without rawUrl for non-image', async () => {
    await writeFile(join(testDir, 'test.md'), '# Test content');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-1',
          version: 1,
          uploadUrl: 'https://s3.example.com/upload',
          viewUrl: 'https://test-api.example.com/view',
          artifactType: 'general',
        }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    global.fetch = fetchMock;

    const result = await handleUpload(
      { path: 'test.md', taskId: 'task-1', artifactType: 'general' },
      { ...config, workspacePath: testDir },
    );

    const createBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(createBody.artifactType).toBe('general');

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(true);
    expect(parsed.artifactId).toBe('art-1');
    expect(parsed.artifactType).toBe('general');
    expect(parsed.viewUrl).toBe('https://test-api.example.com/view');
    expect(parsed.rawUrl).toBeUndefined();
  });

  it('should return error when workspacePath is not set', async () => {
    const result = await handleUpload(
      { path: 'test.md', taskId: 'task-1', artifactType: 'general' },
      config,
    );

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('ROOMOTE_WORKSPACE_PATH');
  });

  it('should return error for file not found', async () => {
    const result = await handleUpload(
      { path: 'nonexistent.md', taskId: 'task-1', artifactType: 'general' },
      { ...config, workspacePath: testDir },
    );

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('not found or not readable');
  });

  it('should reject path traversal attempts', async () => {
    const result = await handleUpload(
      {
        path: '../../../etc/passwd',
        taskId: 'task-1',
        artifactType: 'general',
      },
      { ...config, workspacePath: testDir },
    );

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Path must be within workspace');
  });

  it('should infer correct content type and include rawUrl for images', async () => {
    await writeFile(join(testDir, 'image.png'), Buffer.from([0x89, 0x50]));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-1',
          version: 1,
          uploadUrl: 'https://s3.example.com/upload',
          viewUrl: 'https://test-api.example.com/view',
          artifactType: 'general',
          rawUrl: 'https://test-api.example.com/api/artifacts/art-1/raw',
        }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    global.fetch = fetchMock;

    const result = await handleUpload(
      { path: 'image.png', taskId: 'task-1', artifactType: 'general' },
      { ...config, workspacePath: testDir },
    );

    const createBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(createBody.artifactType).toBe('general');
    expect(createBody.contentType).toBe('image/png');

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.rawUrl).toBe(
      'https://test-api.example.com/api/artifacts/art-1/raw',
    );
  });

  it('auto-posts visual-proof image uploads to Slack when enabled', async () => {
    await writeFile(join(testDir, 'proof.png'), Buffer.from([0x89, 0x50]));
    process.env.ROOMOTE_SLACK_CHANNEL = 'C123';
    process.env.ROOMOTE_SLACK_THREAD_TS = '111.222';
    process.env.ROOMOTE_SLACK_PROOF_AUTO_POST = 'true';

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-proof',
          version: 1,
          uploadUrl: 'https://s3.example.com/upload',
          viewUrl: 'https://test-api.example.com/view',
          artifactType: 'visual-proof',
          rawUrl: 'https://test-api.example.com/api/artifacts/art-proof/raw',
        }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messageTs: '111.333' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-proof-2',
          version: 2,
          uploadUrl: 'https://s3.example.com/upload-2',
          viewUrl: 'https://test-api.example.com/view-2',
          artifactType: 'visual-proof',
          rawUrl: 'https://test-api.example.com/api/artifacts/art-proof-2/raw',
        }),
      });
    global.fetch = fetchMock;

    const result = await handleUpload(
      { path: 'proof.png', taskId: 'task-1', artifactType: 'visual-proof' },
      { ...config, workspacePath: testDir },
      {
        token: 'test-token',
        platformApiUrl: 'https://test-api.example.com',
      },
    );

    const createBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(createBody.artifactType).toBe('visual-proof');

    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      'https://test-api.example.com/api/mcp/slack/thread_reply',
    );
    const slackBody = JSON.parse(fetchMock.mock.calls[3]![1]!.body as string);
    expect(slackBody).toEqual({
      images: [{ artifactId: 'art-proof' }],
    });

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(true);
    expect(parsed.artifactId).toBe('art-proof');
    expect(parsed.artifactType).toBe('visual-proof');
    expect(parsed.slackAutoPosted).toBe(true);
  });

  it('auto-posts visual-proof image uploads with communication-provider context (Telegram)', async () => {
    await writeFile(join(testDir, 'proof.png'), Buffer.from([0x89, 0x50]));
    process.env.ROOMOTE_COMMUNICATION_PROVIDER = 'telegram';
    process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID = '8846357662';
    process.env.ROOMOTE_SLACK_PROOF_AUTO_POST = 'true';

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-proof',
          version: 1,
          uploadUrl: 'https://s3.example.com/upload',
          viewUrl: 'https://test-api.example.com/view',
          artifactType: 'visual-proof',
          rawUrl: 'https://test-api.example.com/api/artifacts/art-proof/raw',
        }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messageTs: '901' }),
      });
    global.fetch = fetchMock;

    const result = await handleUpload(
      { path: 'proof.png', taskId: 'task-1', artifactType: 'visual-proof' },
      { ...config, workspacePath: testDir },
      {
        token: 'test-token',
        platformApiUrl: 'https://test-api.example.com',
      },
    );

    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      'https://test-api.example.com/api/mcp/slack/thread_reply',
    );
    const replyBody = JSON.parse(fetchMock.mock.calls[3]![1]!.body as string);
    expect(replyBody).toEqual({
      images: [{ artifactId: 'art-proof' }],
    });

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.slackAutoPosted).toBe(true);
  });

  it('falls back to a text-only Slack proof reply when image attachment posting fails', async () => {
    await writeFile(join(testDir, 'proof.png'), Buffer.from([0x89, 0x50]));
    process.env.ROOMOTE_SLACK_CHANNEL = 'C123';
    process.env.ROOMOTE_SLACK_THREAD_TS = '111.222';
    process.env.ROOMOTE_SLACK_PROOF_AUTO_POST = 'true';
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-proof',
          version: 1,
          uploadUrl: 'https://s3.example.com/upload',
          viewUrl: 'https://test-api.example.com/view',
          artifactType: 'visual-proof',
          rawUrl: 'https://test-api.example.com/api/artifacts/art-proof/raw',
        }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: 'invalid_blocks' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messageTs: '111.334' }),
      });
    global.fetch = fetchMock;

    const result = await handleUpload(
      { path: 'proof.png', taskId: 'task-1', artifactType: 'visual-proof' },
      { ...config, workspacePath: testDir },
      {
        token: 'test-token',
        platformApiUrl: 'https://test-api.example.com',
      },
    );

    const firstSlackBody = JSON.parse(
      fetchMock.mock.calls[3]![1]!.body as string,
    );
    expect(firstSlackBody).toEqual({
      images: [{ artifactId: 'art-proof' }],
    });
    expect(fetchMock.mock.calls[4]).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(true);
    expect(parsed.slackAutoPosted).toBe(false);
  });

  it('does not auto-post visual-proof uploads without the Slack auto-post env', async () => {
    await writeFile(join(testDir, 'proof.png'), Buffer.from([0x89, 0x50]));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-proof',
          version: 1,
          uploadUrl: 'https://s3.example.com/upload',
          viewUrl: 'https://test-api.example.com/view',
          artifactType: 'visual-proof',
          rawUrl: 'https://test-api.example.com/api/artifacts/art-proof/raw',
        }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    global.fetch = fetchMock;

    const result = await handleUpload(
      { path: 'proof.png', taskId: 'task-1', artifactType: 'visual-proof' },
      { ...config, workspacePath: testDir },
      {
        token: 'test-token',
        platformApiUrl: 'https://test-api.example.com',
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(true);
    expect(parsed.slackAutoPosted).toBe(false);
  });

  it('does not auto-post visual-proof uploads when Slack context exists but auto-post flag is off', async () => {
    await writeFile(join(testDir, 'proof.png'), Buffer.from([0x89, 0x50]));
    process.env.ROOMOTE_SLACK_CHANNEL = 'C123';
    process.env.ROOMOTE_SLACK_THREAD_TS = '111.222';

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-proof',
          version: 1,
          uploadUrl: 'https://s3.example.com/upload',
          viewUrl: 'https://test-api.example.com/view',
          artifactType: 'visual-proof',
          rawUrl: 'https://test-api.example.com/api/artifacts/art-proof/raw',
        }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    global.fetch = fetchMock;

    const result = await handleUpload(
      { path: 'proof.png', taskId: 'task-1', artifactType: 'visual-proof' },
      { ...config, workspacePath: testDir },
      {
        token: 'test-token',
        platformApiUrl: 'https://test-api.example.com',
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(true);
    expect(parsed.slackAutoPosted).toBe(false);
  });

  it('does not auto-post visual-proof uploads twice in the same Slack thread', async () => {
    await writeFile(join(testDir, 'proof.png'), Buffer.from([0x89, 0x50]));
    process.env.ROOMOTE_SLACK_CHANNEL = 'C123';
    process.env.ROOMOTE_SLACK_THREAD_TS = '111.222';
    process.env.ROOMOTE_SLACK_PROOF_AUTO_POST = 'true';

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-proof',
          version: 1,
          uploadUrl: 'https://s3.example.com/upload',
          viewUrl: 'https://test-api.example.com/view',
          artifactType: 'visual-proof',
          rawUrl: 'https://test-api.example.com/api/artifacts/art-proof/raw',
        }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messageTs: '111.333' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-proof-2',
          version: 2,
          uploadUrl: 'https://s3.example.com/upload-2',
          viewUrl: 'https://test-api.example.com/view-2',
          artifactType: 'visual-proof',
          rawUrl: 'https://test-api.example.com/api/artifacts/art-proof-2/raw',
        }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    global.fetch = fetchMock;

    const firstResult = await handleUpload(
      { path: 'proof.png', taskId: 'task-1', artifactType: 'visual-proof' },
      { ...config, workspacePath: testDir },
      {
        token: 'test-token',
        platformApiUrl: 'https://test-api.example.com',
      },
    );

    const secondResult = await handleUpload(
      { path: 'proof.png', taskId: 'task-1', artifactType: 'visual-proof' },
      { ...config, workspacePath: testDir },
      {
        token: 'test-token',
        platformApiUrl: 'https://test-api.example.com',
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      'https://test-api.example.com/api/mcp/slack/thread_reply',
    );
    expect(
      fetchMock.mock.calls.filter(
        (call) =>
          call[0] === 'https://test-api.example.com/api/mcp/slack/thread_reply',
      ),
    ).toHaveLength(1);
    expect(fetchMock.mock.calls[7]).toBeUndefined();

    const firstParsed = JSON.parse(firstResult.content[0]!.text);
    expect(firstParsed.success).toBe(true);
    expect(firstParsed.slackAutoPosted).toBe(true);

    const secondParsed = JSON.parse(secondResult.content[0]!.text);
    expect(secondParsed.success).toBe(true);
    expect(secondParsed.artifactId).toBe('art-proof-2');
    expect(secondParsed.slackAutoPosted).toBe(false);
  });

  it('allows visual-proof auto-posts in a different Slack thread', async () => {
    await writeFile(join(testDir, 'proof.mp4'), Buffer.from([0x00, 0x00]));
    process.env.ROOMOTE_SLACK_CHANNEL = 'C123';
    process.env.ROOMOTE_SLACK_THREAD_TS = '111.222';
    process.env.ROOMOTE_SLACK_PROOF_AUTO_POST = 'true';

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-proof-video',
          version: 1,
          uploadUrl: 'https://s3.example.com/upload',
          viewUrl: 'https://test-api.example.com/view-video',
          artifactType: 'visual-proof',
        }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messageTs: '111.333' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-proof-video-2',
          version: 2,
          uploadUrl: 'https://s3.example.com/upload-2',
          viewUrl: 'https://test-api.example.com/view-video-2',
          artifactType: 'visual-proof',
        }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messageTs: '222.333' }),
      });
    global.fetch = fetchMock;

    const firstResult = await handleUpload(
      { path: 'proof.mp4', taskId: 'task-1', artifactType: 'visual-proof' },
      { ...config, workspacePath: testDir },
      {
        token: 'test-token',
        platformApiUrl: 'https://test-api.example.com',
      },
    );

    process.env.ROOMOTE_SLACK_THREAD_TS = '222.222';

    const secondResult = await handleUpload(
      { path: 'proof.mp4', taskId: 'task-1', artifactType: 'visual-proof' },
      { ...config, workspacePath: testDir },
      {
        token: 'test-token',
        platformApiUrl: 'https://test-api.example.com',
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      'https://test-api.example.com/api/mcp/slack/thread_reply',
    );
    expect(fetchMock.mock.calls[7]?.[0]).toBe(
      'https://test-api.example.com/api/mcp/slack/thread_reply',
    );

    const firstParsed = JSON.parse(firstResult.content[0]!.text);
    expect(firstParsed.success).toBe(true);
    expect(firstParsed.slackAutoPosted).toBe(true);

    const secondParsed = JSON.parse(secondResult.content[0]!.text);
    expect(secondParsed.success).toBe(true);
    expect(secondParsed.slackAutoPosted).toBe(true);
  });

  it('auto-posts non-image visual-proof uploads to Slack with an artifact link', async () => {
    await writeFile(join(testDir, 'proof.mp4'), Buffer.from([0x00, 0x00]));
    process.env.ROOMOTE_SLACK_CHANNEL = 'C123';
    process.env.ROOMOTE_SLACK_THREAD_TS = '111.222';
    process.env.ROOMOTE_SLACK_PROOF_AUTO_POST = 'true';

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-proof-video',
          version: 1,
          uploadUrl: 'https://s3.example.com/upload',
          viewUrl: 'https://test-api.example.com/view-video',
          artifactType: 'visual-proof',
        }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messageTs: '111.335' }),
      });
    global.fetch = fetchMock;

    const result = await handleUpload(
      { path: 'proof.mp4', taskId: 'task-1', artifactType: 'visual-proof' },
      { ...config, workspacePath: testDir },
      {
        token: 'test-token',
        platformApiUrl: 'https://test-api.example.com',
      },
    );

    const slackBody = JSON.parse(fetchMock.mock.calls[3]![1]!.body as string);
    expect(slackBody).toEqual({
      text: '[Open artifact](https://test-api.example.com/view-video)',
    });

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(true);
    expect(parsed.slackAutoPosted).toBe(true);
  });

  it('supports absolute /tmp image paths by storing a relative artifact path', async () => {
    // Use /tmp directly (not os.tmpdir() which may differ, e.g. /var/folders on macOS)
    const tmpTestDir = realpathSync('/tmp');
    const nestedDir = join(
      tmpTestDir,
      `upload-mcp-tmp-test-${Date.now()}`,
      'screenshots',
    );
    await mkdir(nestedDir, { recursive: true });
    const absolutePath = join(nestedDir, 'capture.png');
    await writeFile(absolutePath, Buffer.from([0x89, 0x50]));

    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'art-2',
            version: 1,
            uploadUrl: 'https://s3.example.com/upload',
            viewUrl: 'https://test-api.example.com/view',
            artifactType: 'general',
            rawUrl: 'https://test-api.example.com/api/artifacts/art-2/raw',
          }),
        })
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true });
      global.fetch = fetchMock;

      const result = await handleUpload(
        {
          path: absolutePath,
          taskId: 'task-1',
          artifactType: 'general',
        },
        { ...config, workspacePath: '/workspace' },
      );

      const createBody = JSON.parse(
        fetchMock.mock.calls[0]![1]!.body as string,
      );
      expect(createBody.artifactType).toBe('general');
      expect(createBody.path).toBe(`tmp/${relative(tmpTestDir, absolutePath)}`);

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.success).toBe(true);
      expect(parsed.artifactId).toBe('art-2');
      expect(parsed.artifactType).toBe('general');
    } finally {
      await rm(nestedDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
