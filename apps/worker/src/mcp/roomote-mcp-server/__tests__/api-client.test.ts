import {
  createArtifactRecord,
  uploadToPresignedUrl,
  confirmUpload,
  uploadArtifact,
  fetchArtifactMetadata,
  fetchWithTimeout,
  getDownloadUrl,
  parseApiError,
  resolvePlatformApiTimeoutMs,
} from '../api-client.js';
import type { ArtifactConfig } from '../types.js';

const config: ArtifactConfig = {
  token: 'test-token',
  platformApiUrl: 'https://test-api.example.com',
};

// Mirrors undici: a pending request rejects with the signal's reason when the
// signal aborts, and never settles otherwise.
function neverRespondingFetch() {
  return vi.fn((_url: unknown, options?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () =>
        reject(
          (options.signal as AbortSignal).reason ??
            new DOMException('Aborted', 'AbortError'),
        ),
      );
    });
  });
}

describe('fetchWithTimeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ROOMOTE_MCP_PLATFORM_API_TIMEOUT_MS;
  });

  it('rejects with a retryable error when the API never responds', async () => {
    process.env.ROOMOTE_MCP_PLATFORM_API_TIMEOUT_MS = '25';
    global.fetch = neverRespondingFetch() as unknown as typeof fetch;

    await expect(
      fetchWithTimeout(
        'https://test-api.example.com/api/mcp/tasks/t1/source_control',
        { method: 'POST' },
        { label: 'Failed to manage source control' },
      ),
    ).rejects.toThrow(
      'Failed to manage source control: no response from the Roomote API within 25ms; the request was aborted and is safe to retry.',
    );
  });

  it('honors an explicit timeoutMs over the environment default', async () => {
    process.env.ROOMOTE_MCP_PLATFORM_API_TIMEOUT_MS = '60000';
    global.fetch = neverRespondingFetch() as unknown as typeof fetch;

    await expect(
      fetchWithTimeout(
        'https://s3.example.com/upload',
        { method: 'PUT' },
        { label: 'Failed to upload to S3', timeoutMs: 25 },
      ),
    ).rejects.toThrow('no response from the Roomote API within 25ms');
  });

  it('passes through non-timeout failures unchanged', async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(
        new TypeError('fetch failed'),
      ) as unknown as typeof fetch;

    await expect(
      fetchWithTimeout(
        'https://test-api.example.com/api/mcp/tasks',
        {},
        { label: 'Failed to search tasks' },
      ),
    ).rejects.toThrow('fetch failed');
  });

  it('preserves a caller-provided abort as an abort, not a timeout', async () => {
    global.fetch = neverRespondingFetch() as unknown as typeof fetch;
    const controller = new AbortController();
    const pending = fetchWithTimeout(
      'https://test-api.example.com/api/mcp/tasks',
      { signal: controller.signal },
      { label: 'Failed to search tasks' },
    );

    controller.abort();

    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DOMException && error.name === 'AbortError',
    );
  });

  it('returns the response when the API answers within the deadline', async () => {
    const response = { ok: true } as Response;
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(response) as unknown as typeof fetch;

    await expect(
      fetchWithTimeout(
        'https://test-api.example.com/api/mcp/tasks',
        {},
        { label: 'Failed to search tasks' },
      ),
    ).resolves.toBe(response);
  });
});

describe('resolvePlatformApiTimeoutMs', () => {
  afterEach(() => {
    delete process.env.ROOMOTE_MCP_PLATFORM_API_TIMEOUT_MS;
  });

  it('defaults to two minutes', () => {
    expect(resolvePlatformApiTimeoutMs()).toBe(120_000);
  });

  it('reads a positive integer override from the environment', () => {
    process.env.ROOMOTE_MCP_PLATFORM_API_TIMEOUT_MS = '45000';
    expect(resolvePlatformApiTimeoutMs()).toBe(45_000);
  });

  it('ignores non-positive or malformed overrides', () => {
    process.env.ROOMOTE_MCP_PLATFORM_API_TIMEOUT_MS = '-5';
    expect(resolvePlatformApiTimeoutMs()).toBe(120_000);
    process.env.ROOMOTE_MCP_PLATFORM_API_TIMEOUT_MS = 'soon';
    expect(resolvePlatformApiTimeoutMs()).toBe(120_000);
  });
});

