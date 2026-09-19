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
  userFactory,
  users,
} from '@roomote/db/server';

import { listActiveRepositories } from '../available-environments';

const userIds: string[] = [];
const installationIds: string[] = [];
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
  if (installationIds.length > 0) {
    await db
      .delete(githubInstallations)
      .where(inArray(githubInstallations.id, installationIds));
    installationIds.length = 0;
  }
  while (userIds.length > 0) {
    await db.delete(users).where(eq(users.id, userIds.pop()!));
  }
});

// The test database is shared, so every query is scoped by a unique marker.
async function createFixtures() {
  const marker = `lr${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const user = await userFactory.create({
    id: `user-${marker}`,
    email: `${marker}@example.com`,
    name: `User ${marker}`,
  });
  userIds.push(user.id);
  const installation = await githubInstallationFactory.create({
    installedByUserId: user.id,
  });
  installationIds.push(installation.id);

  const create = async (
    overrides: Parameters<typeof repositoryFactory.create>[0],
  ) => {
    const repository = await repositoryFactory.create({
      installationId: installation.id,
      linkedByUserId: user.id,
      ...overrides,
    });
    repositoryIds.push(repository.id);
    return repository;
  };

  return { marker, user, create };
}

describe('listActiveRepositories', () => {
  it('returns only active matches, ordered by name, with mapped shared environments', async () => {
    const { marker, user, create } = await createFixtures();
    const widgets = await create({
      fullName: `octo/${marker}-widgets`,
      description: '  Widget   service\nfor billing  ',
      defaultBranch: 'trunk',
      private: true,
    });
    const api = await create({ fullName: `acme/${marker}-api` });
    await create({ fullName: `acme/${marker}-retired`, isActive: false });

    const shared = await environmentFactory.create({
      name: `${marker} shared`,
      createdByUserId: user.id,
    });
    const personal = await environmentFactory.create({
      name: `${marker} personal`,
      createdByUserId: user.id,
      userId: user.id,
    });
    const evaluation = await environmentFactory.create({
      name: `${marker} eval`,
      createdByUserId: user.id,
      isEval: true,
    });
    environmentIds.push(shared.id, personal.id, evaluation.id);
    await db.insert(environmentRepositoryMappings).values(
      [shared, personal, evaluation].map((environment) => ({
        environmentId: environment.id,
        repositoryId: widgets.id,
      })),
    );

    const page = await listActiveRepositories({ query: marker });

    expect(page.totalCount).toBe(2);
    expect(page.nextOffset).toBeUndefined();
    expect(page.repositories).toEqual([
      {
        id: api.id,
        fullName: `acme/${marker}-api`,
        sourceControlProvider: api.sourceControlProvider,
        host: api.host,
        defaultBranch: api.defaultBranch,
        private: api.private,
        url: api.htmlUrl,
        ...(api.description ? { description: expect.any(String) } : {}),
        environments: [],
      },
      {
        id: widgets.id,
        fullName: `octo/${marker}-widgets`,
        sourceControlProvider: widgets.sourceControlProvider,
        host: widgets.host,
        defaultBranch: 'trunk',
        private: true,
        url: widgets.htmlUrl,
        description: 'Widget service for billing',
        environments: [{ id: shared.id, name: `${marker} shared` }],
      },
    ]);
  });

  it('requires every term, matches descriptions, ignores case, and treats wildcards literally', async () => {
    const { marker, create } = await createFixtures();
    await create({
      fullName: `octo/${marker}-Widgets`,
      description: 'Handles invoices',
    });
    await create({ fullName: `octo/${marker}-gadgets`, description: null });

    const names = async (query: string) =>
      (await listActiveRepositories({ query })).repositories.map(
        (repository) => repository.fullName,
      );

    expect(await names(`${marker} WIDGETS`)).toEqual([
      `octo/${marker}-Widgets`,
    ]);
    expect(await names(`${marker} invoices`)).toEqual([
      `octo/${marker}-Widgets`,
    ]);
    expect(await names(`${marker} widgets gadgets`)).toEqual([]);
    expect(await names(`${marker}_widgets`)).toEqual([]);
    expect(await names(`${marker}%`)).toEqual([]);
  });

  it('keeps same-name repositories on different providers as separate entries', async () => {
    const { marker, create } = await createFixtures();
    await create({ fullName: `acme/${marker}-app` });
    await create({
      fullName: `acme/${marker}-app`,
      sourceControlProvider: 'gitlab',
      host: 'gitlab.example.com',
      installationId: null,
      githubRepoId: null,
      externalRepoId: `${marker}-gitlab`,
    });

    const page = await listActiveRepositories({ query: `${marker}-app` });

    expect(page.totalCount).toBe(2);
    expect(
      page.repositories.map((repository) => repository.sourceControlProvider),
    ).toEqual(['github', 'gitlab']);
  });

  it('pages with nextOffset and clamps the page size', async () => {
    const { marker, create } = await createFixtures();
    for (const suffix of ['a', 'b', 'c']) {
      await create({ fullName: `acme/${marker}-${suffix}` });
    }

    const first = await listActiveRepositories({ query: marker, limit: 2 });
    expect(first.repositories.map((r) => r.fullName)).toEqual([
      `acme/${marker}-a`,
      `acme/${marker}-b`,
    ]);
    expect(first).toMatchObject({ totalCount: 3, nextOffset: 2 });

    const second = await listActiveRepositories({
      query: marker,
      limit: 2,
      offset: first.nextOffset,
    });
    expect(second.repositories.map((r) => r.fullName)).toEqual([
      `acme/${marker}-c`,
    ]);
    expect(second.nextOffset).toBeUndefined();

    const pastEnd = await listActiveRepositories({ query: marker, offset: 10 });
    expect(pastEnd).toEqual({ repositories: [], totalCount: 3 });

    const clamped = await listActiveRepositories({ query: marker, limit: 0 });
    expect(clamped.repositories).toHaveLength(1);
  });
});
