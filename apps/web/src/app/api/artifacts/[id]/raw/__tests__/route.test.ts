import { NextRequest } from 'next/server';

import {
  getUploadedArtifactById,
  getArtifactObject,
  verifyArtifactSignature,
} from '@/lib/server';

import { GET } from '../route';

vi.mock('@/lib/server/artifacts', () => ({
  getUploadedArtifactById: vi.fn(),
}));

vi.mock('@/lib/server/s3-client', () => ({
  getArtifactObject: vi.fn(),
}));

vi.mock('@/lib/server/artifact-signature', () => ({
  verifyArtifactSignature: vi.fn(),
}));

const mockGetUploadedArtifactById = vi.mocked(getUploadedArtifactById);
const mockGetArtifactObject = vi.mocked(getArtifactObject);
const mockVerifyArtifactSignature = vi.mocked(verifyArtifactSignature);

function makeRequest(id: string, params?: { sig?: string; ts?: string }) {
  const searchParams = new URLSearchParams();
  if (params?.sig) searchParams.set('sig', params.sig);
  if (params?.ts) searchParams.set('ts', params.ts);
  const qs = searchParams.toString();
  const url = `http://localhost:3000/api/artifacts/${id}/raw${qs ? `?${qs}` : ''}`;
  return new NextRequest(url, { method: 'GET' });
}

function freshTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe('GET /api/artifacts/[id]/raw', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return 403 when signature is missing', async () => {
    const response = await GET(makeRequest('art-1'), {
      params: Promise.resolve({ id: 'art-1' }),
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('Invalid or missing signature');
  });

  it('should return 403 when ts is missing', async () => {
    const response = await GET(makeRequest('art-1', { sig: 'some-sig' }), {
      params: Promise.resolve({ id: 'art-1' }),
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('Invalid or missing signature');
  });

  it('should return 403 when ts is not a valid number', async () => {
    const response = await GET(
      makeRequest('art-1', { sig: 'some-sig', ts: 'abc' }),
      {
        params: Promise.resolve({ id: 'art-1' }),
      },
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('Invalid or missing signature');
  });

  it('should return 403 when ts is zero or negative', async () => {
    const response = await GET(
      makeRequest('art-1', { sig: 'some-sig', ts: '0' }),
      {
        params: Promise.resolve({ id: 'art-1' }),
      },
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('Invalid or missing signature');
  });

  it('should return 403 when signature is invalid', async () => {
    mockVerifyArtifactSignature.mockReturnValueOnce(false);

    const response = await GET(
      makeRequest('art-1', { sig: 'bad-sig', ts: '1700000000' }),
      {
        params: Promise.resolve({ id: 'art-1' }),
      },
    );

    expect(response.status).toBe(403);
    expect(mockVerifyArtifactSignature).toHaveBeenCalledWith(
      'art-1',
      'bad-sig',
      1700000000,
    );
    const body = await response.json();
    expect(body.error).toBe('Invalid or missing signature');
  });

  it('should return 404 when artifact does not exist', async () => {
    mockVerifyArtifactSignature.mockReturnValueOnce(true);
    mockGetUploadedArtifactById.mockResolvedValueOnce(null);

    const response = await GET(
      makeRequest('nonexistent', { sig: 'valid-sig', ts: '1700000000' }),
      {
        params: Promise.resolve({ id: 'nonexistent' }),
      },
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Artifact not found');
  });

  it('should return 403 for non-allowlisted content types', async () => {
    mockVerifyArtifactSignature.mockReturnValueOnce(true);
    mockGetUploadedArtifactById.mockResolvedValueOnce({
      id: 'art-1',
      taskId: 'task-1',
      runId: 1,
      artifactType: 'general',
      path: 'plans/test.md',
      version: 1,
      contentType: 'text/markdown',
      size: 100,
      uploaded: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await GET(
      makeRequest('art-1', { sig: 'valid-sig', ts: '1700000000' }),
      {
        params: Promise.resolve({ id: 'art-1' }),
      },
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe(
      'Only allowlisted artifact types can be served publicly',
    );
  });

  it('should stream allowlisted webm artifacts', async () => {
    const videoBytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);

    mockVerifyArtifactSignature.mockReturnValueOnce(true);
    mockGetUploadedArtifactById.mockResolvedValueOnce({
      id: 'art-1',
      taskId: 'task-1',
      runId: 1,
      artifactType: 'general',
      path: 'videos/demo.webm',
      version: 1,
      contentType: 'video/webm',
      size: 100,
      uploaded: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockGetArtifactObject.mockResolvedValueOnce({
      Body: {
        transformToWebStream: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(videoBytes);
              controller.close();
            },
          }),
      },
      ContentLength: 4,
    } as never);

    const response = await GET(
      makeRequest('art-1', { sig: 'valid-sig', ts: freshTs() }),
      {
        params: Promise.resolve({ id: 'art-1' }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('video/webm');
    expect(response.headers.get('Content-Length')).toBe('4');
  });

  it('should return 200 with image content for valid image artifact', async () => {
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    mockVerifyArtifactSignature.mockReturnValueOnce(true);
    mockGetUploadedArtifactById.mockResolvedValueOnce({
      id: 'art-1',
      taskId: 'task-1',
      runId: 1,
      artifactType: 'general',
      path: 'screenshots/homepage.png',
      version: 1,
      contentType: 'image/png',
      size: 4,
      uploaded: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockGetArtifactObject.mockResolvedValueOnce({
      Body: {
        transformToWebStream: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(imageBytes);
              controller.close();
            },
          }),
      },
      ContentLength: 4,
    } as never);

    const response = await GET(
      makeRequest('art-1', { sig: 'valid-sig', ts: freshTs() }),
      {
        params: Promise.resolve({ id: 'art-1' }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(response.headers.get('Cache-Control')).toMatch(
      /^public, max-age=\d+, immutable$/,
    );
    const cacheControl = response.headers.get('Cache-Control') ?? '';
    const maxAge = Number(cacheControl.match(/max-age=(\d+)/)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(3600);

    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );

    const body = await response.arrayBuffer();
    expect(new Uint8Array(body)).toEqual(imageBytes);
  });

  it('should return 502 when S3 fetch fails', async () => {
    mockVerifyArtifactSignature.mockReturnValueOnce(true);
    mockGetUploadedArtifactById.mockResolvedValueOnce({
      id: 'art-1',
      taskId: 'task-1',
      runId: 1,
      artifactType: 'general',
      path: 'screenshots/homepage.png',
      version: 1,
      contentType: 'image/png',
      size: 100,
      uploaded: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockGetArtifactObject.mockRejectedValueOnce(new Error('S3 error'));

    const response = await GET(
      makeRequest('art-1', { sig: 'valid-sig', ts: '1700000000' }),
      {
        params: Promise.resolve({ id: 'art-1' }),
      },
    );

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe('Failed to retrieve artifact content');
  });

  it('should allow all supported image types', async () => {
    const imageTypes = [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/svg+xml',
    ];

    for (const contentType of imageTypes) {
      mockVerifyArtifactSignature.mockReturnValueOnce(true);
      mockGetUploadedArtifactById.mockResolvedValueOnce({
        id: 'art-1',
        taskId: 'task-1',
        runId: 1,
        artifactType: 'general',
        path: 'screenshots/test.img',
        version: 1,
        contentType,
        size: 4,
        uploaded: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      mockGetArtifactObject.mockResolvedValueOnce({
        Body: {
          transformToWebStream: () =>
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3, 4]));
                controller.close();
              },
            }),
        },
        ContentLength: 4,
      } as never);

      const response = await GET(
        makeRequest('art-1', { sig: 'valid-sig', ts: freshTs() }),
        {
          params: Promise.resolve({ id: 'art-1' }),
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe(contentType);
    }
  });

  it('should reject application/pdf content type', async () => {
    mockVerifyArtifactSignature.mockReturnValueOnce(true);
    mockGetUploadedArtifactById.mockResolvedValueOnce({
      id: 'art-1',
      taskId: 'task-1',
      runId: 1,
      artifactType: 'general',
      path: 'docs/report.pdf',
      version: 1,
      contentType: 'application/pdf',
      size: 1000,
      uploaded: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await GET(
      makeRequest('art-1', { sig: 'valid-sig', ts: '1700000000' }),
      {
        params: Promise.resolve({ id: 'art-1' }),
      },
    );

    expect(response.status).toBe(403);
  });
});
