import { readFile, rm } from 'node:fs/promises';

import { handleDownload } from '../download.js';
import type { ArtifactConfig } from '../types.js';

describe('handleDownload', () => {
  const config: ArtifactConfig = {
    token: 'test-token',
    platformApiUrl: 'https://test-api.example.com',
  };

  afterEach(() => vi.restoreAllMocks());

  it('should download artifact to temp directory', async () => {
    const content = '# Downloaded Plan';

    const fetchMock = vi
      .fn()
      // Step 1: fetch metadata
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-1',
          taskId: 'task-1',
          path: 'plans/test.md',
          version: 1,
          contentType: 'text/markdown',
          size: content.length,
          uploaded: true,
        }),
      })
      // Step 2: get download URL
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: 'https://s3.example.com/download',
          path: 'plans/test.md',
          contentType: 'text/markdown',
          size: content.length,
        }),
      })
      // Step 3: download from S3
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(content).buffer,
      });
    global.fetch = fetchMock;

    const result = await handleDownload(
      { taskId: 'task-1', path: 'plans/test.md' },
      config,
    );

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(true);
    expect(parsed.filePath).toContain('roomote-artifact-');
    expect(parsed.filePath).toContain('test.md');

    // Verify file was actually written
    const downloaded = await readFile(parsed.filePath, 'utf-8');
    expect(downloaded).toBe(content);

    // Cleanup
    const dir = parsed.filePath.replace(/\/[^/]+$/, '');
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('should return error when artifact is not uploaded', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'art-1',
        taskId: 'task-1',
        path: 'test.md',
        version: 1,
        contentType: 'text/markdown',
        size: 100,
        uploaded: false,
      }),
    });

    const result = await handleDownload(
      { taskId: 'task-1', path: 'test.md' },
      config,
    );

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('not been uploaded');
  });

  it('should pass version parameter when provided', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-1',
          taskId: 'task-1',
          path: 'test.md',
          version: 2,
          contentType: 'text/markdown',
          size: 10,
          uploaded: true,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: 'https://s3.example.com/download',
          path: 'test.md',
          contentType: 'text/markdown',
          size: 10,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode('v2').buffer,
      });

    await handleDownload(
      { taskId: 'task-1', path: 'test.md', version: 2 },
      config,
    );

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('?v=2'),
      expect.any(Object),
    );
  });

  it('should return error on metadata fetch failure', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'Artifact not found' }),
    });

    const result = await handleDownload(
      { taskId: 'task-1', path: 'nonexistent.md' },
      config,
    );

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('404');
  });

  it('should return error on S3 download failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-1',
          taskId: 'task-1',
          path: 'test.md',
          version: 1,
          contentType: 'text/markdown',
          size: 10,
          uploaded: true,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: 'https://s3.example.com/download',
          path: 'test.md',
          contentType: 'text/markdown',
          size: 10,
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });
    global.fetch = fetchMock;

    const result = await handleDownload(
      { taskId: 'task-1', path: 'test.md' },
      config,
    );

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('S3');
  });
});
