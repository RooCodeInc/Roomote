import { parseGitHubRepoReference } from './github-urls';

describe('parseGitHubRepoReference', () => {
  it('parses bare owner/repo shorthand', () => {
    expect(parseGitHubRepoReference('RooCodeInc/Roomote')).toEqual({
      owner: 'RooCodeInc',
      repo: 'Roomote',
    });
  });

  it('parses full GitHub URLs', () => {
    expect(
      parseGitHubRepoReference('https://github.com/RooCodeInc/Roomote'),
    ).toEqual({ owner: 'RooCodeInc', repo: 'Roomote' });
    expect(parseGitHubRepoReference('github.com/acme/repo')).toEqual({
      owner: 'acme',
      repo: 'repo',
    });
    expect(parseGitHubRepoReference('http://www.github.com/acme/repo')).toEqual(
      { owner: 'acme', repo: 'repo' },
    );
  });

  it('strips .git suffixes, extra path segments, queries, and fragments', () => {
    expect(
      parseGitHubRepoReference('https://github.com/acme/repo.git'),
    ).toEqual({ owner: 'acme', repo: 'repo' });
    expect(
      parseGitHubRepoReference('https://github.com/acme/repo/tree/main/src'),
    ).toEqual({ owner: 'acme', repo: 'repo' });
    expect(
      parseGitHubRepoReference('https://github.com/acme/repo?tab=readme'),
    ).toEqual({ owner: 'acme', repo: 'repo' });
    expect(
      parseGitHubRepoReference('https://github.com/acme/repo#readme'),
    ).toEqual({ owner: 'acme', repo: 'repo' });
    expect(parseGitHubRepoReference('  acme/repo  ')).toEqual({
      owner: 'acme',
      repo: 'repo',
    });
  });

  it('rejects values that do not identify a GitHub repository', () => {
    expect(parseGitHubRepoReference('')).toBeNull();
    expect(parseGitHubRepoReference('   ')).toBeNull();
    expect(parseGitHubRepoReference('just-an-owner')).toBeNull();
    expect(
      parseGitHubRepoReference('https://github.com/only-owner'),
    ).toBeNull();
    expect(parseGitHubRepoReference('https://gitlab.com/acme/repo')).toBeNull();
    expect(
      parseGitHubRepoReference('https://example.com/acme/repo'),
    ).toBeNull();
    expect(parseGitHubRepoReference('acme//repo///')).toEqual({
      owner: 'acme',
      repo: 'repo',
    });
    expect(parseGitHubRepoReference('bad owner/repo')).toBeNull();
  });
});
