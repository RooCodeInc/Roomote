import { db, taskFactory, taskPullRequests } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import { getPullRequestsForFilterCommand } from './index';

describe('getPullRequestsForFilterCommand', () => {
  it('returns distinct provider- and host-qualified values for matching PR coordinates', async () => {
    const repository = `filter-provider/${crypto.randomUUID()}`;
    const [githubTask, gitlabTask, selfManagedGitlabTask] = await Promise.all([
      taskFactory.create({ repositoryName: repository }),
      taskFactory.create({ repositoryName: repository }),
      taskFactory.create({ repositoryName: repository }),
    ]);
    await db.insert(taskPullRequests).values([
      {
        taskId: githubTask.id,
        sourceControlProvider: 'github',
        repository,
        prNumber: 123,
        prUrl: `https://github.com/${repository}/pull/123`,
        host: 'github.com',
      },
      {
        taskId: gitlabTask.id,
        sourceControlProvider: 'gitlab',
        repository,
        prNumber: 123,
        prUrl: `https://gitlab.com/${repository}/-/merge_requests/123`,
        host: 'gitlab.com',
      },
      {
        taskId: selfManagedGitlabTask.id,
        sourceControlProvider: 'gitlab',
        repository,
        prNumber: 123,
        prUrl: `https://gitlab.internal/${repository}/-/merge_requests/123`,
        host: 'gitlab.internal',
      },
    ]);

    const options = await getPullRequestsForFilterCommand(
      {
        userId: crypto.randomUUID(),
        isAdmin: true,
      } as UserAuthSuccess,
      { repositoryName: repository },
    );

    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: `github:${repository}#123|host:github.com`,
        }),
        expect.objectContaining({
          value: `gitlab:${repository}#123|host:gitlab.com`,
        }),
        expect.objectContaining({
          value: `gitlab:${repository}#123|host:gitlab.internal`,
          subLabel: expect.stringContaining('GitLab (gitlab.internal)'),
        }),
      ]),
    );
    expect(options).toHaveLength(3);
  });
});
