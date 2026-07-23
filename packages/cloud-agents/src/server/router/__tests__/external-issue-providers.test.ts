import {
  matchExternalIssueUrl,
  type ExternalIssueProvider,
} from '../external-issue-providers';

describe('matchExternalIssueUrl', () => {
  it('maps a GitHub issue URL to issue_read with a get_issue fallback', () => {
    const match = matchExternalIssueUrl(
      new URL('https://github.com/acme/web/issues/42'),
    );

    expect(match?.fetchAttempts).toEqual([
      {
        serverId: 'github',
        toolName: 'issue_read',
        args: { method: 'get', owner: 'acme', repo: 'web', issue_number: 42 },
      },
      {
        serverId: 'github',
        toolName: 'get_issue',
        args: { owner: 'acme', repo: 'web', issue_number: 42 },
      },
    ]);
  });

  it('maps a Linear issue URL to get_issue', () => {
    const match = matchExternalIssueUrl(
      new URL('https://linear.app/acme/issue/ENG-123/fix-oauth'),
    );

    expect(match?.fetchAttempts).toEqual([
      { serverId: 'linear', toolName: 'get_issue', args: { id: 'ENG-123' } },
    ]);
  });

  it('ignores URLs no provider claims', () => {
    expect(
      matchExternalIssueUrl(new URL('https://github.com/acme/web/pull/301')),
    ).toBeNull();
    expect(
      matchExternalIssueUrl(new URL('https://example.com/acme/web/issues/42')),
    ).toBeNull();
  });

  it('supports a new provider through a single registry entry', () => {
    const gitlab: ExternalIssueProvider = {
      id: 'gitlab',
      hostnames: ['gitlab.com'],
      pathPattern:
        /^\/(?<project>[^/]+\/[^/]+)\/-\/issues\/(?<issueNumber>\d+)(?:\/.*)?$/,
      buildFetchAttempts: (groups) => [
        {
          serverId: 'github',
          toolName: 'get_issue',
          args: {
            project_id: groups.project,
            issue_iid: Number(groups.issueNumber),
          },
        },
      ],
    };

    const match = matchExternalIssueUrl(
      new URL('https://gitlab.com/acme/web/-/issues/7'),
      [gitlab],
    );

    expect(match?.fetchAttempts).toEqual([
      {
        serverId: 'github',
        toolName: 'get_issue',
        args: { project_id: 'acme/web', issue_iid: 7 },
      },
    ]);
  });
});
