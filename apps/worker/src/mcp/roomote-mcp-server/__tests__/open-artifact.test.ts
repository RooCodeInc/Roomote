import { handleOpenArtifact } from '../open-artifact.js';
import type { ArtifactConfig } from '../types.js';

describe('handleOpenArtifact', () => {
  const config: ArtifactConfig = {
    token: 'run-token',
    platformApiUrl: 'https://api.example.com',
  };

  afterEach(() => vi.restoreAllMocks());

  it('opens a task artifact through the authorized API route', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'artifact-1',
          taskId: 'task-1',
          sessionId: null,
          path: 'plans/summary.md',
          version: 1,
          contentType: 'text/markdown',
          size: 12,
          content: 'artifact text',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await handleOpenArtifact(
      { taskId: 'task-1', path: 'plans/summary.md' },
      config,
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/api/mcp/artifacts/open',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer run-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ taskId: 'task-1', path: 'plans/summary.md' }),
        signal: expect.any(AbortSignal),
      }),
    );
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toMatchObject({
      success: true,
      content: 'artifact text',
    });
  });

  it('preserves an API authorization or size failure as a tool error', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'Artifact is too large to open',
          maxBytes: 1024 * 1024,
        }),
        { status: 413 },
      ),
    );

    const result = await handleOpenArtifact(
      { sessionId: 'session-1', path: 'large.txt' },
      config,
    );

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toMatchObject({
      success: false,
      httpStatus: 413,
    });
    expect(parsed.error).toContain('Artifact is too large to open');
  });
});
