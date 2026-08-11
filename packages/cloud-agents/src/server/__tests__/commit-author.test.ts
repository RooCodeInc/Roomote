import {
  DEFAULT_ROOMOTE_COMMIT_AUTHOR,
  resolvePublicGitAuthor,
  type ResolvedTaskCommitAuthor,
} from '../commit-author';

describe('resolvePublicGitAuthor', () => {
  it('does not combine an unverified handle with the Roomote email', () => {
    const attribution: ResolvedTaskCommitAuthor = {
      kind: 'external',
      displayName: 'Private Name',
      publicDisplayName: '@octocat',
      githubLogin: 'octocat',
      prAssigneeLogin: null,
      gitAuthor: DEFAULT_ROOMOTE_COMMIT_AUTHOR.gitAuthor,
    };

    expect(resolvePublicGitAuthor(attribution)).toEqual(
      DEFAULT_ROOMOTE_COMMIT_AUTHOR.gitAuthor,
    );
  });

  it('uses the handle with a verified noreply identity', () => {
    const attribution: ResolvedTaskCommitAuthor = {
      kind: 'user',
      displayName: 'Private Name',
      publicDisplayName: '@octocat',
      githubLogin: 'octocat',
      prAssigneeLogin: 'octocat',
      gitAuthor: {
        name: 'Private Name',
        email: '123+octocat@users.noreply.github.com',
      },
    };

    expect(resolvePublicGitAuthor(attribution)).toEqual({
      name: '@octocat',
      email: '123+octocat@users.noreply.github.com',
    });
  });
});
