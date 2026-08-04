import { randomUUID } from 'node:crypto';

import {
  db,
  eq,
  githubInstallationFactory,
  githubInstallations,
  inArray,
  repositories,
  repositoryFactory,
  userFactory,
  users,
} from '../../server';

import { resolveRepositorySelectionByIds } from '../repositories';

const userIds: string[] = [];
const installationIds: string[] = [];
const repositoryIds: string[] = [];

async function cleanup() {
  if (repositoryIds.length > 0) {
    await db
      .delete(repositories)
      .where(inArray(repositories.id, repositoryIds));
    repositoryIds.length = 0;
  }

  if (installationIds.length > 0) {
    await db
      .delete(githubInstallations)
      .where(inArray(githubInstallations.id, installationIds));
    installationIds.length = 0;
  }

  while (userIds.length > 0) {
    const userId = userIds.pop()!;
    await db.delete(users).where(eq(users.id, userId));
  }
}

async function createRepositoryFixtures(prefix: string) {
  const user = await userFactory.create({
    id: `user-${prefix}`,
    email: `${prefix}@example.com`,
    name: `User ${prefix}`,
  });
  const installation = await githubInstallationFactory.create({
    installedByUserId: user.id,
  });
  const repoA = await repositoryFactory.create({
    installationId: installation.id,
    linkedByUserId: user.id,
    fullName: `acme/${prefix}-api`,
  });
  const repoB = await repositoryFactory.create({
    installationId: installation.id,
    linkedByUserId: user.id,
    fullName: `acme/${prefix}-web`,
  });

  userIds.push(user.id);
  installationIds.push(installation.id);
  repositoryIds.push(repoA.id, repoB.id);

  return { repoA, repoB };
}

describe('resolveRepositorySelectionByIds', () => {
  afterEach(async () => {
    await cleanup();
  });

  it('builds a single-repository workspace payload', async () => {
    const prefix = randomUUID();
    const { repoA } = await createRepositoryFixtures(prefix);

    const result = await resolveRepositorySelectionByIds({
      repositoryIds: [repoA.id],
    });

    expect(result.normalizedRepositoryIds).toEqual([repoA.id]);
    expect(result.selectedRepositories).toEqual([
      { id: repoA.id, fullName: repoA.fullName },
    ]);
    expect(result.workspacePayload).toEqual({ repo: repoA.fullName });
  });

  it('builds an all-repositories workspace payload from multiple repositories', async () => {
    const prefix = randomUUID();
    const { repoA, repoB } = await createRepositoryFixtures(prefix);

    const result = await resolveRepositorySelectionByIds({
      repositoryIds: [repoB.id, repoA.id],
    });

    expect(result.normalizedRepositoryIds).toEqual([repoB.id, repoA.id]);
    expect(result.selectedRepositories).toEqual([
      { id: repoB.id, fullName: repoB.fullName },
      { id: repoA.id, fullName: repoA.fullName },
    ]);
    expect(result.workspacePayload).toEqual({
      repo: '__all_repositories__',
      selectedRepositories: [repoB.fullName, repoA.fullName],
    });
  });

  it('deduplicates repeated repository ids in normalized output and workspace payloads', async () => {
    const prefix = randomUUID();
    const { repoA } = await createRepositoryFixtures(prefix);

    const result = await resolveRepositorySelectionByIds({
      repositoryIds: [repoA.id, repoA.id],
    });

    expect(result.normalizedRepositoryIds).toEqual([repoA.id]);
    expect(result.selectedRepositories).toEqual([
      { id: repoA.id, fullName: repoA.fullName },
    ]);
    expect(result.workspacePayload).toEqual({ repo: repoA.fullName });
  });

  it('preserves missing repository ids as a shorter resolved selection so callers can reject them', async () => {
    const prefix = randomUUID();
    const { repoA } = await createRepositoryFixtures(prefix);

    const result = await resolveRepositorySelectionByIds({
      repositoryIds: [repoA.id, randomUUID()],
    });

    expect(result.normalizedRepositoryIds).toEqual([repoA.id]);
    expect(result.selectedRepositories).toEqual([
      { id: repoA.id, fullName: repoA.fullName },
    ]);
    expect(result.workspacePayload).toEqual({ repo: repoA.fullName });
  });
});
