import { handleListArtifacts } from '../list-artifacts.js';
import type { ArtifactConfig } from '../types.js';

describe('handleListArtifacts', () => {
  const config: ArtifactConfig = {
    token: 'test-token',
    platformApiUrl: 'https://test-api.example.com',
  };

  afterEach(() => vi.restoreAllMocks());

  it('lists artifacts for a task', async () => {
    const artifacts = [
      {
        id: 'art-1',
        path: 'plans/my-plan.md',
        version: 2,
        artifactType: 'plan',
        contentType: 'text/markdown',
        size: 120,
        createdAt: '2026-07-01T00:00:00.000Z',
        viewUrl:
          'https://app.example.com/task/task-1/artifacts/plans/my-plan.md?v=2',
      },
      {
        id: 'art-2',
        path: 'tmp/capture.png',
        version: 0,
        artifactType: 'visual-proof',
        contentType: 'image/png',
        size: 999,
        createdAt: '2026-07-01T01:00:00.000Z',
        viewUrl:
          'https://app.example.com/task/task-1/artifacts/tmp/capture.png?v=0',
        rawUrl: 'https://app.example.com/api/artifacts/art-2/raw?sig=abc&ts=1',
      },
    ];

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ taskId: 'task-1', artifacts }),
    });

    const result = await handleListArtifacts({ taskId: 'task-1' }, config);

    expect(fetch).toHaveBeenCalledWith(
      'https://test-api.example.com/api/tasks/task-1/artifacts',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(true);
    expect(parsed.taskId).toBe('task-1');
    expect(parsed.artifactCount).toBe(2);
    expect(parsed.artifacts).toEqual(artifacts);
  });

  it('passes the artifactType filter as a query parameter', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ taskId: 'task-1', artifacts: [] }),
    });

    const result = await handleListArtifacts(
      { taskId: 'task-1', artifactType: 'visual-proof' },
      config,
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://test-api.example.com/api/tasks/task-1/artifacts?artifactType=visual-proof',
      expect.any(Object),
    );

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(true);
    expect(parsed.artifactCount).toBe(0);
    expect(parsed.artifacts).toEqual([]);
  });

  it('returns an error result on API failure', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({
          error: 'Task run token does not grant read access to requested task',
        }),
    });

    const result = await handleListArtifacts({ taskId: 'task-1' }, config);

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Failed to list artifacts: 403');
  });
});
