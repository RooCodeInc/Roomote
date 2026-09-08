import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  db,
  eq,
  inArray,
  repositories,
  repositoryFactory,
  userFactory,
  users,
} from '@roomote/db/server';
import type { Variables } from '../../../types';

const { connection, resolveHost, resolveToken, createClient, client } =
  vi.hoisted(() => ({
    connection: vi.fn(),
    resolveHost: vi.fn(),
    resolveToken: vi.fn(),
    createClient: vi.fn(),
    client: {
      getRepository: vi.fn(),
      getFile: vi.fn(),
      listDirectory: vi.fn(),
      searchCode: vi.fn(),
      listCommits: vi.fn(),
      getCommit: vi.fn(),
      getPullRequest: vi.fn(),
      getPullRequestDiff: vi.fn(),
      listPullRequestComments: vi.fn(),
      updatePullRequest: vi.fn(),
      declinePullRequest: vi.fn(),
      getPullRequestComment: vi.fn(),
      createPullRequestComment: vi.fn(),
    },
  }));

vi.mock('@roomote/bitbucket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/bitbucket')>()),
  getBitbucketOAuthConnection: connection,
  resolveBitbucketInstanceHost: resolveHost,
  resolveBitbucketOAuthAccessToken: resolveToken,
  createBitbucketRepositoryClient: createClient,
}));

import { bitbucketMcp } from '../bitbucket';

const toolNames = [
  'get_file',
  'list_directory',
  'search_code',
  'list_commits',
  'get_commit',
  'get_pull_request',
  'get_pull_request_diff',
  'list_pull_request_comments',
  'update_pull_request',
  'decline_pull_request',
  'add_pull_request_comment',
];
let auth: Variables['authContext'];
let userId: string;
let repoId: string;
let fullName: string;
let identity: { uuid: string; full_name: string };
const userIds: string[] = [];
const repoIds: string[] = [];

function app() {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('authContext', auth);
    await next();
  });
  app.route('/bitbucket', bitbucketMcp);
  return app;
}

async function request(name?: string, args: Record<string, unknown> = {}) {
  const response = await app().request('/bitbucket', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: name ? 'tools/call' : 'tools/list',
      ...(name
        ? {
            params: {
              name,
              arguments: { repositoryFullName: fullName, ...args },
            },
          }
        : {}),
    }),
  });
  return { status: response.status, body: await response.json() };
}

function pullRequest() {
  return { id: 7, destination: { repository: identity } };
}

function parentComment() {
  return {
    id: 12,
    deleted: false,
    pullrequest: {
      id: 7,
      links: {
        self: {
          href: `https://api.bitbucket.org/2.0/repositories/${fullName}/pullrequests/7`,
        },
      },
    },
  };
}

beforeEach(async () => {
  vi.resetAllMocks();
  const user = await userFactory.create({ role: 'member' });
  userId = user.id;
  userIds.push(userId);
  fullName = `mcp-tests/repo-${randomUUID()}`;
  identity = { uuid: `{${randomUUID().toUpperCase()}}`, full_name: fullName };
  const repo = await repositoryFactory.create({
    sourceControlProvider: 'bitbucket',
    linkedByUserId: userId,
    fullName,
    externalRepoId: identity.uuid.slice(1, -1).toLowerCase(),
  });
  repoId = repo.id;
  repoIds.push(repoId);
  auth = { tokenType: 'auth', version: 1, userId };
  connection.mockResolvedValue({ status: 'active' });
  resolveHost.mockResolvedValue('bitbucket.org');
  resolveToken.mockResolvedValue('fresh-token');
  createClient.mockReturnValue(client);
  client.getRepository.mockResolvedValue(identity);
  client.getPullRequest.mockResolvedValue(pullRequest());
  client.getPullRequestComment.mockResolvedValue(parentComment());
});

afterEach(async () => {
  if (repoIds.length)
    await db
      .delete(repositories)
      .where(inArray(repositories.id, repoIds.splice(0)));
  if (userIds.length)
    await db.delete(users).where(inArray(users.id, userIds.splice(0)));
});

