import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { Repository, CreateRepository } from '../../types';
import { repositories } from '../../schema';
import { type DatabaseOrTransaction, db } from '../../db';

const sourceControlHosts = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  gitea: 'gitea.com',
  bitbucket: 'bitbucket.org',
  ado: 'dev.azure.com',
} as const;

function buildSourceControlCloneUrl(
  sourceControlProvider: CreateRepository['sourceControlProvider'],
  host: string,
  fullName: string,
): string {
  if (sourceControlProvider === 'ado') {
    const [organization, project, ...repositoryParts] = fullName.split('/');
    const repository = repositoryParts.join('/');

    if (organization && project && repository) {
      return `https://${host}/${organization}/${project}/_git/${repository}`;
    }
  }

  return `https://${host}/${fullName}.git`;
}

export const repositoryFactory = Factory.define<
  CreateRepository,
  { db?: DatabaseOrTransaction },
  Repository
>(({ params, onCreate, transientParams }) => {
  onCreate(async (values) => {
    const [inserted] = await (transientParams.db || db)
      .insert(repositories)
      .values(values)
      .returning();

    if (!inserted) {
      throw new Error('Failed to insert repository');
    }

    return inserted;
  });

  const {
    installationId,
    linkedByUserId,
    fullName,
    name,
    sourceControlProvider = 'github',
    githubRepoId,
    externalRepoId,
    cloneUrl,
    htmlUrl,
    ...rest
  } = params;

  const repoName = name || faker.lorem.word();
  const fullRepoName = fullName || `${faker.internet.username()}/${repoName}`;
  const generatedGitHubRepoId = githubRepoId ?? faker.number.int();
  const sourceControlHost = sourceControlHosts[sourceControlProvider];

  return {
    sourceControlProvider,
    installationId:
      sourceControlProvider === 'github'
        ? installationId || faker.string.uuid()
        : (installationId ?? null),
    linkedByUserId: linkedByUserId || faker.string.uuid(),
    fullName: fullRepoName,
    name: repoName,
    githubRepoId:
      sourceControlProvider === 'github' ? generatedGitHubRepoId : null,
    externalRepoId:
      externalRepoId ??
      (sourceControlProvider === 'github'
        ? String(generatedGitHubRepoId)
        : faker.number.int().toString()),
    cloneUrl:
      cloneUrl ??
      buildSourceControlCloneUrl(
        sourceControlProvider,
        sourceControlHost,
        fullRepoName,
      ),
    htmlUrl: htmlUrl ?? `https://${sourceControlHost}/${fullRepoName}`,
    // Production sync paths always stamp a non-null host; mirror that here so
    // factory rows exercise the host-aware unique indexes like real rows.
    host: sourceControlHost,
    private: false,
    defaultBranch: 'main',
    permissions: {},
    isActive: true,
    ...rest,
  } satisfies CreateRepository;
});
