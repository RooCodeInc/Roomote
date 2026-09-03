const mocks = vi.hoisted(() => ({
  getArtifact: vi.fn(),
  notifyParent: vi.fn(),
  verifyBinding: vi.fn(),
  updateWhere: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: mocks.updateWhere })),
    })),
  },
  eq: vi.fn((...args: unknown[]) => args),
  taskArtifacts: { id: 'task_artifacts.id' },
}));

vi.mock('@roomote/sdk/server', () => ({
  notifyFastAgentParentOnArtifact: mocks.notifyParent,
}));

vi.mock('../auth', () => ({
  resolveArtifactRouteAuth: vi.fn(() => ({ ok: true, auth: {} })),
  verifyArtifactRouteTaskBinding: mocks.verifyBinding,
}));

vi.mock('../service', () => ({
  getArtifactById: mocks.getArtifact,
}));

import { markArtifactUploadComplete } from '../upload-complete';

function context() {
  return {
    get: vi.fn(() => ({})),
    req: {
      param: vi.fn(() => 'artifact-1'),
      query: vi.fn(() => 'task-1'),
    },
    json: vi.fn((body: unknown, status: number) =>
      Response.json(body, { status }),
    ),
  } as never;
}

describe('markArtifactUploadComplete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyBinding.mockResolvedValue({ ok: true });
    mocks.updateWhere.mockResolvedValue(undefined);
    mocks.getArtifact.mockResolvedValue({
      id: 'artifact-1',
      taskId: 'task-1',
      runId: 200,
      path: 'reports/result.md',
      version: 1,
      uploaded: false,
    });
    mocks.notifyParent.mockResolvedValue('queued');
  });

  it('notifies the Fast parent immediately after upload publication', async () => {
    const response = await markArtifactUploadComplete(context());

    expect(response.status).toBe(200);
    expect(mocks.notifyParent).toHaveBeenCalledWith({
      id: 'artifact-1',
      taskId: 'task-1',
      runId: 200,
      path: 'reports/result.md',
      version: 1,
      uploaded: true,
    });
  });

  it('replays publication through idempotent durable admission', async () => {
    expect((await markArtifactUploadComplete(context())).status).toBe(200);
    expect((await markArtifactUploadComplete(context())).status).toBe(200);
    expect(mocks.notifyParent).toHaveBeenCalledTimes(2);
  });

  it('returns a retryable failure when parent notification fails', async () => {
    mocks.notifyParent.mockResolvedValueOnce('failed');

    const response = await markArtifactUploadComplete(context());

    expect(response.status).toBe(503);
  });
});
