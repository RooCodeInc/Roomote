import {
  verifyArtifactRouteTaskBinding,
  verifyArtifactRouteTaskReadAccess,
} from '../auth';

const {
  andMock,
  eqMock,
  isVisibleTaskMock,
  mockTaskRunFindFirst,
  mockFindTaskRunByRunTokenClaims,
  mockTaskFindFirst,
} = vi.hoisted(() => ({
  andMock: vi.fn((...args) => ({ type: 'and', args })),
  eqMock: vi.fn((...args) => ({ type: 'eq', args })),
  isVisibleTaskMock: vi.fn((column) => ({ type: 'isVisibleTask', column })),
  mockTaskRunFindFirst: vi.fn(),
  mockFindTaskRunByRunTokenClaims: vi.fn(),
  mockTaskFindFirst: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: andMock,
  taskRuns: { id: 'taskRuns.id' },
  db: {
    query: {
      taskRuns: {
        findFirst: mockTaskRunFindFirst,
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
  findTaskRunByRunTokenClaims: mockFindTaskRunByRunTokenClaims,
}));

const auth = {
  userId: 'user-1',
  runId: 42,
  tokenType: 'run' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindTaskRunByRunTokenClaims.mockResolvedValue({ id: 42 });
  mockTaskRunFindFirst.mockResolvedValue({ taskId: 'task-own' });
});

describe('verifyArtifactRouteTaskBinding', () => {
  it('allows the task that owns the calling task run', async () => {
    const result = await verifyArtifactRouteTaskBinding('task-own', auth);

    expect(result).toEqual({ ok: true });
  });

  it('rejects any other task', async () => {
    const result = await verifyArtifactRouteTaskBinding('task-other', auth);

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Task run token does not match requested task',
    });
  });

  it('rejects when the task run binding cannot be resolved', async () => {
    mockFindTaskRunByRunTokenClaims.mockResolvedValue(null);

    const result = await verifyArtifactRouteTaskBinding('task-own', auth);

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Task run token does not match requested task',
    });
  });
});

describe('verifyArtifactRouteTaskReadAccess', () => {
  it('allows the task that owns the calling task run without a task lookup', async () => {
    const result = await verifyArtifactRouteTaskReadAccess('task-own', auth);

    expect(result).toEqual({ ok: true });
    expect(mockTaskFindFirst).not.toHaveBeenCalled();
  });

  it('allows cross-task reads for other visible tasks', async () => {
    mockTaskFindFirst.mockResolvedValue({ id: 'task-other' });

    const result = await verifyArtifactRouteTaskReadAccess('task-other', auth);

    expect(result).toEqual({ ok: true });
    // isVisibleTask is now a zero-arg visibility predicate on tasks.
    expect(isVisibleTaskMock).toHaveBeenCalledWith();
  });

  it('rejects cross-task reads when the requested task is missing or hidden', async () => {
    mockTaskFindFirst.mockResolvedValue(undefined);

    const result = await verifyArtifactRouteTaskReadAccess('task-other', auth);

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Task run token does not grant read access to requested task',
    });
  });

  it('rejects when the task run binding cannot be resolved', async () => {
    mockFindTaskRunByRunTokenClaims.mockResolvedValue(null);

    const result = await verifyArtifactRouteTaskReadAccess('task-other', auth);

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Task run token does not grant read access to requested task',
    });
    expect(mockTaskFindFirst).not.toHaveBeenCalled();
  });
});
