import { randomUUID } from 'node:crypto';

import {
  db,
  environmentFactory,
  environmentRepositoryMappings,
  environments,
  eq,
  githubInstallationFactory,
  githubInstallations,
  inArray,
  repositories,
  repositoryFactory,
  runFactory,
  taskRuns,
  userFactory,
  users,
} from '@roomote/db/server';
import type { AuthTokenContext, RunTokenContext } from '@roomote/types';
import { ALL_REPOSITORIES } from '@roomote/types';

import { updateRepositoryDefaultBranch } from '../update-default-branch';

const userAuth = { userId: 'user-auth' } as unknown as AuthTokenContext;

function runAuth(runId: number): RunTokenContext {
  return {
    runId,
    userId: null,
    principal: 'deployment',
    tokenType: 'run',
    version: 1,
  };
}

const userIds: string[] = [];
const installationIds: string[] = [];
const repositoryIds: string[] = [];
const environmentIds: string[] = [];
const runIds: number[] = [];

async function createUser() {
  const user = await userFactory.create({
    id: `user-${randomUUID()}`,
    email: `${randomUUID()}@example.com`,
  });
  userIds.push(user.id);
  return user;
}

async function createRepository(params: {
  linkedByUserId: string;
  fullName: string;
  defaultBranch: string;
  isActive?: boolean;
}) {
  const installation = await githubInstallationFactory.create({
    installedByUserId: params.linkedByUserId,
  });
  installationIds.push(installation.id);

  const repository = await repositoryFactory.create({
    sourceControlProvider: 'github',
    linkedByUserId: params.linkedByUserId,
    fullName: params.fullName,
    defaultBranch: params.defaultBranch,
    isActive: params.isActive ?? true,
    installationId: installation.id,
  });
  repositoryIds.push(repository.id);
  return repository;
}

async function createRun(payload: Record<string, unknown>, status = 'running') {
  const run = await runFactory.create({
    payload: payload as never,
    status: status as never,
  });
  runIds.push(run.id);
  return run;
}

async function defaultBranchOf(id: string) {
  const row = await db.query.repositories.findFirst({
    where: eq(repositories.id, id),
  });
  return row?.defaultBranch;
}