describe('parseApiError', () => {
  it('should extract error field from JSON response', async () => {
    const response = {
      text: async () => JSON.stringify({ error: 'Not found' }),
    } as Response;
    expect(await parseApiError(response)).toBe('Not found');
  });

  it('should fall back to raw text when response is not JSON', async () => {
    const response = {
      text: async () => 'plain error text',
    } as Response;
    expect(await parseApiError(response)).toBe('plain error text');
  });
});

describe('createArtifactRecord', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should create an artifact record and return the response', async () => {
    const mockResponse = {
      id: 'art-1',
      version: 1,
      uploadUrl: 'https://s3.example.com/upload',
      viewUrl: 'https://test-api.example.com/view',
      artifactType: 'general',
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await createArtifactRecord(config, {
      taskId: 'task-1',
      path: 'plans/test.md',
      artifactType: 'general',
      contentType: 'text/markdown',
      size: 100,
    });

    expect(result).toEqual(mockResponse);
    expect(fetch).toHaveBeenCalledWith(
      'https://test-api.example.com/api/artifacts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
  });

  it('adds the preview bypass header for platform api requests', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'art-1',
        version: 1,
        uploadUrl: 'https://s3.example.com/upload',
        viewUrl: 'https://test-api.example.com/view',
        artifactType: 'general',
      }),
    });

    await createArtifactRecord(
      {
        ...config,
        authBypassHeaderName: 'x-custom-bypass',
        authBypassHeaderValue: 'bypass-token',
      },
      {
        taskId: 'task-1',
        path: 'plans/test.md',
        artifactType: 'general',
        contentType: 'text/markdown',
        size: 100,
      },
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://test-api.example.com/api/artifacts',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'x-custom-bypass': 'bypass-token',
        }),
      }),
    );
  });

  it('should throw on API error', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'Task not found' }),
    });

    await expect(
      createArtifactRecord(config, {
        taskId: 'bad-task',
        path: 'test.md',
        artifactType: 'general',
        contentType: 'text/markdown',
        size: 10,
      }),
    ).rejects.toThrow('Failed to create artifact: 404 Task not found');
  });

  it('uses the reserved plans endpoint for plan artifacts', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'art-plan',
        version: 1,
        uploadUrl: 'https://s3.example.com/upload',
        viewUrl: 'https://test-api.example.com/view',
        artifactType: 'plan',
      }),
    });

    await createArtifactRecord(config, {
      taskId: 'task-1',
      path: 'plans/test.md',
      artifactType: 'plan',
      contentType: 'text/markdown',
      size: 100,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://test-api.example.com/api/artifacts/plan',
      expect.any(Object),
    );
  });

  it('uses the reserved visual-proof endpoint for proof artifacts', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'art-proof',
        version: 1,
        uploadUrl: 'https://s3.example.com/upload',
        viewUrl: 'https://test-api.example.com/view',
        artifactType: 'visual-proof',
      }),
    });

    await createArtifactRecord(config, {
      taskId: 'task-1',
      path: 'tmp/capture.png',
      artifactType: 'visual-proof',
      contentType: 'image/png',
      size: 100,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://test-api.example.com/api/artifacts/visual-proof',
      expect.any(Object),
    );
  });

  it('uses the generic endpoint for architecture snapshots', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'art-snapshot',
        version: 1,
        uploadUrl: 'https://s3.example.com/upload',
        viewUrl: 'https://test-api.example.com/view',
        artifactType: 'architecture-snapshot',
      }),
    });

    await createArtifactRecord(config, {
      taskId: 'task-1',
      path: 'architecture-snapshots/current.json',
      artifactType: 'architecture-snapshot',
      contentType: 'application/json',
      size: 100,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://test-api.example.com/api/artifacts',
      expect.any(Object),
    );
  });
});

