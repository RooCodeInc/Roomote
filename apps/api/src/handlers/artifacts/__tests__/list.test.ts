import { Hono } from 'hono';

import type { Variables } from '../../../types';
import { listTaskArtifacts } from '../list';

const {
  mockBuildSignedArtifactRawUrl,
  mockListArtifactsByTask,
  mockResolveArtifactRouteAuth,
  mockVerifyArtifactRouteTaskReadAccess,
} = vi.hoisted(() => ({
  mockBuildSignedArtifactRawUrl: vi.fn(
    ({ artifactId }: { artifactId: string }) =>
      `https://app.example.com/api/artifacts/${artifactId}/raw?sig=signed&ts=1234`,
  ),
  mockListArtifactsByTask: vi.fn(),
  mockResolveArtifactRouteAuth: vi.fn(),
  mockVerifyArtifactRouteTaskReadAccess: vi.fn(),
}));

vi.mock('../auth', () => ({
  resolveArtifactRouteAuth: mockResolveArtifactRouteAuth,
  verifyArtifactRouteTaskReadAccess: mockVerifyArtifactRouteTaskReadAccess,
}));

vi.mock('../service', () => ({
  listArtifactsByTask: mockListArtifactsByTask,
}));

vi.mock('@roomote/sdk/server', () => ({
  buildSignedArtifactRawUrl: mockBuildSignedArtifactRawUrl,
  currentEpochSeconds: () => 1234,
}));

vi.mock('@roomote/env', () => ({
  Env: {
    ROOMOTE_APP_URL: 'https://app.example.com',
    ARTIFACT_SIGNING_KEY: 'signing-key',
  },
  getArtifactSigningKey: () => 'signing-key',
}));

const auth = {
  userId: 'user-1',
  cloudJobId: 42,
  tokenType: 'cj' as const,
};

function createApp() {
  const app = new Hono<{ Variables: Variables }>();

  app.get('/tasks/:taskId/artifacts', listTaskArtifacts);

  return app;
}

function artifactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'art-1',
    taskId: 'task-1',
    cloudJobId: 42,
    artifactType: 'general',
    contentType: 'text/markdown',
    path: 'notes/summary.md',
    version: 1,
    size: 100,
    uploaded: true,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveArtifactRouteAuth.mockReturnValue({ ok: true, auth });
  mockVerifyArtifactRouteTaskReadAccess.mockResolvedValue({ ok: true });
  mockListArtifactsByTask.mockResolvedValue([]);
});

describe('listTaskArtifacts', () => {
  it('returns artifacts with view URLs and signed raw URLs for images', async () => {
    mockListArtifactsByTask.mockResolvedValue([
      artifactRow(),
      artifactRow({
        id: 'art-2',
        artifactType: 'visual-proof',
        contentType: 'image/png',
        path: 'tmp/capture.png',
        version: 0,
        size: 999,
      }),
    ]);

    const response = await createApp().request(
      'http://localhost/tasks/task-1/artifacts',
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      taskId: string;
      artifacts: Array<Record<string, unknown>>;
    };

    expect(body.taskId).toBe('task-1');
    expect(body.artifacts).toHaveLength(2);
    expect(body.artifacts[0]).toMatchObject({
      id: 'art-1',
      path: 'notes/summary.md',
      version: 1,
      artifactType: 'general',
      contentType: 'text/markdown',
      size: 100,
      viewUrl:
        'https://app.example.com/task/task-1/artifacts/notes/summary.md?v=1',
    });
    expect(body.artifacts[0]!.rawUrl).toBeUndefined();
    expect(body.artifacts[1]).toMatchObject({
      id: 'art-2',
      path: 'tmp/capture.png',
      artifactType: 'visual-proof',
      viewUrl:
        'https://app.example.com/task/task-1/artifacts/tmp/capture.png?v=0',
      rawUrl:
        'https://app.example.com/api/artifacts/art-2/raw?sig=signed&ts=1234',
    });
    expect(mockBuildSignedArtifactRawUrl).toHaveBeenCalledTimes(1);
    expect(mockBuildSignedArtifactRawUrl).toHaveBeenCalledWith({
      artifactId: 'art-2',
      ts: 1234,
      apiBaseUrl: 'https://app.example.com',
      signingKey: 'signing-key',
    });
    expect(mockListArtifactsByTask).toHaveBeenCalledWith({
      taskId: 'task-1',
      artifactType: undefined,
      auth: {},
    });
  });

  it('forwards a valid artifactType filter to the service', async () => {
    const response = await createApp().request(
      'http://localhost/tasks/task-1/artifacts?artifactType=visual-proof',
    );

    expect(response.status).toBe(200);
    expect(mockListArtifactsByTask).toHaveBeenCalledWith({
      taskId: 'task-1',
      artifactType: 'visual-proof',
      auth: {},
    });
  });

  it('rejects an invalid artifactType filter', async () => {
    const response = await createApp().request(
      'http://localhost/tasks/task-1/artifacts?artifactType=bogus',
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Invalid artifactType filter',
    });
    expect(mockListArtifactsByTask).not.toHaveBeenCalled();
  });

  it('rejects non cloud-job callers', async () => {
    mockResolveArtifactRouteAuth.mockReturnValue({
      ok: false,
      status: 403,
      error: 'Artifact API is only available for cloud job tokens',
    });

    const response = await createApp().request(
      'http://localhost/tasks/task-1/artifacts',
    );

    expect(response.status).toBe(403);
    expect(mockListArtifactsByTask).not.toHaveBeenCalled();
  });

  it('rejects tasks the cloud job token cannot read', async () => {
    mockVerifyArtifactRouteTaskReadAccess.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'Cloud job token does not grant read access to requested task',
    });

    const response = await createApp().request(
      'http://localhost/tasks/task-other/artifacts',
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Cloud job token does not grant read access to requested task',
    });
    expect(mockListArtifactsByTask).not.toHaveBeenCalled();
  });
});
