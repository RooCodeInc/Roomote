import {
  db,
  repositoryFactory,
  taskFactory,
  taskPullRequests,
  userFactory,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import { getPullRequestsForFilterCommand } from './index';

describe('getPullRequestsForFilterCommand', () => {
  it('returns distinct provider- and host-qualified values for matching PR coordinates', async () => {
    const repository = `filter-provider/${crypto.randomUUID()}`;
    const linkedBy = await userFactory.create();
    const linkedRepository = await repositoryFactory.create({
      sourceControlProvider: 'gitlab',
      fullName: repository,
      linkedByUserId: linkedBy.id,
    });
    const [
      githubTask,
      gitlabTask,
      linkedGitlabTask,
      unstampedGitlabTask,
      selfManagedGitlabTask,
    ] = await Promise.all([
      taskFactory.create({ repositoryName: repository }),
      taskFactory.create({ repositoryName: repository }),
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
        taskId: linkedGitlabTask.id,
        sourceControlProvider: 'gitlab',
        repository,
        repositoryId: linkedRepository.id,
        prNumber: 123,
        prUrl: `https://gitlab.com/${repository}/-/merge_requests/123?linked=1`,
      },
      {
        taskId: unstampedGitlabTask.id,
        sourceControlProvider: 'gitlab',
        repository,
        prNumber: 123,
        prUrl: `https://gitlab.com/${repository}/-/merge_requests/123?legacy=1`,
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
    expect(
      options.filter(
        (option) => option.value === `gitlab:${repository}#123|host:gitlab.com`,
      ),
    ).toHaveLength(1);
  });
});
