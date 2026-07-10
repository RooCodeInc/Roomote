import {
  buildPullRequestUrl,
  buildRepositoryCloneUrl,
  buildSourceControlTokenMetadata,
  getSourceControlTokenEnvVar,
  normalizeSourceControlProvider,
  parsePullRequestUrl,
  resolveSourceControlProviderFromPayload,
  stripCloneUrlUserInfo,
} from '../source-control';

describe('source control provider helpers', () => {
  it('defaults omitted providers to GitHub', () => {
    expect(normalizeSourceControlProvider(undefined)).toBe('github');
    expect(resolveSourceControlProviderFromPayload({})).toBe('github');
  });

  it('accepts token-backed source control providers', () => {
    expect(normalizeSourceControlProvider('gitlab')).toBe('gitlab');
    expect(
      resolveSourceControlProviderFromPayload({
        sourceControlProvider: 'gitlab',
      }),
    ).toBe('gitlab');
    expect(normalizeSourceControlProvider('gitea')).toBe('gitea');
    expect(
      resolveSourceControlProviderFromPayload({
        sourceControlProvider: 'gitea',
      }),
    ).toBe('gitea');
    expect(normalizeSourceControlProvider('ado')).toBe('ado');
    expect(
      resolveSourceControlProviderFromPayload({
        sourceControlProvider: 'ado',
      }),
    ).toBe('ado');
  });

  it('maps providers to their runtime token environment variable', () => {
    expect(getSourceControlTokenEnvVar('github')).toBe('GH_TOKEN');
    expect(getSourceControlTokenEnvVar('gitlab')).toBe('GITLAB_TOKEN');
    expect(getSourceControlTokenEnvVar('gitea')).toBe('GITEA_TOKEN');
    expect(getSourceControlTokenEnvVar('ado')).toBe('ADO_TOKEN');

    expect(buildSourceControlTokenMetadata('gitlab', 'glpat_test')).toEqual({
      provider: 'gitlab',
      token: 'glpat_test',
      envVar: 'GITLAB_TOKEN',
      envVars: { GITLAB_TOKEN: 'glpat_test' },
    });
    expect(buildSourceControlTokenMetadata('gitea', 'gitea_test')).toEqual({
      provider: 'gitea',
      token: 'gitea_test',
      envVar: 'GITEA_TOKEN',
      envVars: { GITEA_TOKEN: 'gitea_test' },
    });
    expect(buildSourceControlTokenMetadata('ado', 'ado_test')).toEqual({
      provider: 'ado',
      token: 'ado_test',
      envVar: 'ADO_TOKEN',
      envVars: { ADO_TOKEN: 'ado_test' },
    });
  });

  it('builds provider-specific pull request URLs', () => {
    expect(
      buildPullRequestUrl({
        provider: 'github',
        host: 'github.com',
        repositoryFullName: 'owner/repo',
        number: 42,
      }),
    ).toBe('https://github.com/owner/repo/pull/42');

    expect(
      buildPullRequestUrl({
        provider: 'gitlab',
        host: 'gitlab.com',
        repositoryFullName: 'group/subgroup/repo',
        number: 42,
      }),
    ).toBe('https://gitlab.com/group/subgroup/repo/-/merge_requests/42');

    expect(
      buildPullRequestUrl({
        provider: 'gitea',
        host: 'git.example.com',
        repositoryFullName: 'team/repo',
        number: 42,
      }),
    ).toBe('https://git.example.com/team/repo/pulls/42');

    expect(
      buildPullRequestUrl({
        provider: 'ado',
        host: 'dev.azure.com',
        repositoryFullName: 'acme/Platform/backend',
        number: 42,
      }),
    ).toBe('https://dev.azure.com/acme/Platform/_git/backend/pullrequest/42');
  });

  it('builds provider-specific clone URLs', () => {
    expect(
      buildRepositoryCloneUrl({
        provider: 'github',
        repositoryFullName: 'owner/repo',
      }),
    ).toBe('https://github.com/owner/repo.git');

    expect(
      buildRepositoryCloneUrl({
        provider: 'gitlab',
        repositoryFullName: 'group/subgroup/repo',
      }),
    ).toBe('https://gitlab.com/group/subgroup/repo.git');

    expect(
      buildRepositoryCloneUrl({
        provider: 'gitea',
        host: 'git.example.com',
        repositoryFullName: 'team/repo',
      }),
    ).toBe('https://git.example.com/team/repo.git');

    expect(
      buildRepositoryCloneUrl({
        provider: 'ado',
        repositoryFullName: 'acme/Platform/backend',
      }),
    ).toBe('https://dev.azure.com/acme/Platform/_git/backend');
  });

  it('strips userinfo from clone URLs', () => {
    expect(
      stripCloneUrlUserInfo(
        'https://acme@dev.azure.com/acme/Test%20ADO/_git/Test%20ADO',
      ),
    ).toBe('https://dev.azure.com/acme/Test%20ADO/_git/Test%20ADO');

    expect(
      stripCloneUrlUserInfo('https://user:secret@git.example.com/team/repo'),
    ).toBe('https://git.example.com/team/repo');

    expect(stripCloneUrlUserInfo('https://github.com/owner/repo.git')).toBe(
      'https://github.com/owner/repo.git',
    );

    expect(stripCloneUrlUserInfo('not a url')).toBe('not a url');
  });

  it('parses GitHub, GitLab, Gitea, and Azure DevOps pull request URLs', () => {
    expect(
      parsePullRequestUrl('https://github.com/owner/repo/pull/42'),
    ).toEqual({
      provider: 'github',
      host: 'github.com',
      repositoryFullName: 'owner/repo',
      number: 42,
    });

    expect(
      parsePullRequestUrl(
        'https://gitlab.com/group/subgroup/repo/-/merge_requests/42',
      ),
    ).toEqual({
      provider: 'gitlab',
      host: 'gitlab.com',
      repositoryFullName: 'group/subgroup/repo',
      number: 42,
    });

    expect(
      parsePullRequestUrl(
        'https://gitlab.example.com/group/repo/-/merge_requests/7',
      ),
    ).toEqual({
      provider: 'gitlab',
      host: 'gitlab.example.com',
      repositoryFullName: 'group/repo',
      number: 7,
    });

    expect(
      parsePullRequestUrl('https://git.example.com/team/repo/pulls/42'),
    ).toEqual({
      provider: 'gitea',
      host: 'git.example.com',
      repositoryFullName: 'team/repo',
      number: 42,
    });

    expect(
      parsePullRequestUrl(
        'https://dev.azure.com/acme/Platform/_git/backend/pullrequest/42',
      ),
    ).toEqual({
      provider: 'ado',
      host: 'dev.azure.com',
      repositoryFullName: 'acme/Platform/backend',
      number: 42,
    });
  });
});