describe('uploadToPresignedUrl', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should PUT content to presigned URL', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ etag: '"artifact-etag"' }),
    });

    const content = Buffer.from('hello');
    await uploadToPresignedUrl(
      'https://s3.example.com/upload',
      content,
      'text/plain',
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://s3.example.com/upload',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          'Content-Type': 'text/plain',
          'Content-Length': '5',
        }),
      }),
    );
  });

  it('should throw on S3 error', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(
      uploadToPresignedUrl(
        'https://s3.example.com/upload',
        Buffer.from('x'),
        'text/plain',
      ),
    ).rejects.toThrow('Failed to upload to S3: 500 Internal Server Error');
  });

  it('rejects a non-S3 success response without an ETag', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html' }),
    });

    await expect(
      uploadToPresignedUrl(
        'https://s3.example.com/upload',
        Buffer.from('x'),
        'text/plain',
      ),
    ).rejects.toThrow(
      'Failed to upload to S3: successful response did not include an ETag',
    );
  });
});

describe('confirmUpload', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should POST to upload_complete', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true });

    await confirmUpload(config, 'art-1', 'task-1');

    expect(fetch).toHaveBeenCalledWith(
      'https://test-api.example.com/api/artifacts/art-1/upload_complete?taskId=task-1',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('should throw on error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(confirmUpload(config, 'art-1', 'task-1')).rejects.toThrow(
      'Failed to confirm upload',
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('retries the same publication after a transient parent-delivery failure', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      })
      .mockResolvedValueOnce({ ok: true });

    await confirmUpload(config, 'art-1', 'task-1');

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('uploadArtifact', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should orchestrate all 3 steps', async () => {
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
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"artifact-etag"' }),
      })
      .mockResolvedValueOnce({ ok: true });
    global.fetch = fetchMock;

    const result = await uploadArtifact(config, {
      taskId: 'task-1',
      path: 'plans/test.md',
      artifactType: 'plan',
      contentType: 'text/markdown',
      content: Buffer.from('# Test'),
    });

    expect(result).toEqual({
      artifactId: 'art-1',
      version: 1,
      viewUrl: 'https://test-api.example.com/view',
      artifactType: 'plan',
      rawUrl: 'https://test-api.example.com/api/artifacts/art-1/raw',
    });
  });

  it('should not include rawUrl when API does not return it', async () => {
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
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"artifact-etag"' }),
      })
      .mockResolvedValueOnce({ ok: true });
    global.fetch = fetchMock;

    const result = await uploadArtifact(config, {
      taskId: 'task-1',
      path: 'plans/test.md',
      artifactType: 'general',
      contentType: 'text/markdown',
      content: Buffer.from('# Test'),
    });

    expect(result.rawUrl).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('fetchArtifactMetadata', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should fetch metadata by taskId and path', async () => {
    const metadata = {
      id: 'art-1',
      taskId: 'task-1',
      path: 'plans/test.md',
      version: 1,
      artifactType: 'plan',
      contentType: 'text/markdown',
      size: 100,
      uploaded: true,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => metadata,
    });

    const result = await fetchArtifactMetadata(config, {
      taskId: 'task-1',
      path: 'plans/test.md',
    });

    expect(result).toEqual(metadata);
    expect(fetch).toHaveBeenCalledWith(
      'https://test-api.example.com/api/tasks/task-1/artifacts/plans/test.md',
      expect.any(Object),
    );
  });

  it('should include version query param when provided', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'art-1' }),
    });

    await fetchArtifactMetadata(config, {
      taskId: 'task-1',
      path: 'test.md',
      version: 3,
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('?v=3'),
      expect.any(Object),
    );
  });
});

describe('getDownloadUrl', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should fetch download URL', async () => {
    const urlData = {
      url: 'https://s3.example.com/download',
      path: 'test.md',
      contentType: 'text/markdown',
      size: 100,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => urlData,
    });

    const result = await getDownloadUrl(config, 'art-1', 'task-1');

    expect(result).toEqual(urlData);
    expect(fetch).toHaveBeenCalledWith(
      'https://test-api.example.com/api/artifacts/art-1/url?taskId=task-1',
      expect.any(Object),
    );
  });

  it('returns the API-provided download URL unchanged', async () => {
    const urlData = {
      url: 'http://host.docker.internal:19000/roomote-artifacts/path.txt',
      path: 'test.md',
      contentType: 'text/markdown',
      size: 100,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => urlData,
    });

    const result = await getDownloadUrl(
      {
        ...config,
        platformApiUrl: 'http://host.docker.internal:13001',
      },
      'art-1',
      'task-1',
    );

    expect(result).toEqual(urlData);
  });
});
