import { Hono } from 'hono';

import type { Variables } from '../../../types';
import { createArtifact } from '../create';

const {
  mockBuildSignedArtifactRawUrl,
  mockCreateTaskArtifactRecord,
  mockEnv,
  mockGenerateUploadUrl,
  mockResolveArtifactRouteAuth,
  mockVerifyArtifactRouteTaskBinding,
  mockVerifyTaskAccessForArtifact,
} = vi.hoisted(() => ({
  mockBuildSignedArtifactRawUrl: vi.fn(
    () =>
      'https://public.example.com/api/artifacts/art-1/raw?sig=signed&ts=1234',
  ),
  mockCreateTaskArtifactRecord: vi.fn(),
  mockEnv: {
    R_APP_URL: 'https://app.example.com',
    R_PUBLIC_URL: undefined as string | undefined,
  },
  mockGenerateUploadUrl: vi.fn(),
  mockResolveArtifactRouteAuth: vi.fn(),
  mockVerifyArtifactRouteTaskBinding: vi.fn(),
  mockVerifyTaskAccessForArtifact: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: mockEnv,
  getArtifactSigningKey: () => 'signing-key',
}));

vi.mock('@roomote/sdk/server', () => ({
  buildSignedArtifactRawUrl: mockBuildSignedArtifactRawUrl,
  createTaskArtifactRecord: mockCreateTaskArtifactRecord,
  currentEpochSeconds: () => 1234,
}));

vi.mock('../auth', () => ({
  resolveArtifactRouteAuth: mockResolveArtifactRouteAuth,
  verifyArtifactRouteTaskBinding: mockVerifyArtifactRouteTaskBinding,
}));

vi.mock('../service', () => ({
  validateArtifactPath: () => ({ valid: true }),
  validateArtifactSize: () => ({ valid: true }),
  verifyTaskAccessForArtifact: mockVerifyTaskAccessForArtifact,
}));

vi.mock('../storage', () => ({
  generateUploadUrl: mockGenerateUploadUrl,
  resolveArtifactPresignEndpointForRequest: () => undefined,
}));

function createApp() {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('authContext', {} as Variables['authContext']);
    await next();
  });
  app.post('/artifacts', createArtifact);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.R_PUBLIC_URL = undefined;
  mockResolveArtifactRouteAuth.mockReturnValue({
    ok: true,
    auth: { runId: 42 },
  });
  mockVerifyArtifactRouteTaskBinding.mockResolvedValue({ ok: true });
  mockVerifyTaskAccessForArtifact.mockResolvedValue(true);
  mockCreateTaskArtifactRecord.mockResolvedValue({
    id: 'art-1',
    version: 1,
    artifactType: 'general',
  });
  mockGenerateUploadUrl.mockResolvedValue('https://upload.example.com/art-1');
});

describe('createArtifact', () => {
  it('normalizes the public URL for view and image raw URLs', async () => {
    mockEnv.R_PUBLIC_URL = 'https://public.example.com/';

    const response = await createApp().request('http://localhost/artifacts', {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1',
        artifactType: 'general',
        contentType: 'image/png',
        path: 'tmp/capture.png',
        size: 100,
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      viewUrl:
        'https://public.example.com/task/task-1/artifacts/tmp/capture.png?v=1',
      rawUrl:
        'https://public.example.com/api/artifacts/art-1/raw?sig=signed&ts=1234',
    });
    expect(mockBuildSignedArtifactRawUrl).toHaveBeenCalledWith({
      artifactId: 'art-1',
      ts: 1234,
      apiBaseUrl: 'https://public.example.com',
      signingKey: 'signing-key',
    });
  });

  it('accepts architecture snapshots through the generic artifact route', async () => {
    mockCreateTaskArtifactRecord.mockResolvedValue({
      id: 'art-snapshot',
      version: 2,
      artifactType: 'architecture-snapshot',
    });

    const response = await createApp().request('http://localhost/artifacts', {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1',
        artifactType: 'architecture-snapshot',
        contentType: 'application/json',
        path: 'architecture-snapshots/current.json',
        size: 100,
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(response.status).toBe(200);
    expect(mockCreateTaskArtifactRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactType: 'architecture-snapshot',
        path: 'architecture-snapshots/current.json',
      }),
    );
    expect(await response.json()).toMatchObject({
      id: 'art-snapshot',
      version: 2,
      artifactType: 'architecture-snapshot',
    });
  });
});
