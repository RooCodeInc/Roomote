import { randomUUID } from 'node:crypto';

import {
  db,
  eq,
  githubInstallationFactory,
  githubInstallations,
  repositories,
  repositoryFactory,
  userFactory,
  users,
} from '@roomote/db/server';

import { upsertGitHubRepository } from '../api';

const userIds: string[] = [];

function buildGitHubRepository(id: number, fullName: string) {
  const name = fullName.split('/').at(-1)!;

  return {
    id,
    name,
    full_name: fullName,
    description: null,
    private: true,
    default_branch: 'main',
    clone_url: `https://github.com/${fullName}.git`,
    html_url: `https://github.com/${fullName}`,
    permissions: {
      admin: true,
      maintain: true,
      push: true,
      triage: true,
      pull: true,
    },
  };
}

async function createSyncFixtures() {
  const suffix = randomUUID();
  const user = await userFactory.create({
    id: `github-sync-${suffix}`,
    email: `github-sync-${suffix}@example.com`,
  });
  const installation = await githubInstallationFactory.create({
    installedByUserId: user.id,
  });
  userIds.push(user.id);

  return { user, installation, suffix };
}

describe('upsertGitHubRepository', () => {
  afterEach(async () => {
    while (userIds.length > 0) {
      const userId = userIds.pop()!;
      await db
        .delete(repositories)
        .where(eq(repositories.linkedByUserId, userId));
      await db
        .delete(githubInstallations)
        .where(eq(githubInstallations.installedByUserId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  });

  it('is idempotent when concurrent installation syncs insert the same repository', async () => {
    const { user, installation, suffix } = await createSyncFixtures();
    const githubRepoId = Number.parseInt(
      suffix.replaceAll('-', '').slice(0, 12),
      16,
    );
    const gitHubRepo = buildGitHubRepository(
      githubRepoId,
      `acme/concurrent-${suffix}`,
    );

    const syncedRepositories = await Promise.all(
      Array.from({ length: 5 }, () =>
        upsertGitHubRepository({
          userId: user.id,
          githubInstallationId: installation.id,
          gitHubRepo,
        }),
      ),
    );

    expect(new Set(syncedRepositories.map(({ id }) => id)).size).toBe(1);
    await expect(
      db.query.repositories.findMany({
        where: eq(repositories.githubRepoId, gitHubRepo.id),
      }),
    ).resolves.toHaveLength(1);
  });

  it('reconciles a stale repository row that conflicts by full name', async () => {
    const {
      user,
      installation: oldInstallation,
      suffix,
    } = await createSyncFixtures();
    const newInstallation = await githubInstallationFactory.create({
      installedByUserId: user.id,
    });
    const fullName = `acme/reconnected-${suffix}`;
    const staleGitHubRepoId = Number.parseInt(
      suffix.replaceAll('-', '').slice(0, 12),
      16,
    );
    const staleRepository = await repositoryFactory.create({
      installationId: oldInstallation.id,
      linkedByUserId: user.id,
      githubRepoId: staleGitHubRepoId,
      externalRepoId: String(staleGitHubRepoId),
      fullName,
      isActive: false,
    });

    const syncedRepository = await upsertGitHubRepository({
      userId: user.id,
      githubInstallationId: newInstallation.id,
      gitHubRepo: buildGitHubRepository(staleGitHubRepoId + 1, fullName),
    });

    expect(syncedRepository).toMatchObject({
      id: staleRepository.id,
      installationId: newInstallation.id,
      githubRepoId: staleGitHubRepoId + 1,
      externalRepoId: String(staleGitHubRepoId + 1),
      isActive: true,
    });
  });

  it('refuses to merge distinct rows with conflicting GitHub identities', async () => {
    const { user, installation, suffix } = await createSyncFixtures();
    const githubRepoId = Number.parseInt(
      suffix.replaceAll('-', '').slice(0, 12),
      16,
    );
    const fullName = `acme/ambiguous-${suffix}`;
    const idMatchedRepository = await repositoryFactory.create({
      installationId: installation.id,
      linkedByUserId: user.id,
      githubRepoId,
      externalRepoId: String(githubRepoId),
      fullName: `acme/renamed-${suffix}`,
    });
    const nameMatchedRepository = await repositoryFactory.create({
      installationId: installation.id,
      linkedByUserId: user.id,
      githubRepoId: githubRepoId + 1,
      externalRepoId: String(githubRepoId + 1),
      fullName,
    });

    await expect(
      upsertGitHubRepository({
        userId: user.id,
        githubInstallationId: installation.id,
        gitHubRepo: buildGitHubRepository(githubRepoId, fullName),
      }),
    ).rejects.toThrow(
      `GitHub repository identity is ambiguous for ${fullName}: matched 2 persisted repositories`,
    );

    await expect(
      db.query.repositories.findMany({
        where: eq(repositories.linkedByUserId, user.id),
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: idMatchedRepository.id }),
        expect.objectContaining({ id: nameMatchedRepository.id }),
      ]),
    );
  });
});