describe('updateRepositoryDefaultBranch', () => {
  afterAll(async () => {
    if (runIds.length > 0) {
      await db.delete(taskRuns).where(inArray(taskRuns.id, runIds));
    }

    if (environmentIds.length > 0) {
      await db
        .delete(environments)
        .where(inArray(environments.id, environmentIds));
    }

    if (repositoryIds.length > 0) {
      await db
        .delete(repositories)
        .where(inArray(repositories.id, repositoryIds));
    }

    if (installationIds.length > 0) {
      await db
        .delete(githubInstallations)
        .where(inArray(githubInstallations.id, installationIds));
    }

    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  it('updates a stale stored default branch for an auth token', async () => {
    const user = await createUser();
    const repository = await createRepository({
      linkedByUserId: user.id,
      fullName: `acme/backend-${randomUUID()}`,
      defaultBranch: 'main',
    });

    const result = await updateRepositoryDefaultBranch(userAuth, {
      repositoryId: repository.id,
      defaultBranch: 'develop',
    });

    expect(result.updatedCount).toBe(1);
    expect(await defaultBranchOf(repository.id)).toBe('develop');
  });

  it('allows a run token whose workspace selected the repository', async () => {
    const user = await createUser();
    const repository = await createRepository({
      linkedByUserId: user.id,
      fullName: `acme/backend-${randomUUID()}`,
      defaultBranch: 'main',
    });
    const run = await createRun({ repo: repository.fullName });

    const result = await updateRepositoryDefaultBranch(runAuth(run.id), {
      repositoryId: repository.id,
      defaultBranch: 'develop',
    });

    expect(result.updatedCount).toBe(1);
    expect(await defaultBranchOf(repository.id)).toBe('develop');
  });

  it('allows a run token for an all-repositories workspace', async () => {
    const user = await createUser();
    const repository = await createRepository({
      linkedByUserId: user.id,
      fullName: `acme/backend-${randomUUID()}`,
      defaultBranch: 'main',
    });
    const run = await createRun({ repo: ALL_REPOSITORIES });

    const result = await updateRepositoryDefaultBranch(runAuth(run.id), {
      repositoryId: repository.id,
      defaultBranch: 'develop',
    });

    expect(result.updatedCount).toBe(1);
  });

  it('allows a run token whose environment maps the repository', async () => {
    const user = await createUser();
    const repository = await createRepository({
      linkedByUserId: user.id,
      fullName: `acme/backend-${randomUUID()}`,
      defaultBranch: 'main',
    });
    const environment = await environmentFactory.create({
      createdByUserId: user.id,
    });
    environmentIds.push(environment.id);
    await db.insert(environmentRepositoryMappings).values({
      environmentId: environment.id,
      repositoryId: repository.id,
    });
    const run = await createRun({ environmentId: environment.id });

    const result = await updateRepositoryDefaultBranch(runAuth(run.id), {
      repositoryId: repository.id,
      defaultBranch: 'develop',
    });

    expect(result.updatedCount).toBe(1);
  });

  it('rejects a run token stamped for a different provider', async () => {
    const user = await createUser();
    const repository = await createRepository({
      linkedByUserId: user.id,
      fullName: `acme/backend-${randomUUID()}`,
      defaultBranch: 'main',
    });
    const run = await createRun({
      repo: repository.fullName,
      sourceControlProvider: 'gitlab',
    });

    await expect(
      updateRepositoryDefaultBranch(runAuth(run.id), {
        repositoryId: repository.id,
        defaultBranch: 'develop',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await defaultBranchOf(repository.id)).toBe('main');
  });

  it('rejects a run token stamped for a different self-managed host', async () => {
    const user = await createUser();
    const fullName = `team/repo-${randomUUID()}`;
    const repository = await repositoryFactory.create({
      sourceControlProvider: 'gitlab',
      linkedByUserId: user.id,
      fullName,
      defaultBranch: 'main',
      host: 'gitlab.host-b.example',
      externalRepoId: randomUUID(),
    });
    repositoryIds.push(repository.id);
    const run = await createRun({
      repo: fullName,
      sourceControlProvider: 'gitlab',
      sourceControlHost: 'gitlab.host-a.example',
    });

    await expect(
      updateRepositoryDefaultBranch(runAuth(run.id), {
        repositoryId: repository.id,
        defaultBranch: 'develop',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await defaultBranchOf(repository.id)).toBe('main');
  });

  it('rejects a host-stamped run against a legacy null-host row', async () => {
    const user = await createUser();
    const fullName = `team/repo-${randomUUID()}`;
    const repository = await repositoryFactory.create({
      sourceControlProvider: 'gitlab',
      linkedByUserId: user.id,
      fullName,
      defaultBranch: 'main',
      host: null,
      externalRepoId: randomUUID(),
    });
    repositoryIds.push(repository.id);
    const run = await createRun({
      repo: fullName,
      sourceControlProvider: 'gitlab',
      sourceControlHost: 'gitlab.host-a.example',
    });

    await expect(
      updateRepositoryDefaultBranch(runAuth(run.id), {
        repositoryId: repository.id,
        defaultBranch: 'develop',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await defaultBranchOf(repository.id)).toBe('main');
  });

  it('rejects an all-repositories run stamped for a different provider', async () => {
    const user = await createUser();
    const repository = await createRepository({
      linkedByUserId: user.id,
      fullName: `acme/backend-${randomUUID()}`,
      defaultBranch: 'main',
    });
    const run = await createRun({
      repo: ALL_REPOSITORIES,
      sourceControlProvider: 'gitlab',
    });

    await expect(
      updateRepositoryDefaultBranch(runAuth(run.id), {
        repositoryId: repository.id,
        defaultBranch: 'develop',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a run token whose workspace references a different repository', async () => {
    const user = await createUser();
    const repository = await createRepository({
      linkedByUserId: user.id,
      fullName: `acme/backend-${randomUUID()}`,
      defaultBranch: 'main',
    });
    const run = await createRun({ repo: 'acme/other-repo' });

    await expect(
      updateRepositoryDefaultBranch(runAuth(run.id), {
        repositoryId: repository.id,
        defaultBranch: 'develop',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await defaultBranchOf(repository.id)).toBe('main');
  });

  it('rejects a run token for a terminal run', async () => {
    const user = await createUser();
    const repository = await createRepository({
      linkedByUserId: user.id,
      fullName: `acme/backend-${randomUUID()}`,
      defaultBranch: 'main',
    });
    const run = await createRun({ repo: repository.fullName }, 'completed');

    await expect(
      updateRepositoryDefaultBranch(runAuth(run.id), {
        repositoryId: repository.id,
        defaultBranch: 'develop',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('is a no-op when the stored default branch already matches', async () => {
    const user = await createUser();
    const repository = await createRepository({
      linkedByUserId: user.id,
      fullName: `acme/backend-${randomUUID()}`,
      defaultBranch: 'develop',
    });

    const result = await updateRepositoryDefaultBranch(userAuth, {
      repositoryId: repository.id,
      defaultBranch: 'develop',
    });

    expect(result.updatedCount).toBe(0);
  });

  it('ignores unknown and inactive repositories', async () => {
    const user = await createUser();
    const inactiveRepository = await createRepository({
      linkedByUserId: user.id,
      fullName: `acme/backend-${randomUUID()}`,
      defaultBranch: 'main',
      isActive: false,
    });

    const unknownResult = await updateRepositoryDefaultBranch(userAuth, {
      repositoryId: randomUUID(),
      defaultBranch: 'develop',
    });
    const inactiveResult = await updateRepositoryDefaultBranch(userAuth, {
      repositoryId: inactiveRepository.id,
      defaultBranch: 'develop',
    });

    expect(unknownResult.updatedCount).toBe(0);
    expect(inactiveResult.updatedCount).toBe(0);
    expect(await defaultBranchOf(inactiveRepository.id)).toBe('main');
  });
});
