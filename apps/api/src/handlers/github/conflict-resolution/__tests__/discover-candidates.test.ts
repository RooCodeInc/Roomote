import { AUTO_RESOLVE_CONFLICTS_LABEL } from '../constants';
import { discoverCandidates } from '../discover-candidates';

const mockPaginate = vi.fn();
const mockOctokit = {
  paginate: mockPaginate,
  rest: {
    pulls: {
      list: vi.fn(),
    },
  },
} as unknown as Parameters<typeof discoverCandidates>[0];

describe('discoverCandidates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns candidates with the label that are open (including drafts)', async () => {
    const now = new Date();

    mockPaginate.mockResolvedValue([
      {
        number: 1,
        draft: false,
        labels: [{ name: AUTO_RESOLVE_CONFLICTS_LABEL }],
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        title: 'PR 1',
        html_url: 'https://github.com/owner/repo/pull/1',
        head: {
          ref: 'feature-1',
          sha: 'abc1234',
          repo: {
            name: 'repo',
            owner: { login: 'owner' },
          },
        },
        base: { ref: 'main' },
        user: { login: 'author1', id: 101 },
      },
      {
        number: 2,
        draft: true, // draft — should still be included
        labels: [{ name: AUTO_RESOLVE_CONFLICTS_LABEL }],
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        title: 'PR 2',
        html_url: 'https://github.com/owner/repo/pull/2',
        head: {
          ref: 'feature-2',
          sha: 'def5678',
          repo: {
            name: 'forked-repo',
            owner: { login: 'fork-owner' },
          },
        },
        base: { ref: 'main' },
        user: { login: 'author2', id: 102 },
      },
      {
        number: 3,
        draft: false,
        labels: [], // no label — should be skipped
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        title: 'PR 3',
        html_url: 'https://github.com/owner/repo/pull/3',
        head: { ref: 'feature-3', sha: 'ghi9012' },
        base: { ref: 'main' },
        user: { login: 'author3', id: 103 },
      },
    ]);

    const candidates = await discoverCandidates(
      mockOctokit,
      'owner',
      'repo',
      'main',
    );

    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.prNumber).toBe(1);
    expect(candidates[0]!.headSha).toBe('abc1234');
    expect(candidates[0]!.headRepoOwner).toBe('owner');
    expect(candidates[0]!.headRepoName).toBe('repo');
    expect(candidates[1]!.prNumber).toBe(2);
    expect(candidates[1]!.headSha).toBe('def5678');
    expect(candidates[1]!.headRepoOwner).toBe('fork-owner');
    expect(candidates[1]!.headRepoName).toBe('forked-repo');
  });

  it('skips PRs outside the lookback window', async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10); // 10 days ago, beyond the 7-day window

    mockPaginate.mockResolvedValue([
      {
        number: 1,
        draft: false,
        labels: [{ name: AUTO_RESOLVE_CONFLICTS_LABEL }],
        created_at: oldDate.toISOString(),
        updated_at: oldDate.toISOString(),
        title: 'Old PR',
        html_url: 'https://github.com/owner/repo/pull/1',
        head: { ref: 'old-feature', sha: 'abc1234' },
        base: { ref: 'main' },
      },
    ]);

    const candidates = await discoverCandidates(mockOctokit, 'owner', 'repo');

    expect(candidates).toHaveLength(0);
  });

  it('skips PRs opened before the configured automatic resolution age cap', async () => {
    const now = new Date();
    const oldCreatedAt = new Date();
    oldCreatedAt.setDate(oldCreatedAt.getDate() - 8);

    mockPaginate.mockResolvedValue([
      {
        number: 1,
        draft: false,
        labels: [{ name: AUTO_RESOLVE_CONFLICTS_LABEL }],
        created_at: oldCreatedAt.toISOString(),
        updated_at: now.toISOString(),
        title: 'Long-running PR',
        html_url: 'https://github.com/owner/repo/pull/1',
        head: { ref: 'old-feature', sha: 'abc1234' },
        base: { ref: 'main' },
        user: { login: 'author', id: 101 },
      },
    ]);

    const candidates = await discoverCandidates(
      mockOctokit,
      'owner',
      'repo',
      undefined,
      AUTO_RESOLVE_CONFLICTS_LABEL,
      7,
    );

    expect(candidates).toHaveLength(0);
  });

  it('returns empty array on API error', async () => {
    mockPaginate.mockRejectedValue(new Error('API error'));

    const candidates = await discoverCandidates(mockOctokit, 'owner', 'repo');

    expect(candidates).toEqual([]);
  });
});