describe('Bitbucket MCP discovery authorization', () => {
  it('discovers and calls tools for the configured www Cloud host', async () => {
    resolveHost.mockResolvedValue('www.bitbucket.org');
    await db
      .update(repositories)
      .set({ host: 'www.bitbucket.org' })
      .where(eq(repositories.id, repoId));
    expect((await request()).status).toBe(200);
    expect(resolveToken).not.toHaveBeenCalled();
    client.getFile.mockResolvedValue('contents');
    const { status, body } = await request('get_file', {
      ref: 'main',
      path: 'README.md',
    });
    expect(status).toBe(200);
    expect(body.result.structuredContent).toEqual({ result: 'contents' });
    expect(resolveToken).toHaveBeenCalledOnce();
  });

  it.each([
    'www.bitbucket.org',
    'bitbucket.example.com',
    'bitbucket.org.evil.test',
  ])(
    'rejects discovery and calls for a mismatched or non-Cloud configured host %s',
    async (host) => {
      resolveHost.mockResolvedValue(host);
      if (host !== 'www.bitbucket.org') {
        await db
          .update(repositories)
          .set({ host })
          .where(eq(repositories.id, repoId));
      }
      expect((await request()).status).toBe(403);
      expect(
        (await request('get_file', { ref: 'main', path: 'README.md' })).status,
      ).toBe(403);
      expect(resolveToken).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it.each(['member', 'admin'] as const)(
    'offers exactly the bounded tools to a live %s without resolving credentials',
    async (role) => {
      await db.update(users).set({ role }).where(eq(users.id, userId));
      const { status, body } = await request();
      expect(status).toBe(200);
      expect(
        body.result.tools.map((tool: { name: string }) => tool.name).sort(),
      ).toEqual([...toolNames].sort());
      expect(resolveToken).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'run', 'mcp', 'nonmember', 'deleted'] as const)(
    'rejects %s authentication before OAuth access',
    async (kind) => {
      if (kind === 'missing') auth = undefined;
      if (kind === 'run')
        auth = {
          tokenType: 'run',
          version: 1,
          runId: 1,
          principal: 'user',
          userId,
        };
      if (kind === 'mcp')
        auth = {
          tokenType: 'mcp',
          version: 1,
          userId,
          resource: 'https://example.test/mcp',
          scopes: ['mcp:access'],
        };
      if (kind === 'nonmember')
        auth = { tokenType: 'auth', version: 1, userId: randomUUID() };
      if (kind === 'deleted')
        await db
          .update(users)
          .set({ deletedAt: new Date() })
          .where(eq(users.id, userId));
      const { status, body } = await request();
      expect(status).toBe(kind === 'missing' ? 401 : 403);
      expect(body.error.message).toBe(
        kind === 'missing'
          ? 'Authentication required'
          : kind === 'run' || kind === 'mcp'
            ? 'Bitbucket MCP requires a Session user auth token'
            : 'Current deployment membership required',
      );
      expect(connection).not.toHaveBeenCalled();
      expect(resolveToken).not.toHaveBeenCalled();
    },
  );

  it.each([null, { status: 'reauth_required' }])(
    'rejects unavailable OAuth %j',
    async (value) => {
      connection.mockResolvedValue(value);
      const { status, body } = await request();
      expect(status).toBe(403);
      expect(body.error.message).toBe(
        'Active Bitbucket OAuth connection required',
      );
      expect(resolveToken).not.toHaveBeenCalled();
    },
  );

  it('rejects discovery without an active repository', async () => {
    await db
      .update(repositories)
      .set({ isActive: false })
      .where(eq(repositories.id, repoId));
    const { status, body } = await request();
    expect(status).toBe(403);
    expect(body.error.message).toBe(
      'Active connected Bitbucket Cloud repository required',
    );
    expect(connection).not.toHaveBeenCalled();
  });
});

describe('Bitbucket MCP call authorization', () => {
  it.each(['repository', 'OAuth', 'member'] as const)(
    'revalidates %s revocation after discovery',
    async (kind) => {
      expect((await request()).status).toBe(200);
      if (kind === 'repository')
        await db
          .update(repositories)
          .set({ isActive: false })
          .where(eq(repositories.id, repoId));
      if (kind === 'OAuth')
        connection.mockResolvedValue({ status: 'reauth_required' });
      if (kind === 'member')
        await db
          .update(users)
          .set({ deletedAt: new Date() })
          .where(eq(users.id, userId));
      expect(
        (await request('get_file', { ref: 'main', path: 'README.md' })).status,
      ).toBe(403);
      expect(resolveToken).not.toHaveBeenCalled();
      expect(client.getFile).not.toHaveBeenCalled();
    },
  );

  it('checks the requested repository even when a different active repository permits discovery', async () => {
    const { body } = await request('get_file', {
      repositoryFullName: 'other/repository',
      ref: 'main',
      path: 'README.md',
    });
    expect(body.result).toMatchObject({
      isError: true,
      content: [
        { text: 'Active connected Bitbucket Cloud repository required' },
      ],
    });
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it('rechecks OAuth inside the tool after route authorization', async () => {
    connection
      .mockResolvedValueOnce({ status: 'active' })
      .mockResolvedValue(null);
    const { body } = await request('get_file', {
      ref: 'main',
      path: 'README.md',
    });
    expect(body.result.isError).toBe(true);
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it('resolves fresh credentials on every call, never discovery', async () => {
    await request();
    resolveToken
      .mockResolvedValueOnce('token-one')
      .mockResolvedValueOnce('token-two');
    client.getFile.mockResolvedValue('contents');
    for (const token of ['token-one', 'token-two']) {
      expect(
        (await request('get_file', { ref: 'main', path: 'README.md' })).body
          .result.isError,
      ).not.toBe(true);
      expect(createClient).toHaveBeenLastCalledWith({
        repositoryFullName: fullName,
        token,
      });
    }
    expect(resolveToken).toHaveBeenCalledTimes(2);
  });

  it('blocks a missing refreshed token', async () => {
    resolveToken.mockResolvedValue(null);
    const { body } = await request('get_file', {
      ref: 'main',
      path: 'README.md',
    });
    expect(body.result).toMatchObject({
      isError: true,
      content: [{ text: 'Bitbucket OAuth token unavailable' }],
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each(['uuid', 'full_name'] as const)(
    'blocks upstream repository %s mismatch',
    async (field) => {
      client.getRepository.mockResolvedValue({
        ...identity,
        [field]: 'other/repo',
      });
      const { body } = await request('get_file', {
        ref: 'main',
        path: 'README.md',
      });
      expect(body.result).toMatchObject({
        isError: true,
        content: [{ text: 'Bitbucket repository ownership mismatch' }],
      });
      expect(client.getFile).not.toHaveBeenCalled();
    },
  );

  it.each(['destination', 'number'] as const)(
    'blocks PR %s mismatch before mutation',
    async (kind) => {
      client.getPullRequest.mockResolvedValue(
        kind === 'number'
          ? { ...pullRequest(), id: 8 }
          : {
              ...pullRequest(),
              destination: { repository: { ...identity, uuid: randomUUID() } },
            },
      );
      const { body } = await request('decline_pull_request', {
        pullRequestNumber: 7,
      });
      expect(body.result.isError).toBe(true);
      expect(client.declinePullRequest).not.toHaveBeenCalled();
    },
  );

  it.each(['wrong PR', 'wrong repo', 'wrong id', 'deleted'] as const)(
    'blocks reply to %s parent',
    async (kind) => {
      const parent = parentComment();
      if (kind === 'wrong PR') parent.pullrequest.id = 8;
      if (kind === 'wrong repo')
        parent.pullrequest.links.self.href =
          'https://api.bitbucket.org/2.0/repositories/other/repo/pullrequests/7';
      if (kind === 'wrong id') parent.id = 13;
      if (kind === 'deleted') parent.deleted = true;
      client.getPullRequestComment.mockResolvedValue(parent);
      const { body } = await request('add_pull_request_comment', {
        pullRequestNumber: 7,
        body: 'reply',
        parentCommentId: 12,
      });
      expect(body.result).toMatchObject({
        isError: true,
        content: [
          {
            text: 'Reply parent does not belong to this repository and pull request',
          },
        ],
      });
      expect(client.getPullRequestComment).toHaveBeenCalledWith(7, 12);
      expect(client.createPullRequestComment).not.toHaveBeenCalled();
    },
  );
});

describe('Bitbucket MCP bounded operations', () => {
  it.each([
    [
      'get_file',
      'getFile',
      { ref: 'main', path: 'README.md' },
      ['main', 'README.md'],
    ],
    [
      'list_directory',
      'listDirectory',
      { ref: 'main', path: 'src', page: 2 },
      ['main', 'src', 2],
    ],
    ['search_code', 'searchCode', { terms: 'hello', page: 2 }, ['hello', 2]],
    ['list_commits', 'listCommits', { ref: 'main', page: 2 }, ['main', 2]],
    ['get_commit', 'getCommit', { hash: 'abcdef0' }, ['abcdef0']],
    ['get_pull_request', 'getPullRequest', { pullRequestNumber: 7 }, [7]],
    [
      'get_pull_request_diff',
      'getPullRequestDiff',
      { pullRequestNumber: 7 },
      [7],
    ],
    [
      'list_pull_request_comments',
      'listPullRequestComments',
      { pullRequestNumber: 7, page: 2 },
      [7, 2],
    ],
    [
      'update_pull_request',
      'updatePullRequest',
      { pullRequestNumber: 7, title: 'New title', description: 'Details' },
      [7, { title: 'New title', description: 'Details' }],
    ],
    [
      'decline_pull_request',
      'declinePullRequest',
      { pullRequestNumber: 7 },
      [7],
    ],
    [
      'add_pull_request_comment',
      'createPullRequestComment',
      { pullRequestNumber: 7, body: 'Comment' },
      [7, 'Comment', undefined],
    ],
    [
      'add_pull_request_comment',
      'createPullRequestComment',
      { pullRequestNumber: 7, body: 'Reply', parentCommentId: 12 },
      [7, 'Reply', 12],
    ],
  ] as const)(
    'executes %s with scoped provider arguments %j',
    async (name, method, args, expected) => {
      const result =
        method === 'searchCode'
          ? { values: [{ file: { commit: { repository: identity } } }] }
          : method === 'listCommits'
            ? { values: [{ repository: identity }] }
            : method === 'getCommit'
              ? { repository: identity }
              : [
                    'getPullRequest',
                    'updatePullRequest',
                    'declinePullRequest',
                  ].includes(method)
                ? pullRequest()
                : { value: 'provider result' };
      client[method].mockResolvedValue(result);
      const { status, body } = await request(name, args);
      expect(status).toBe(200);
      expect(body.result.isError).not.toBe(true);
      expect(body.result.structuredContent).toEqual({ result });
      expect(client[method]).toHaveBeenLastCalledWith(...expected);
      expect(client.getRepository).toHaveBeenCalledTimes(1);
      if ('pullRequestNumber' in args)
        expect(client.getPullRequest).toHaveBeenCalledWith(7);
      if (name === 'add_pull_request_comment' && !('parentCommentId' in args))
        expect(client.getPullRequestComment).not.toHaveBeenCalled();
    },
  );

  it.each([
    'merge_pull_request',
    'reopen_pull_request',
    'create_commit',
    'delete_file',
    'arbitrary_request',
  ])('does not expose or execute forbidden tool %s', async (name) => {
    const { body } = await request(name);
    expect(body.result.isError).toBe(true);
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([
    [
      'get_file',
      { ref: 'main', path: 'README.md', url: 'https://example.test' },
    ],
    [
      'update_pull_request',
      { pullRequestNumber: 7, title: 'Title', state: 'MERGED' },
    ],
    [
      'add_pull_request_comment',
      { pullRequestNumber: 7, body: 'Comment', repository: 'other/repo' },
    ],
  ])(
    'rejects unknown fields for %s before provider access',
    async (name, args) => {
      const { body } = await request(
        name as string,
        args as Record<string, unknown>,
      );
      expect(body.result.isError).toBe(true);
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it('does not reflect provider errors or credentials', async () => {
    client.getFile.mockRejectedValue(new Error('Bearer secret-provider-token'));
    const { body } = await request('get_file', {
      ref: 'main',
      path: 'README.md',
    });
    expect(body.result).toMatchObject({
      isError: true,
      content: [
        { text: 'Bitbucket operation failed or returned an invalid response' },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('secret-provider-token');
  });
});
