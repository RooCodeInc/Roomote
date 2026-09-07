import { listArtifactsByTask, validateArtifactPath } from '../service';

const { andMock, ascMock, descMock, eqMock, orderByMock, mockSelect } =
  vi.hoisted(() => ({
    andMock: vi.fn((...args) => ({ type: 'and', args })),
    ascMock: vi.fn((column) => ({ type: 'asc', column })),
    descMock: vi.fn((column) => ({ type: 'desc', column })),
    eqMock: vi.fn((...args) => ({ type: 'eq', args })),
    orderByMock: vi.fn(),
    mockSelect: vi.fn(),
  }));

vi.mock('@roomote/db/server', () => ({
  and: andMock,
  asc: ascMock,
  db: { select: mockSelect },
  desc: descMock,
  eq: eqMock,
  taskArtifacts: {
    taskId: 'taskArtifacts.taskId',
    uploaded: 'taskArtifacts.uploaded',
    artifactType: 'taskArtifacts.artifactType',
    path: 'taskArtifacts.path',
    version: 'taskArtifacts.version',
    createdAt: 'taskArtifacts.createdAt',
  },
  tasks: { id: 'tasks.id' },
}));

function mockRows(rows: Array<Record<string, unknown>>) {
  orderByMock.mockResolvedValue(rows);
  mockSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ orderBy: orderByMock }),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listArtifactsByTask', () => {
  it('keeps only the latest version per artifact path', async () => {
    mockRows([
      { id: 'a', path: 'plans/plan.md', version: 1 },
      { id: 'b', path: 'plans/plan.md', version: 2 },
      { id: 'c', path: 'tmp/capture.png', version: 0 },
    ]);

    const result = await listArtifactsByTask({ taskId: 'task-1', auth: {} });

    expect(result).toEqual([
      { id: 'b', path: 'plans/plan.md', version: 2 },
      { id: 'c', path: 'tmp/capture.png', version: 0 },
    ]);
  });

  it('filters to uploaded artifacts for the requested task', async () => {
    mockRows([]);

    await listArtifactsByTask({ taskId: 'task-1', auth: {} });

    expect(eqMock).toHaveBeenCalledWith('taskArtifacts.taskId', 'task-1');
    expect(eqMock).toHaveBeenCalledWith('taskArtifacts.uploaded', true);
    expect(eqMock).not.toHaveBeenCalledWith(
      'taskArtifacts.artifactType',
      expect.anything(),
    );
  });

  it('applies the artifactType filter when provided', async () => {
    mockRows([]);

    await listArtifactsByTask({
      taskId: 'task-1',
      artifactType: 'visual-proof',
      auth: {},
    });

    expect(eqMock).toHaveBeenCalledWith(
      'taskArtifacts.artifactType',
      'visual-proof',
    );
  });
});

describe('validateArtifactPath', () => {
  it('uses the shared artifact path policy', () => {
    expect(validateArtifactPath('plans/result.md')).toEqual({ valid: true });
    expect(validateArtifactPath('C:\\Users\\roomote\\secret.txt')).toEqual({
      valid: false,
      error: 'Invalid path: absolute paths are not allowed',
    });
  });
});
