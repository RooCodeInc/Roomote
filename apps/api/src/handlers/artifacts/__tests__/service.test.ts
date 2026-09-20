import { listArtifactsByTask, validateArtifactPath } from '../service';

const { listLatestTaskArtifactsMock } = vi.hoisted(() => ({
  listLatestTaskArtifactsMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  listLatestTaskArtifacts: listLatestTaskArtifactsMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listArtifactsByTask', () => {
  it('returns the shared latest artifact query result', async () => {
    const rows = [
      { id: 'b', path: 'plans/plan.md', version: 2 },
      { id: 'c', path: 'tmp/capture.png', version: 0 },
    ];
    listLatestTaskArtifactsMock.mockResolvedValue(rows);

    const result = await listArtifactsByTask({ taskId: 'task-1', auth: {} });

    expect(result).toBe(rows);
    expect(listLatestTaskArtifactsMock).toHaveBeenCalledWith({
      taskId: 'task-1',
      artifactType: undefined,
    });
  });

  it('applies the artifactType filter when provided', async () => {
    listLatestTaskArtifactsMock.mockResolvedValue([]);

    await listArtifactsByTask({
      taskId: 'task-1',
      artifactType: 'visual-proof',
      auth: {},
    });

    expect(listLatestTaskArtifactsMock).toHaveBeenCalledWith({
      taskId: 'task-1',
      artifactType: 'visual-proof',
    });
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
