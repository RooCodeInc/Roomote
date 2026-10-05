import {
  db,
  environmentFactory,
  eq,
  repositories,
  repositoryFactory,
  runFactory,
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
    await db
      .update(repositories)
      .set({ host: null })
      .where(eq(repositories.id, linkedRepository.id));
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
        expect.objectContaining({
          value: `gitlab:${repository}#123|repositoryId:${linkedRepository.id}`,
        }),
      ]),
    );
    expect(options).toHaveLength(4);
    expect(
      options.filter(
        (option) => option.value === `gitlab:${repository}#123|host:gitlab.com`,
      ),
    ).toHaveLength(1);
  });

  it('returns PR options for an environment-backed repository selection', async () => {
    const owner = await userFactory.create();
    const environment = await environmentFactory.create({
      createdByUserId: owner.id,
      name: `Filter environment ${crypto.randomUUID()}`,
    });
    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      repositoryName: 'filter-environment/repository',
      state: 'completed',
    });
    await runFactory.create({
      taskId: task.id,
      payload: {
        repo: 'filter-environment/repository',
        description: 'Environment-backed task',
        environmentId: environment.id,
      },
    });
    await db.insert(taskPullRequests).values({
      taskId: task.id,
      repository: 'filter-environment/repository',
      prNumber: 321,
      prUrl: 'https://github.com/filter-environment/repository/pull/321',
      sourceControlProvider: 'github',
      host: 'github.com',
    });

    const options = await getPullRequestsForFilterCommand(
      {
        userId: owner.id,
        isAdmin: true,
      } as UserAuthSuccess,
      { repositoryName: `env:${environment.id}` },
    );

    expect(options).toEqual([
      expect.objectContaining({
        value: 'github:filter-environment/repository#321|host:github.com',
      }),
    ]);
  });
});
