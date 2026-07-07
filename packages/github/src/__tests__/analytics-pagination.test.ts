import type { PullRequestListItem } from '../api';
import { listRepositoryPullRequestsForAnalytics } from '../api';

function buildPullRequest(
  number: number,
  createdAt: string,
): PullRequestListItem {
  return {
    created_at: createdAt,
    draft: false,
    html_url: `https://github.com/owner/repo/pull/${number}`,
    merged_at: null,
    number,
    state: 'open',
    title: `PR ${number}`,
    user: { login: `user-${number}` },
  } as PullRequestListItem;
}

describe('listRepositoryPullRequestsForAnalytics', () => {
  it('caps all-time pagination by max pages', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: Array.from({ length: 2 }, (_, index) =>
          buildPullRequest(index + 1, '2026-03-16T12:00:00Z'),
        ),
      })
      .mockResolvedValueOnce({
        data: Array.from({ length: 2 }, (_, index) =>
          buildPullRequest(index + 3, '2026-03-15T12:00:00Z'),
        ),
      })
      .mockResolvedValueOnce({
        data: Array.from({ length: 2 }, (_, index) =>
          buildPullRequest(index + 5, '2026-03-14T12:00:00Z'),
        ),
      });

    const octokit = {
      rest: {
        pulls: {
          list,
        },
      },
    } as unknown as Pick<import('@octokit/rest').Octokit, 'rest'>;

    const results = await listRepositoryPullRequestsForAnalytics({
      fullName: 'owner/repo',
      octokit,
      maxPages: 2,
      perPage: 2,
    });

    expect(list).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.number)).toEqual([1, 2, 3, 4]);
  });

  it('stops paging when a createdAfter cutoff is reached', async () => {
    const list = vi.fn().mockResolvedValueOnce({
      data: [
        buildPullRequest(1, '2026-03-16T12:00:00Z'),
        buildPullRequest(2, '2026-03-10T12:00:00Z'),
      ],
    });

    const octokit = {
      rest: {
        pulls: {
          list,
        },
      },
    } as unknown as Pick<import('@octokit/rest').Octokit, 'rest'>;

    const results = await listRepositoryPullRequestsForAnalytics({
      fullName: 'owner/repo',
      octokit,
      createdAfter: new Date('2026-03-12T00:00:00Z'),
      perPage: 2,
    });

    expect(list).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.number)).toEqual([1]);
  });
});
