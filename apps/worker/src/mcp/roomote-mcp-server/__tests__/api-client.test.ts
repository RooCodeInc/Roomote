import {
  createArtifactRecord,
  uploadToPresignedUrl,
  confirmUpload,
  uploadArtifact,
  fetchArtifactMetadata,
  getDownloadUrl,
  parseApiError,
} from '../api-client.js';
import type { ArtifactConfig } from '../types.js';

const config: ArtifactConfig = {
  token: 'test-token',
  platformApiUrl: 'https://test-api.example.com',
};

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
});

describe('uploadToPresignedUrl', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should PUT content to presigned URL', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true });

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
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(confirmUpload(config, 'art-1', 'task-1')).rejects.toThrow(
      'Failed to confirm upload',
    );
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
      .mockResolvedValueOnce({ ok: true })
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
      .mockResolvedValueOnce({ ok: true })
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
