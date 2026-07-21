const { mockGetInstallationOctokit } = vi.hoisted(() => ({
  mockGetInstallationOctokit: vi.fn(),
}));

vi.mock('@roomote/github', () => ({
  getInstallationOctokit: mockGetInstallationOctokit,
}));

import {
  fetchGitHubLinkedReferences,
  formatGitHubLinkedReferencesSection,
} from '../linked-issue-pr-context';

function issueNode(overrides: {
  number: number;
  title: string;
  url: string;
  state?: string;
  typename?: 'Issue' | 'PullRequest';
  repository?: string;
}) {
  return {
    __typename: overrides.typename ?? 'Issue',
    number: overrides.number,
    title: overrides.title,
    url: overrides.url,
    state: overrides.state ?? 'OPEN',
    repository: { nameWithOwner: overrides.repository ?? 'acme/api' },
  };
}

describe('linked-issue-pr-context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('formats linked issue and PR metadata lines', () => {
    const section = formatGitHubLinkedReferencesSection([
      {
        kind: 'pull_request',
        number: 963,
        title: 'feat: enable image support',
        url: 'https://github.com/acme/api/pull/963',
        state: 'open',
        repository: 'acme/api',
      },
      {
        kind: 'issue',
        number: 12,
        title: 'Related bug',
        repository: 'acme/api',
      },
    ]);

    expect(section).toContain(
      'Pull request acme/api#963 — feat: enable image support [open] (https://github.com/acme/api/pull/963)',
    );
    expect(section).toContain('Issue acme/api#12 — Related bug');
  });

  it('returns undefined when there are no linked references', () => {
    expect(formatGitHubLinkedReferencesSection([])).toBeUndefined();
  });

  it('collects GraphQL cross-references and active development connections', async () => {
    const graphql = vi.fn().mockResolvedValue({
      repository: {
        issueOrPullRequest: {
          __typename: 'Issue',
          timelineItems: {
            pageInfo: { hasPreviousPage: false, startCursor: null },
            nodes: [
              {
                __typename: 'CrossReferencedEvent',
                source: issueNode({
                  number: 963,
                  title: 'feat: enable image support',
                  url: 'https://github.com/acme/api/pull/963',
                  typename: 'PullRequest',
                }),
              },
              {
                __typename: 'CrossReferencedEvent',
                source: issueNode({
                  number: 963,
                  title: 'feat: enable image support',
                  url: 'https://github.com/acme/api/pull/963',
                  typename: 'PullRequest',
                }),
              },
              {
                __typename: 'ConnectedEvent',
                subject: issueNode({
                  number: 12,
                  title: 'Sibling issue',
                  url: 'https://github.com/acme/api/issues/12',
                }),
              },
              {
                // Same repository/number as the mention target must be skipped.
                __typename: 'CrossReferencedEvent',
                source: issueNode({
                  number: 42,
                  title: 'Self',
                  url: 'https://github.com/acme/api/issues/42',
                }),
              },
            ],
          },
        },
      },
    });
    const request = vi.fn();

    mockGetInstallationOctokit.mockResolvedValue({ graphql, request });

    const refs = await fetchGitHubLinkedReferences({
      installationId: 1,
      repositoryFullName: 'acme/api',
      issueOrPrNumber: 42,
    });

    expect(graphql).toHaveBeenCalledWith(
      expect.stringContaining('RoomoteLinkedReferences'),
      expect.objectContaining({
        owner: 'acme',
        name: 'api',
        number: 42,
        cursor: null,
        includeClosingIssues: true,
      }),
    );
    expect(graphql.mock.calls[0]?.[0]).toContain('last: $limit');
    expect(graphql.mock.calls[0]?.[0]).toContain('before: $cursor');
    expect(request).not.toHaveBeenCalled();
    expect(refs).toEqual([
      {
        kind: 'issue',
        number: 12,
        title: 'Sibling issue',
        url: 'https://github.com/acme/api/issues/12',
        state: 'OPEN',
        repository: 'acme/api',
      },
      {
        kind: 'pull_request',
        number: 963,
        title: 'feat: enable image support',
        url: 'https://github.com/acme/api/pull/963',
        state: 'OPEN',
        repository: 'acme/api',
      },
    ]);
  });

  it('drops development links after a matching disconnect without removing cross-references', async () => {
    const graphql = vi.fn().mockResolvedValue({
      repository: {
        issueOrPullRequest: {
          __typename: 'Issue',
          timelineItems: {
            pageInfo: { hasPreviousPage: false, startCursor: null },
            nodes: [
              {
                __typename: 'ConnectedEvent',
                subject: issueNode({
                  number: 12,
                  title: 'Linked then unlinked',
                  url: 'https://github.com/acme/api/issues/12',
                }),
              },
              {
                __typename: 'DisconnectedEvent',
                subject: issueNode({
                  number: 12,
                  title: 'Linked then unlinked',
                  url: 'https://github.com/acme/api/issues/12',
                }),
              },
              {
                __typename: 'CrossReferencedEvent',
                source: issueNode({
                  number: 12,
                  title: 'Still mentioned in a comment',
                  url: 'https://github.com/acme/api/issues/12',
                }),
              },
              {
                __typename: 'ConnectedEvent',
                subject: issueNode({
                  number: 99,
                  title: 'Still linked',
                  url: 'https://github.com/acme/api/issues/99',
                }),
              },
            ],
          },
        },
      },
    });

    mockGetInstallationOctokit.mockResolvedValue({ graphql, request: vi.fn() });

    const refs = await fetchGitHubLinkedReferences({
      installationId: 1,
      repositoryFullName: 'acme/api',
      issueOrPrNumber: 42,
    });

    expect(refs).toEqual([
      {
        kind: 'issue',
        number: 12,
        title: 'Still mentioned in a comment',
        url: 'https://github.com/acme/api/issues/12',
        state: 'OPEN',
        repository: 'acme/api',
      },
      {
        kind: 'issue',
        number: 99,
        title: 'Still linked',
        url: 'https://github.com/acme/api/issues/99',
        state: 'OPEN',
        repository: 'acme/api',
      },
    ]);
  });

  it('paginates GraphQL timeline items from the recent end and applies them chronologically', async () => {
    const graphql = vi
      .fn()
      // First call: newest page (later events).
      .mockResolvedValueOnce({
        repository: {
          issueOrPullRequest: {
            __typename: 'Issue',
            timelineItems: {
              pageInfo: { hasPreviousPage: true, startCursor: 'cursor-new' },
              nodes: [
                {
                  __typename: 'DisconnectedEvent',
                  subject: issueNode({
                    number: 1,
                    title: 'Unlinked on newer page',
                    url: 'https://github.com/acme/api/issues/1',
                  }),
                },
                {
                  __typename: 'CrossReferencedEvent',
                  source: issueNode({
                    number: 2,
                    title: 'Cross-ref on newer page',
                    url: 'https://github.com/acme/api/pull/2',
                    typename: 'PullRequest',
                  }),
                },
              ],
            },
          },
        },
      })
      // Second call: older page inside the retained window.
      .mockResolvedValueOnce({
        repository: {
          issueOrPullRequest: {
            __typename: 'Issue',
            timelineItems: {
              pageInfo: { hasPreviousPage: false, startCursor: 'cursor-old' },
              nodes: [
                {
                  __typename: 'ConnectedEvent',
                  subject: issueNode({
                    number: 1,
                    title: 'Connected earlier',
                    url: 'https://github.com/acme/api/issues/1',
                  }),
                },
              ],
            },
          },
        },
      });

    mockGetInstallationOctokit.mockResolvedValue({ graphql, request: vi.fn() });

    const refs = await fetchGitHubLinkedReferences({
      installationId: 1,
      repositoryFullName: 'acme/api',
      issueOrPrNumber: 42,
    });

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({ cursor: null, includeClosingIssues: true }),
    );
    expect(graphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        cursor: 'cursor-new',
        includeClosingIssues: false,
      }),
    );
    // Issue #1 must be dropped by the newer disconnect; #2 remains via x-ref.
    expect(refs).toEqual([
      {
        kind: 'pull_request',
        number: 2,
        title: 'Cross-ref on newer page',
        url: 'https://github.com/acme/api/pull/2',
        state: 'OPEN',
        repository: 'acme/api',
      },
    ]);
  });

  it('falls back to REST cross-references when GraphQL is unavailable', async () => {
    const request = vi.fn().mockResolvedValue({
      data: [
        {
          event: 'cross-referenced',
          source: {
            type: 'issue',
            issue: {
              number: 963,
              title: 'feat: enable image support',
              html_url: 'https://github.com/acme/api/pull/963',
              state: 'open',
              pull_request: {},
              repository: { full_name: 'acme/api' },
            },
          },
        },
        {
          // REST connected events have no subject; ignore them.
          event: 'connected',
        },
      ],
    });

    mockGetInstallationOctokit.mockResolvedValue({ request });

    const refs = await fetchGitHubLinkedReferences({
      installationId: 1,
      repositoryFullName: 'acme/api',
      issueOrPrNumber: 42,
    });

    expect(request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/timeline',
      expect.objectContaining({
        owner: 'acme',
        repo: 'api',
        issue_number: 42,
      }),
    );
    expect(refs).toEqual([
      {
        kind: 'pull_request',
        number: 963,
        title: 'feat: enable image support',
        url: 'https://github.com/acme/api/pull/963',
        state: 'open',
        repository: 'acme/api',
      },
    ]);
  });

  it('falls back to REST when GraphQL fails', async () => {
    const graphql = vi.fn().mockRejectedValue(new Error('graphql unavailable'));
    const request = vi.fn().mockResolvedValue({
      data: [
        {
          event: 'cross-referenced',
          source: {
            issue: {
              number: 7,
              title: 'From REST',
              html_url: 'https://github.com/acme/api/issues/7',
              state: 'open',
              repository: { full_name: 'acme/api' },
            },
          },
        },
      ],
    });

    mockGetInstallationOctokit.mockResolvedValue({ graphql, request });

    await expect(
      fetchGitHubLinkedReferences({
        installationId: 1,
        repositoryFullName: 'acme/api',
        issueOrPrNumber: 42,
      }),
    ).resolves.toEqual([
      {
        kind: 'issue',
        number: 7,
        title: 'From REST',
        url: 'https://github.com/acme/api/issues/7',
        state: 'open',
        repository: 'acme/api',
      },
    ]);
  });

  it('returns an empty list when GraphQL and REST both fail', async () => {
    mockGetInstallationOctokit.mockResolvedValue({
      graphql: vi.fn().mockRejectedValue(new Error('graphql boom')),
      request: vi.fn().mockRejectedValue(new Error('rest boom')),
    });

    await expect(
      fetchGitHubLinkedReferences({
        installationId: 1,
        repositoryFullName: 'acme/api',
        issueOrPrNumber: 42,
      }),
    ).resolves.toEqual([]);
  });
});
