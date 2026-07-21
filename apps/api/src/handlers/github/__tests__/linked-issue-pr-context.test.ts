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

  it('collects GraphQL cross-references and development connections', async () => {
    const graphql = vi.fn().mockResolvedValue({
      repository: {
        issueOrPullRequest: {
          __typename: 'Issue',
          timelineItems: {
            nodes: [
              {
                __typename: 'CrossReferencedEvent',
                source: {
                  __typename: 'PullRequest',
                  number: 963,
                  title: 'feat: enable image support',
                  url: 'https://github.com/acme/api/pull/963',
                  state: 'OPEN',
                  repository: { nameWithOwner: 'acme/api' },
                },
              },
              {
                __typename: 'CrossReferencedEvent',
                source: {
                  __typename: 'PullRequest',
                  number: 963,
                  title: 'feat: enable image support',
                  url: 'https://github.com/acme/api/pull/963',
                  state: 'OPEN',
                  repository: { nameWithOwner: 'acme/api' },
                },
              },
              {
                __typename: 'ConnectedEvent',
                subject: {
                  __typename: 'Issue',
                  number: 12,
                  title: 'Sibling issue',
                  url: 'https://github.com/acme/api/issues/12',
                  state: 'OPEN',
                  repository: { nameWithOwner: 'acme/api' },
                },
              },
              {
                // Same repository/number as the mention target must be skipped.
                __typename: 'CrossReferencedEvent',
                source: {
                  __typename: 'Issue',
                  number: 42,
                  title: 'Self',
                  url: 'https://github.com/acme/api/issues/42',
                  state: 'OPEN',
                  repository: { nameWithOwner: 'acme/api' },
                },
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

    expect(graphql).toHaveBeenCalled();
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
