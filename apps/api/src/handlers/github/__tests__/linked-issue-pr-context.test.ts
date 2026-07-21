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

  it('collects unique cross-referenced and connected timeline items', async () => {
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
          event: 'connected',
          subject: {
            number: 12,
            title: 'Sibling issue',
            html_url: 'https://github.com/acme/api/issues/12',
            state: 'open',
            repository: { full_name: 'acme/api' },
          },
        },
        {
          // Same repository/number as the mention target must be skipped.
          event: 'cross-referenced',
          source: {
            issue: {
              number: 42,
              title: 'Self',
              html_url: 'https://github.com/acme/api/issues/42',
              repository: { full_name: 'acme/api' },
            },
          },
        },
        {
          event: 'disconnected',
          subject: {
            number: 99,
            title: 'Should be ignored',
            repository: { full_name: 'acme/api' },
          },
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
        kind: 'issue',
        number: 12,
        title: 'Sibling issue',
        url: 'https://github.com/acme/api/issues/12',
        state: 'open',
        repository: 'acme/api',
      },
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

  it('returns an empty list when the timeline API fails', async () => {
    mockGetInstallationOctokit.mockResolvedValue({
      request: vi.fn().mockRejectedValue(new Error('boom')),
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
