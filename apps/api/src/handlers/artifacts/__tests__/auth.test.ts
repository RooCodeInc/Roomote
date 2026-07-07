import {
  verifyArtifactRouteTaskBinding,
  verifyArtifactRouteTaskReadAccess,
} from '../auth';

const {
  andMock,
  eqMock,
  isVisibleTaskMock,
  mockCloudJobFindFirst,
  mockFindCloudJobByJobTokenClaims,
  mockTaskFindFirst,
} = vi.hoisted(() => ({
  andMock: vi.fn((...args) => ({ type: 'and', args })),
  eqMock: vi.fn((...args) => ({ type: 'eq', args })),
  isVisibleTaskMock: vi.fn((column) => ({ type: 'isVisibleTask', column })),
  mockCloudJobFindFirst: vi.fn(),
  mockFindCloudJobByJobTokenClaims: vi.fn(),
  mockTaskFindFirst: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: andMock,
  cloudJobs: { id: 'cloudJobs.id' },
  db: {
    query: {
      cloudJobs: {
        findFirst: mockCloudJobFindFirst,
      },
      tasks: {
        findFirst: mockTaskFindFirst,
      },
    },
  },
  eq: eqMock,
  isVisibleTask: isVisibleTaskMock,
  tasks: { id: 'tasks.id' },
}));

vi.mock('@roomote/sdk/server', () => ({
  findCloudJobByJobTokenClaims: mockFindCloudJobByJobTokenClaims,
}));

const auth = {
  userId: 'user-1',
  cloudJobId: 42,
  tokenType: 'cj' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindCloudJobByJobTokenClaims.mockResolvedValue({ id: 42 });
  mockCloudJobFindFirst.mockResolvedValue({ taskId: 'task-own' });
});

describe('verifyArtifactRouteTaskBinding', () => {
  it('allows the task that owns the calling cloud job', async () => {
    const result = await verifyArtifactRouteTaskBinding('task-own', auth);

    expect(result).toEqual({ ok: true });
  });

  it('rejects any other task', async () => {
    const result = await verifyArtifactRouteTaskBinding('task-other', auth);

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Cloud job token does not match requested task',
    });
  });

  it('rejects when the cloud job binding cannot be resolved', async () => {
    mockFindCloudJobByJobTokenClaims.mockResolvedValue(null);

    const result = await verifyArtifactRouteTaskBinding('task-own', auth);

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Cloud job token does not match requested task',
    });
  });
});

describe('verifyArtifactRouteTaskReadAccess', () => {
  it('allows the task that owns the calling cloud job without a task lookup', async () => {
    const result = await verifyArtifactRouteTaskReadAccess('task-own', auth);

    expect(result).toEqual({ ok: true });
    expect(mockTaskFindFirst).not.toHaveBeenCalled();
  });

  it('allows cross-task reads for other visible tasks', async () => {
    mockTaskFindFirst.mockResolvedValue({ id: 'task-other' });

    const result = await verifyArtifactRouteTaskReadAccess('task-other', auth);

    expect(result).toEqual({ ok: true });
    expect(isVisibleTaskMock).toHaveBeenCalledWith('tasks.id');
  });

  it('rejects cross-task reads when the requested task is missing or hidden', async () => {
    mockTaskFindFirst.mockResolvedValue(undefined);

    const result = await verifyArtifactRouteTaskReadAccess('task-other', auth);

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Cloud job token does not grant read access to requested task',
    });
  });

  it('rejects when the cloud job binding cannot be resolved', async () => {
    mockFindCloudJobByJobTokenClaims.mockResolvedValue(null);

    const result = await verifyArtifactRouteTaskReadAccess('task-other', auth);

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Cloud job token does not grant read access to requested task',
    });
    expect(mockTaskFindFirst).not.toHaveBeenCalled();
  });
});
