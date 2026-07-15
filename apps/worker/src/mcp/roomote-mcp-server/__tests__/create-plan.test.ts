import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { handleCreatePlan } from '../create-plan.js';
import type { ArtifactConfig } from '../types.js';

const successfulS3UploadResponse = () => ({
  ok: true,
  headers: new Headers({ etag: '"artifact-etag"' }),
});

describe('handleCreatePlan', () => {
  const originalEnv = process.env;
  let testDir: string;

  const config: ArtifactConfig = {
    token: 'test-token',
    platformApiUrl: 'https://test-api.example.com',
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    testDir = join(tmpdir(), `create-plan-mcp-test-${Date.now()}`);
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it('should create plan artifact with slugified path', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-1',
          version: 1,
          uploadUrl: 'https://s3.example.com/upload',
          viewUrl: 'https://test-api.example.com/view',
          artifactType: 'plan',
          rawUrl: 'https://test-api.example.com/api/artifacts/art-1/raw',
        }),
      })
      .mockResolvedValueOnce(successfulS3UploadResponse())
      .mockResolvedValueOnce({ ok: true });
    global.fetch = fetchMock;

    const result = await handleCreatePlan(
      {
        title: 'My Architecture Plan',
        content: '# Architecture',
        taskId: 'task-1',
      },
      { ...config, workspacePath: testDir },
    );

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(true);
    expect(parsed.path).toBe('plans/my-architecture-plan.md');
    expect(parsed.artifactId).toBe('art-1');
    expect(parsed.version).toBe(1);
    expect(parsed.viewUrl).toBe('https://test-api.example.com/view');
    expect(parsed.rawUrl).toBeUndefined();

    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://test-api.example.com/api/artifacts/plan',
    );

    // Verify API was called with correct path
    const createBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(createBody.artifactType).toBe('plan');
    expect(createBody.path).toBe('plans/my-architecture-plan.md');
    expect(createBody.contentType).toBe('text/markdown');
  });

  it('should write plan to local workspace', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-1',
          version: 1,
          uploadUrl: 'https://s3.example.com/upload',
          viewUrl: 'https://test-api.example.com/view',
          artifactType: 'plan',
          rawUrl: 'https://test-api.example.com/api/artifacts/art-1/raw',
        }),
      })
      .mockResolvedValueOnce(successfulS3UploadResponse())
      .mockResolvedValueOnce({ ok: true });
    global.fetch = fetchMock;

    const content = '# Test Plan\n\nDetails here.';
    await handleCreatePlan(
      { title: 'Test Plan', content, taskId: 'task-1' },
      { ...config, workspacePath: testDir },
    );

    const localContent = await readFile(
      join(testDir, 'plans/test-plan.md'),
      'utf-8',
    );
    expect(localContent).toBe(content);
  });

  it('should succeed even when local file write fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'art-1',
          version: 1,
          uploadUrl: 'https://s3.example.com/upload',
          viewUrl: 'https://test-api.example.com/view',
          artifactType: 'plan',
          rawUrl: 'https://test-api.example.com/api/artifacts/art-1/raw',
        }),
      })
      .mockResolvedValueOnce(successfulS3UploadResponse())
      .mockResolvedValueOnce({ ok: true });
    global.fetch = fetchMock;

    const result = await handleCreatePlan(
      { title: 'Test Plan', content: '# Test', taskId: 'task-1' },
      { ...config, workspacePath: '/nonexistent/path' },
    );

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(true);
  });

  it('should return error on API failure', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'Task not found' }),
    });

    const result = await handleCreatePlan(
      { title: 'Test Plan', content: '# Test', taskId: 'task-1' },
      config,
    );

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('404');
  });
});
