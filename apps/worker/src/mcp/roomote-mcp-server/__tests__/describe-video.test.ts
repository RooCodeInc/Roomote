import { writeFile, mkdir, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES } from '@roomote/cloud-agents';
import { handleDescribeVideo } from '../describe-video.js';
import type { RoomoteConfig } from '../types.js';

const { describeVideoApiMock } = vi.hoisted(() => ({
  describeVideoApiMock: vi.fn(),
}));

vi.mock('../tasks-api-client.js', () => ({
  describeVideo: describeVideoApiMock,
}));

describe('handleDescribeVideo', () => {
  let testDir: string;

  const config: RoomoteConfig & { workspacePath?: string } = {
    token: 'test-token',
    platformApiUrl: 'https://test-api.example.com',
    workspacePath: '/tmp',
  };

  beforeEach(async () => {
    const rawDir = join(tmpdir(), `describe-video-mcp-test-${Date.now()}`);
    await mkdir(rawDir, { recursive: true });
    testDir = realpathSync(rawDir);
    config.workspacePath = testDir;

    vi.clearAllMocks();
    describeVideoApiMock.mockResolvedValue({
      description: 'The clip shows a failed login and retry.',
    });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it('reads a workspace file, infers mime type, and returns the description text', async () => {
    const filePath = join(testDir, 'recording.mp4');
    await writeFile(filePath, Buffer.from('video-content'));

    const result = await handleDescribeVideo(
      { path: 'recording.mp4', userTextContext: 'Focus on the toast.' },
      config,
      'task-1',
    );

    expect(describeVideoApiMock).toHaveBeenCalledWith(config, 'task-1', {
      videoBytes: Buffer.from('video-content').toString('base64'),
      mimeType: 'video/mp4',
      userTextContext: 'Focus on the toast.',
    });
    expect(result.content[0]?.text).toBe(
      'The clip shows a failed login and retry.',
    );
  });

  it('supports absolute /tmp paths', async () => {
    const tmpVideoPath = join(
      realpathSync('/tmp'),
      `describe-video-${Date.now()}.mov`,
    );
    await writeFile(tmpVideoPath, Buffer.from('tmp-video'));

    try {
      await handleDescribeVideo({ path: tmpVideoPath }, config, 'task-1');

      expect(describeVideoApiMock).toHaveBeenCalledWith(config, 'task-1', {
        videoBytes: Buffer.from('tmp-video').toString('base64'),
        mimeType: 'video/quicktime',
      });
    } finally {
      await rm(tmpVideoPath, { force: true }).catch(() => {});
    }
  });

  it('rejects files larger than 20 MiB before calling the API', async () => {
    const filePath = join(testDir, 'large.mp4');
    await writeFile(
      filePath,
      Buffer.alloc(VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES + 1),
    );

    const result = await handleDescribeVideo(
      { path: 'large.mp4' },
      config,
      'task-1',
    );

    expect(describeVideoApiMock).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: false,
      error: `Video exceeds max size of ${VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES} bytes`,
    });
  });

  it('rejects paths outside the workspace and /tmp', async () => {
    const result = await handleDescribeVideo(
      { path: '../../../etc/passwd', mimeType: 'video/mp4' },
      config,
      'task-1',
    );

    expect(describeVideoApiMock).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0]!.text).error).toContain(
      'Path must be within workspace or /tmp',
    );
  });

  it('uses an explicit mime type override when provided', async () => {
    const filePath = join(testDir, 'recording.bin');
    await writeFile(filePath, Buffer.from('video-content'));

    await handleDescribeVideo(
      { path: 'recording.bin', mimeType: 'video/webm' },
      config,
      'task-1',
    );

    expect(describeVideoApiMock).toHaveBeenCalledWith(config, 'task-1', {
      videoBytes: Buffer.from('video-content').toString('base64'),
      mimeType: 'video/webm',
    });
  });
});
