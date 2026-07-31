import { writeFile, mkdir, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { handleUpload } from '../upload.js';
import type { ArtifactConfig } from '../types.js';

const successfulS3UploadResponse = () => ({
  ok: true,
  headers: new Headers({ etag: '"artifact-etag"' }),
});

describe('handleUpload', () => {
  let testDir: string;
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
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
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
      .mockResolvedValueOnce(successfulS3UploadResponse())
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
      .mockResolvedValueOnce(successfulS3UploadResponse())
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

  it('returns visual-proof artifact IDs for explicit sharing', async () => {
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
      .mockResolvedValueOnce(successfulS3UploadResponse())
      .mockResolvedValueOnce({ ok: true });
    global.fetch = fetchMock;

    const result = await handleUpload(
      { path: 'proof.png', taskId: 'task-1', artifactType: 'visual-proof' },
      { ...config, workspacePath: testDir },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(true);
    expect(parsed.artifactId).toBe('art-proof');
    expect(parsed.artifactType).toBe('visual-proof');
    expect(parsed.rawUrl).toBe(
      'https://test-api.example.com/api/artifacts/art-proof/raw',
    );
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
        .mockResolvedValueOnce(successfulS3UploadResponse())
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
