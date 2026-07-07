import { checkMergeability } from '../check-mergeability';

const mockPullsGet = vi.fn();
const mockOctokit = {
  rest: {
    pulls: {
      get: mockPullsGet,
    },
  },
} as unknown as Parameters<typeof checkMergeability>[0];

describe('checkMergeability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns clean when PR is mergeable', async () => {
    mockPullsGet.mockResolvedValue({
      data: { mergeable: true },
    });

    const result = await checkMergeability(mockOctokit, 'owner', 'repo', 1);
    expect(result.status).toBe('clean');
  });

  it('returns conflicting when PR has conflicts', async () => {
    mockPullsGet.mockResolvedValue({
      data: { mergeable: false },
    });

    const result = await checkMergeability(mockOctokit, 'owner', 'repo', 1);
    expect(result.status).toBe('conflicting');
  });

  it('returns unknown when mergeable is null', async () => {
    mockPullsGet.mockResolvedValue({
      data: { mergeable: null },
    });

    const result = await checkMergeability(mockOctokit, 'owner', 'repo', 1);
    expect(result.status).toBe('unknown');
  });

  it('returns unknown on API error', async () => {
    mockPullsGet.mockRejectedValue(new Error('API error'));

    const result = await checkMergeability(mockOctokit, 'owner', 'repo', 1);
    expect(result.status).toBe('unknown');
  });
});
