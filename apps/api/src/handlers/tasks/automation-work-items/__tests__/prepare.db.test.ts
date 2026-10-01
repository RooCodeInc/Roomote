import { randomUUID } from 'node:crypto';

import {
  db,
  environmentFactory,
  environmentRepositoryMappings,
  environments,
  inArray,
  repositories,
  repositoryFactory,
  userFactory,
  users,
} from '@roomote/db/server';

import {
  AutomationWorkItemValidationError,
  resolvePreparedAutomationWorkItems,
} from '../prepare';

describe('resolvePreparedAutomationWorkItems', () => {
  const userIds: string[] = [];
  const repositoryIds: string[] = [];
  const environmentIds: string[] = [];

  afterEach(async () => {
    if (environmentIds.length > 0) {
      await db
        .delete(environmentRepositoryMappings)
        .where(
          inArray(environmentRepositoryMappings.environmentId, environmentIds),
        );
      await db
        .delete(environments)
        .where(inArray(environments.id, environmentIds));
      environmentIds.length = 0;
    }
    if (repositoryIds.length > 0) {
      await db
        .delete(repositories)
        .where(inArray(repositories.id, repositoryIds));
      repositoryIds.length = 0;
    }
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
      userIds.length = 0;
    }
  });

  async function createRepositoryAndEnvironment(params: {
    fullName: string;
    provider: 'gitlab' | 'gitea';
    configRepositories: string[];
  }) {
    const marker = randomUUID();
    const user = await userFactory.create({
      email: `${marker}@example.com`,
      name: `User ${marker}`,
    });
    userIds.push(user.id);

    const repository = await repositoryFactory.create({
      sourceControlProvider: params.provider,
      fullName: params.fullName,
      linkedByUserId: user.id,
    });
    repositoryIds.push(repository.id);

    const environment = await environmentFactory.create({
      createdByUserId: user.id,
      config: {
        name: `Environment ${marker}`,
        repositories: params.configRepositories.map((repositoryName) => ({
          repository: repositoryName,
        })),
      },
    });
    environmentIds.push(environment.id);
    await db.insert(environmentRepositoryMappings).values({
      environmentId: environment.id,
      repositoryId: repository.id,
    });

    return { environment, repository };
  }

  function actWorkItem(params: {
    targetEnvironmentId: string;
    targetRepositoryFullName: string;
  }) {
    return {
      title: 'Fix the audited failure',
      brief: 'The scheduled audit found a bounded repository failure.',
      actionKind: 'code_change_pr',
      disposition: 'act' as const,
      executionPrompt:
        'Reproduce the failure, fix it, and open a pull request.',
      targetEnvironmentId: params.targetEnvironmentId,
      targetRepositoryFullName: params.targetRepositoryFullName,
    };
  }

  it('accepts a canonical repository mapping when environment config is stale', async () => {
    const fullName = `acme/${randomUUID()}`;
    const { environment, repository } = await createRepositoryAndEnvironment({
      fullName,
      provider: 'gitlab',
      configRepositories: [],
    });

    await expect(
      resolvePreparedAutomationWorkItems({
        workItems: [
          actWorkItem({
            targetEnvironmentId: environment.id,
            targetRepositoryFullName: fullName,
          }),
        ],
        candidateRepositories: [
          { id: repository.id, fullName: repository.fullName },
        ],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        targetEnvironmentId: environment.id,
        targetRepositoryFullName: fullName,
        workspaceReadiness: 'environment_backed',
      }),
    ]);
  });

  it('rejects a same-name repository mapped to another provider environment', async () => {
    const fullName = `acme/${randomUUID()}`;
    const gitlab = await createRepositoryAndEnvironment({
      fullName,
      provider: 'gitlab',
      configRepositories: [fullName],
    });
    const gitea = await createRepositoryAndEnvironment({
      fullName,
      provider: 'gitea',
      configRepositories: [fullName],
    });

    await expect(
      resolvePreparedAutomationWorkItems({
        workItems: [
          actWorkItem({
            targetEnvironmentId: gitlab.environment.id,
            targetRepositoryFullName: fullName,
          }),
        ],
        candidateRepositories: [
          { id: gitea.repository.id, fullName: gitea.repository.fullName },
        ],
      }),
    ).rejects.toThrow(AutomationWorkItemValidationError);
  });
});
