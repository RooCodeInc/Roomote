import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  db,
  inArray,
  repositories,
  repositoryFactory,
  userFactory,
  users,
} from '@roomote/db/server';

import type { Variables } from '../../../types';

const mocks = vi.hoisted(() => ({
  adoHost: vi.fn(),
  adoToken: vi.fn(),
  adoGet: vi.fn(),
  adoMerge: vi.fn(),
  giteaHost: vi.fn(),
  giteaToken: vi.fn(),
  giteaBaseUrl: vi.fn(),
  giteaGet: vi.fn(),
  giteaMerge: vi.fn(),
}));

vi.mock('@roomote/ado', async (original) => ({
  ...(await original<object>()),
  resolveAdoInstanceHost: mocks.adoHost,
  resolveAdoToken: mocks.adoToken,
  getAdoPullRequest: mocks.adoGet,
  mergeAdoPullRequest: mocks.adoMerge,
}));
vi.mock('@roomote/gitea', async (original) => ({
  ...(await original<object>()),
  resolveGiteaInstanceHost: mocks.giteaHost,
  resolveGiteaToken: mocks.giteaToken,
  resolveGiteaBaseUrl: mocks.giteaBaseUrl,
  getGiteaPullRequest: mocks.giteaGet,
  mergeGiteaPullRequest: mocks.giteaMerge,
}));

import { adoMergeMcp, giteaMergeMcp } from '../native-provider-merge';

const headSha = 'a'.repeat(40);
let userId: string;
let giteaRepositoryId: string;
let adoRepositoryId: string;
const userIds: string[] = [];
const repositoryIds: string[] = [];

function app(provider: 'ado' | 'gitea', auth?: Variables['authContext']) {
  const target = new Hono<{ Variables: Variables }>();
  target.use('*', async (c, next) => {
    if (auth) c.set('authContext', auth);
    await next();
  });
  target.route(
    `/${provider}`,
    provider === 'ado' ? adoMergeMcp : giteaMergeMcp,
  );
  return target;
}

async function request(
  provider: 'ado' | 'gitea',
  name?: string,
  args: Record<string, unknown> = {},
  auth: Variables['authContext'] = {
    tokenType: 'auth',
    version: 1,
    userId,
  },
) {
  const response = await app(provider, auth).request(`/${provider}`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: name ? 'tools/call' : 'tools/list',
      ...(name ? { params: { name, arguments: args } } : {}),
    }),
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  vi.resetAllMocks();
  const user = await userFactory.create({ role: 'member' });
  userId = user.id;
  userIds.push(userId);
  const suffix = randomUUID();
  const gitea = await repositoryFactory.create({
    sourceControlProvider: 'gitea',
    linkedByUserId: userId,
    host: 'gitea.example',
    fullName: `owner/repo-${suffix}`,
    externalRepoId: '123',
  });
  const ado = await repositoryFactory.create({
    sourceControlProvider: 'ado',
    linkedByUserId: userId,
    host: 'dev.azure.com',
    fullName: `organization/project/repo-${suffix}`,
    externalRepoId: randomUUID(),
  });
  giteaRepositoryId = gitea.id;
  adoRepositoryId = ado.id;
  repositoryIds.push(gitea.id, ado.id);
  mocks.giteaHost.mockResolvedValue('gitea.example');
  mocks.giteaToken.mockResolvedValue('gitea-token');
  mocks.giteaBaseUrl.mockResolvedValue('https://gitea.example');
  mocks.adoHost.mockResolvedValue('dev.azure.com');
  mocks.adoToken.mockResolvedValue('ado-token');
  mocks.giteaGet.mockResolvedValue({
    number: 7,
    title: 'PR',
    state: 'open',
    merged: false,
    head: { sha: headSha },
    base: {
      repo: { id: 123, full_name: gitea.fullName },
    },
  });
  mocks.adoGet.mockResolvedValue({
    pullRequestId: 7,
    status: 'active',
    repository: { id: ado.externalRepoId },
    lastMergeSourceCommit: { commitId: headSha },
  });
});

afterEach(async () => {
  if (repositoryIds.length)
    await db
      .delete(repositories)
      .where(inArray(repositories.id, repositoryIds.splice(0)));
  if (userIds.length)
    await db.delete(users).where(inArray(users.id, userIds.splice(0)));
});

