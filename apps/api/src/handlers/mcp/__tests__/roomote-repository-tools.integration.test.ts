import { randomInt, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  db,
  environmentFactory,
  environments,
  eq,
  githubInstallationFactory,
  githubInstallations,
  githubUserMappings,
  repositoryFactory,
  repositories,
  userFactory,
  users,
} from '@roomote/db/server';

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  get: vi.fn(),
  permission: vi.fn(),
  update: vi.fn(),
  startTask: vi.fn(),
}));

vi.mock('@roomote/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/auth')>()),
  createGitHubToken: mocks.token,
}));
vi.mock('@roomote/github', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/github')>()),
  getOctokit: () => ({
    repos: {
      get: mocks.get,
      getCollaboratorPermissionLevel: mocks.permission,
    },
    pulls: { update: mocks.update },
  }),
}));
vi.mock('@roomote/cloud-agents/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/cloud-agents/server')>()),
  startTask: mocks.startTask,
}));

import { registerRoomoteMemberTools } from '../roomote-member-tools';

describe('member repository tools with real database authorization', () => {
  let client: Client;
  let server: McpServer;
  let actor: Awaited<ReturnType<typeof userFactory.create>>;
  let owner: Awaited<ReturnType<typeof userFactory.create>>;
  let installation: Awaited<
    ReturnType<typeof githubInstallationFactory.create>
  >;
  let repository: Awaited<ReturnType<typeof repositoryFactory.create>>;
  let environment: Awaited<ReturnType<typeof environmentFactory.create>>;
  let githubUserId: number;
  const cleanup: (() => Promise<unknown>)[] = [];

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    actor = await userFactory.create();
    cleanup.push(() => db.delete(users).where(eq(users.id, actor.id)));
    owner = await userFactory.create();
    cleanup.push(() => db.delete(users).where(eq(users.id, owner.id)));
    installation = await githubInstallationFactory.create({
      installedByUserId: owner.id,
    });
    cleanup.push(() =>
      db
        .delete(githubInstallations)
        .where(eq(githubInstallations.id, installation.id)),
    );
    repository = await repositoryFactory.create({
      linkedByUserId: owner.id,
      installationId: installation.id,
      fullName: `integration/repository-${randomUUID()}`,
      githubRepoId: randomInt(1, 2 ** 48 - 1),
    });
    cleanup.push(() =>
      db.delete(repositories).where(eq(repositories.id, repository.id)),
    );
    environment = await environmentFactory.create({
      userId: owner.id,
      createdByUserId: owner.id,
      config: {
        name: 'Shared repository tools test',
        repositories: [{ repository: repository.fullName.toUpperCase() }],
      },
    });
    cleanup.push(() =>
      db.delete(environments).where(eq(environments.id, environment.id)),
    );
    githubUserId = randomInt(1, 2 ** 48 - 1);
    await db.insert(githubUserMappings).values({
      userId: actor.id,
      githubLogin: `actor-${actor.id}`,
      githubUserId,
    });
    mocks.token.mockResolvedValue('test-installation-token');
    mocks.get.mockResolvedValue({
      data: { id: repository.githubRepoId, full_name: repository.fullName },
    });
    mocks.permission.mockResolvedValue({
      data: { permission: 'write', user: { id: githubUserId } },
    });
    mocks.update.mockResolvedValue({ data: { number: 42 } });
    server = new McpServer({
      name: 'member-repository-integration',
      version: '1',
    });
    client = new Client({ name: 'integration-client', version: '1' });
    registerRoomoteMemberTools(server, {
      userId: actor.id,
      authContext: { userId: actor.id, tokenType: 'auth', version: 1 },
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    try {
      await client?.close();
      await server?.close();
      while (cleanup.length) await cleanup.pop()!();
      expect(mocks.startTask).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  function call(name = 'read_repository') {
    return client.callTool({
      name,
      arguments: {
        repositoryFullName: repository.fullName,
        environmentId: environment.id,
        ...(name === 'read_repository'
          ? { action: 'get_repository' }
          : {
              prNumber: 42,
              userIntent:
                name === 'rename_pull_request'
                  ? 'Rename PR 42 to Updated title.'
                  : 'Close PR 42.',
              ...(name === 'rename_pull_request'
                ? { title: 'Updated title' }
                : {}),
            }),
      },
    });
  }

  it("exposes repository tools through member registration and reads another member's shared environment", async () => {
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'manage_tasks',
        'read_repository',
        'rename_pull_request',
        'close_pull_request',
      ]),
    );
    mocks.permission.mockResolvedValue({
      data: { permission: 'read', user: { id: githubUserId } },
    });
    const result = await call();
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining(repository.fullName) },
    ]);
    expect(mocks.token).toHaveBeenCalledExactlyOnceWith({
      type: 'installationId',
      installationId: installation.id,
      repositoryIds: [repository.githubRepoId],
    });
    expect(mocks.permission).toHaveBeenCalledExactlyOnceWith({
      owner: 'integration',
      repo: repository.fullName.split('/')[1],
      username: `actor-${actor.id}`,
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each(['rename_pull_request', 'close_pull_request'])(
    'allows authorized %s without task startup',
    async (name) => {
      expect((await call(name)).isError).not.toBe(true);
      expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
        owner: 'integration',
        repo: repository.fullName.split('/')[1],
        pull_number: 42,
        ...(name === 'rename_pull_request'
          ? { title: 'Updated title' }
          : { state: 'closed' }),
      });
    },
  );

  it.each([
    ['inactive repository', 'An active GitHub repository'],
    ['non-GitHub repository', 'An active GitHub repository'],
    ['suspended installation', 'unavailable or suspended'],
    ['deleted actor', 'member no longer exists'],
    ['environment excludes repository', 'does not include this repository'],
    ['eval environment', 'environment is unavailable'],
    ['missing environment', 'environment is unavailable'],
    ['unlinked actor', 'must link a GitHub account'],
  ])(
    'rechecks %s from the database after registration',
    async (scenario, message) => {
      // A successful call first proves the same persisted scope was initially valid.
      expect((await call()).isError).not.toBe(true);
      switch (scenario) {
        case 'inactive repository':
          await db
            .update(repositories)
            .set({ isActive: false })
            .where(eq(repositories.id, repository.id));
          break;
        case 'non-GitHub repository':
          await db
            .update(repositories)
            .set({ sourceControlProvider: 'gitlab' })
            .where(eq(repositories.id, repository.id));
          break;
        case 'suspended installation':
          await db
            .update(githubInstallations)
            .set({ suspendedAt: new Date() })
            .where(eq(githubInstallations.id, installation.id));
          break;
        case 'deleted actor':
          await db
            .update(users)
            .set({ deletedAt: new Date() })
            .where(eq(users.id, actor.id));
          break;
        case 'environment excludes repository':
          await db
            .update(environments)
            .set({
              config: {
                name: 'Other scope',
                repositories: [{ repository: 'integration/other' }],
              },
            })
            .where(eq(environments.id, environment.id));
          break;
        case 'eval environment':
          await db
            .update(environments)
            .set({ isEval: true })
            .where(eq(environments.id, environment.id));
          break;
        case 'missing environment':
          await db
            .delete(environments)
            .where(eq(environments.id, environment.id));
          break;
        case 'unlinked actor':
          await db
            .delete(githubUserMappings)
            .where(eq(githubUserMappings.userId, actor.id));
          break;
      }
      for (const mock of [
        mocks.token,
        mocks.get,
        mocks.permission,
        mocks.update,
      ]) {
        mock.mockClear();
      }
      for (const name of [
        'read_repository',
        'rename_pull_request',
        'close_pull_request',
      ]) {
        const result = await call(name);
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
          { type: 'text', text: expect.stringContaining(message) },
        ]);
      }
      expect(mocks.token).not.toHaveBeenCalled();
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.permission).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );
});
