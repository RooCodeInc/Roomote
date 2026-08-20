import type { DatabaseOrTransaction } from '@roomote/db/server';

import {
  DEFAULT_ROOMOTE_COMMIT_AUTHOR,
  resolveRunCommitAuthor,
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

describe('resolveRunCommitAuthor', () => {
  it('uses the host-scoped provider identity as the PR assignee', async () => {
    const findUser = vi.fn().mockResolvedValue({
      id: 'user-1',
      name: 'Mona Lisa',
    });
    const findSourceControlMapping = vi.fn().mockResolvedValue({
      externalAccountId: '42',
      username: 'monalisa',
      displayName: 'Mona Lisa',
    });
    const tx = {
      query: {
        users: { findFirst: findUser },
        sourceControlUserMappings: { findFirst: findSourceControlMapping },
      },
    } as unknown as DatabaseOrTransaction;

    const result = await resolveRunCommitAuthor(
      tx,
      { taskId: 'task-1', actingUserId: 'user-1' },
      { provider: 'gitea', host: 'gitea.example.com' },
    );

    expect(result).toMatchObject({
      publicDisplayName: '@monalisa',
      githubLogin: null,
      prAssigneeLogin: 'monalisa',
    });
    expect(findSourceControlMapping).toHaveBeenCalledOnce();
  });
});