it.each(['gitea', 'ado'] as const)(
  'discovers only read and merge tools for %s',
  async (provider) => {
    const { status, body } = await request(provider);
    expect(status).toBe(200);
    expect(
      body.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(['get_pull_request', 'merge_pull_request']);
    expect(mocks.giteaToken).not.toHaveBeenCalled();
    expect(mocks.adoToken).not.toHaveBeenCalled();
  },
);

it.each(['gitea', 'ado'] as const)(
  'requires current member auth and an active exact %s repository',
  async (provider) => {
    const fullName =
      provider === 'gitea'
        ? (await db.query.repositories.findFirst({
            where: inArray(repositories.id, [giteaRepositoryId]),
          }))!.fullName
        : (await db.query.repositories.findFirst({
            where: inArray(repositories.id, [adoRepositoryId]),
          }))!.fullName;
    const runAuth: Variables['authContext'] = {
      tokenType: 'run',
      version: 1,
      runId: 1,
      principal: 'user',
      userId,
    };
    expect((await request(provider, undefined, {}, runAuth)).status).toBe(403);
    const { body } = await request(provider, 'get_pull_request', {
      repositoryFullName: `${fullName}-other`,
      pullRequestNumber: 7,
    });
    expect(body.result.isError).toBe(true);
    expect(mocks.giteaGet).not.toHaveBeenCalled();
    expect(mocks.adoGet).not.toHaveBeenCalled();
  },
);

it.each(['gitea', 'ado'] as const)(
  'merges and verifies %s at the expected head with sanitized audit fields',
  async (provider) => {
    const repository = (await db.query.repositories.findFirst({
      where: inArray(repositories.id, [
        provider === 'gitea' ? giteaRepositoryId : adoRepositoryId,
      ]),
    }))!;
    const get = provider === 'gitea' ? mocks.giteaGet : mocks.adoGet;
    get
      .mockResolvedValueOnce(
        provider === 'gitea'
          ? {
              number: 7,
              state: 'open',
              merged: false,
              head: { sha: headSha },
              base: {
                repo: { id: 123, full_name: repository.fullName },
              },
            }
          : {
              pullRequestId: 7,
              status: 'active',
              repository: { id: repository.externalRepoId },
              lastMergeSourceCommit: { commitId: headSha },
            },
      )
      .mockResolvedValueOnce(
        provider === 'gitea'
          ? {
              number: 7,
              state: 'closed',
              merged: true,
              head: { sha: headSha },
              base: {
                repo: { id: 123, full_name: repository.fullName },
              },
            }
          : {
              pullRequestId: 7,
              status: 'completed',
              repository: { id: repository.externalRepoId },
              lastMergeSourceCommit: { commitId: headSha },
            },
      );
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const merge = provider === 'gitea' ? mocks.giteaMerge : mocks.adoMerge;
      merge.mockRejectedValue(new Error('ambiguous failure'));
      const { body } = await request(provider, 'merge_pull_request', {
        repositoryFullName: repository.fullName,
        pullRequestNumber: 7,
        expectedHeadSha: headSha,
      });
      expect(body.result.isError).not.toBe(true);
      expect(merge).toHaveBeenCalledOnce();
      expect(get).toHaveBeenCalledTimes(2);
      if (provider === 'ado') {
        for (const call of mocks.adoGet.mock.calls)
          expect(call[0]).toMatchObject({ organization: 'organization' });
        expect(mocks.adoMerge).toHaveBeenCalledWith(
          expect.objectContaining({ organization: 'organization' }),
        );
      }
      const audit = JSON.parse(log.mock.calls[0]![0]);
      expect(audit).toMatchObject({
        provider,
        userId,
        repositoryId: repository.id,
        repositoryFullName: repository.fullName,
        targetNumber: 7,
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain(headSha);
    } finally {
      log.mockRestore();
    }
  },
);

it.each(['gitea', 'ado'] as const)(
  'rejects a stale %s head before merge',
  async (provider) => {
    const repository = (await db.query.repositories.findFirst({
      where: inArray(repositories.id, [
        provider === 'gitea' ? giteaRepositoryId : adoRepositoryId,
      ]),
    }))!;
    const { body } = await request(provider, 'merge_pull_request', {
      repositoryFullName: repository.fullName,
      pullRequestNumber: 7,
      expectedHeadSha: 'b'.repeat(40),
    });
    expect(body.result.isError).toBe(true);
    expect(mocks.giteaMerge).not.toHaveBeenCalled();
    expect(mocks.adoMerge).not.toHaveBeenCalled();
  },
);
