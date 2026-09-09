import { Hono } from 'hono';
import { generateKeyPairSync } from 'node:crypto';
import { createRunToken } from '@roomote/auth';
import { configureAuthClientEnv } from '@roomote/auth/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  db,
  eq,
  githubInstallationFactory,
  githubInstallations,
  repositories,
  repositoryFactory,
  runFactory,
  sql,
  taskRuns,
  tasks,
  userFactory,
  users,
} from '@roomote/db/server';
import { getAllowedRouterMcpToolNames } from '@roomote/cloud-agents/router-mcp-policy';
import type { Variables } from '../../../types';

const mocks = vi.hoisted(() => ({
  mint: vi.fn(),
  credentials: vi.fn(),
  tryCredentials: vi.fn(),
  upstream: vi.fn(),
  publicFetch: vi.fn(),
}));
vi.mock('@roomote/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/auth')>()),
  createGitHubToken: mocks.mint,
  resolveRuntimeGitHubAppCredentials: mocks.credentials,
  tryResolveRuntimeGitHubAppCredentials: mocks.tryCredentials,
}));
vi.mock('../../long-lived-fetch', () => ({
  fetchWithLongLivedStreamDispatcher: mocks.upstream,
}));

import { createGithubMcp } from '../github';
import { createMcpProxy } from '../proxy-utils';
import { githubPublicTools } from '../github-public-tools';
import { tokenAuthMiddleware } from '../../../middleware/tokenAuthMiddleware';

describe('GitHub MCP bounded writes', () => {
  let actor: Awaited<ReturnType<typeof userFactory.create>>;
  let installer: Awaited<ReturnType<typeof userFactory.create>>;
  let installation: Awaited<
    ReturnType<typeof githubInstallationFactory.create>
  >;
  let repository: Awaited<ReturnType<typeof repositoryFactory.create>>;
  let secondInstallation: typeof installation;
  let secondRepository: typeof repository;
  const appCredentials = { appId: '123', privateKey: 'test-only-key' };
  const owner = `bounded-${crypto.randomUUID()}`;
  const args = { owner, repo: 'example', pullNumber: 42, state: 'closed' };
  const writeCases = [
    ['update_pull_request', { pullNumber: 42, state: 'closed' }],
    ['add_issue_comment', { issue_number: 42, body: 'Comment' }],
    [
      'add_reply_to_pull_request_comment',
      { pullNumber: 42, commentId: 12, body: 'Reply' },
    ],
  ] as const;

  beforeAll(async () => {
    const keys = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    configureAuthClientEnv({
      jobAuthPrivateKey: keys.privateKey,
      jobAuthPublicKey: keys.publicKey,
      nodeEnv: 'test',
    });
    actor = await userFactory.create({ role: 'member' });
    installer = await userFactory.create();
    installation = await githubInstallationFactory.create({
      installedByUserId: installer.id,
      appId: 123,
    });
    repository = await repositoryFactory.create({
      installationId: installation.id,
      linkedByUserId: installer.id,
      fullName: `${owner}/example`,
    });
    secondInstallation = await githubInstallationFactory.create({
      installedByUserId: installer.id,
      appId: 123,
      permissions: { issues: 'write', pull_requests: 'write' },
    });
    secondRepository = await repositoryFactory.create({
      installationId: secondInstallation.id,
      linkedByUserId: installer.id,
      fullName: `${owner}/second`,
    });
  });

  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      mocks.publicFetch
        .mockReset()
        .mockImplementation(async () =>
          Response.json({ message: 'Not Found' }, { status: 404 }),
        ),
    );
    mocks.mint.mockReset().mockResolvedValue('scoped-test-token');
    mocks.credentials.mockReset().mockResolvedValue(appCredentials);
    mocks.tryCredentials.mockReset().mockResolvedValue(appCredentials);
    mocks.upstream
      .mockReset()
      .mockImplementation(async () =>
        Response.json({ jsonrpc: '2.0', id: 7, result: { content: [] } }),
      );
    await db
      .update(users)
      .set({ deletedAt: null })
      .where(eq(users.id, actor.id));
    await db
      .update(githubInstallations)
      .set({
        suspendedAt: null,
        appId: 123,
        permissions: { issues: 'write', pull_requests: 'write' },
      })
      .where(eq(githubInstallations.id, installation.id));
    await db
      .update(repositories)
      .set({
        isActive: true,
        private: repository.private,
        installationId: installation.id,
        host: 'github.com',
        githubRepoId: repository.githubRepoId,
        sourceControlProvider: 'github',
      })
      .where(eq(repositories.id, repository.id));
  });

  afterEach(() => vi.unstubAllGlobals());

  afterAll(async () => {
    configureAuthClientEnv(null);
    await db
      .delete(repositories)
      .where(eq(repositories.id, secondRepository.id));
    await db
      .delete(githubInstallations)
      .where(eq(githubInstallations.id, secondInstallation.id));
    await db.delete(repositories).where(eq(repositories.id, repository.id));
    await db
      .delete(githubInstallations)
      .where(eq(githubInstallations.id, installation.id));
    await db.delete(users).where(eq(users.id, actor.id));
    await db.delete(users).where(eq(users.id, installer.id));
  });

  function app(
    auth: Variables['authContext'] | null = {
      tokenType: 'auth',
      userId: actor.id,
      version: 1,
    },
    restrict = true,
    allowedToolNames?: readonly string[],
  ) {
    const hono = new Hono<{ Variables: Variables }>();
    hono.use('*', async (c, next) => {
      if (auth) c.set('authContext', auth);
      await next();
    });
    hono.route(
      '/github',
      createGithubMcp({
        allowAuthTokens: true,
        ...(allowedToolNames
          ? { allowedToolNames }
          : restrict
            ? { allowedToolNames: getAllowedRouterMcpToolNames('github') }
            : {}),
      }),
    );
    return hono;
  }

  function post(body: unknown, target = app()) {
    return target.request('/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer caller-secret',
        cookie: 'secret-cookie',
        'x-github-token': 'secret-token',
      },
      body: JSON.stringify(body),
    });
  }

  function call(
    name = 'update_pull_request',
    arguments_: unknown = args,
    target = app(),
  ) {
    return post(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name, arguments: arguments_ },
      },
      target,
    );
  }

  it.each(['closed', 'open'])(
    'forwards only the requested %s state using the target repository installation',
    async (state) => {
      expect(
        (await call('update_pull_request', { ...args, state })).status,
      ).toBe(200);
      expect(mocks.mint).toHaveBeenCalledExactlyOnceWith(
        {
          type: 'installationId',
          installationId: installation.id,
          repositoryIds: [repository.githubRepoId],
        },
        appCredentials,
      );
      const init = mocks.upstream.mock.calls[0]![1] as RequestInit;
      expect(JSON.parse(init.body as string).params.arguments).toEqual({
        ...args,
        state,
      });
      expect(new Headers(init.headers).get('X-MCP-Readonly')).toBe('false');
      expect(new Headers(init.headers).get('authorization')).toBe(
        'Bearer scoped-test-token',
      );
    },
  );

  it('allows a member without personal OAuth or installation ownership to edit title and body', async () => {
    expect(
      (
        await call('update_pull_request', {
          owner,
          repo: 'example',
          pullNumber: 42,
          title: 'New title',
          body: '',
        })
      ).status,
    ).toBe(200);
  });

  it('selects the target installation even when another active installation exists', async () => {
    const other = await githubInstallationFactory.create({
      installedByUserId: installer.id,
      appId: 123,
    });
    try {
      expect((await call()).status).toBe(200);
      expect(mocks.mint).toHaveBeenCalledExactlyOnceWith(
        {
          type: 'installationId',
          installationId: installation.id,
          repositoryIds: [repository.githubRepoId],
        },
        appCredentials,
      );
    } finally {
      await db
        .delete(githubInstallations)
        .where(eq(githubInstallations.id, other.id));
    }
  });

  it.each([
    { ...args, owner: '../outside' },
    { ...args, repo: '..' },
    { ...args, repo: 'example/other' },
    { repo: 'example' },
    { owner },
    { ...args, owner: 42 },
  ])('rejects malformed repository targets: %j', async (arguments_) => {
    expect((await call('update_pull_request', arguments_)).status).toBe(400);
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it.each([
    ...writeCases.slice(1),
    [
      'update_pull_request',
      {
        pullNumber: 42,
        state: 'closed',
        base: 'release',
        draft: true,
        maintainer_can_modify: false,
        reviewers: ['reviewer'],
        title: 't'.repeat(257),
        body: 'b'.repeat(65537),
      },
    ],
    ['add_issue_comment', { issue_number: 42, reaction: 'eyes' }],
    ['add_issue_comment', { issue_number: 42, comment_id: 12, reaction: '+1' }],
    ['add_reply_to_pull_request_comment', { commentId: 12, reaction: 'eyes' }],
    ['add_issue_comment', { issue_number: 42, body: 'b'.repeat(65537) }],
    [
      'add_reply_to_pull_request_comment',
      { pullNumber: 42, commentId: 12, body: 'b'.repeat(65537) },
    ],
    ['update_pull_request', { pullNumber: 42 }],
    ['update_pull_request', {}],
    ['update_pull_request', { pullNumber: 'invalid', state: 'merged' }],
    ['update_pull_request', { pullNumber: 0, title: null }],
    ['add_issue_comment', { issue_number: { payload: 'private-id' } }],
    ['add_issue_comment', {}],
    ['add_reply_to_pull_request_comment', { commentId: 'invalid' }],
    ['add_reply_to_pull_request_comment', {}],
  ] as const)(
    'leaves native argument validation to upstream for %s',
    async (name, fields) => {
      const arguments_ = { owner, repo: 'example', ...fields };
      expect((await call(name, arguments_)).status).toBe(200);
      expect(
        JSON.parse(mocks.upstream.mock.calls[0]![1].body).params.arguments,
      ).toEqual(arguments_);
    },
  );

  it.each([
    'merge_pull_request',
    'create_pull_request',
    'issue_write',
    'delete_file',
    'actions_run_trigger',
    'push_files',
  ])('denies undiscovered tool %s even on direct invocation', async (name) => {
    expect((await call(name, args, app(undefined, false))).status).toBe(403);
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it('rejects batch requests before credentials resolve', async () => {
    expect(
      (
        await post([
          {
            method: 'tools/call',
            params: { name: 'update_pull_request', arguments: args },
          },
        ])
      ).status,
    ).toBe(400);
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it('filters discovery while preserving full native schemas and descriptions for JSON and SSE', async () => {
    const targetProperties = {
      owner: { type: 'string' },
      repo: { type: 'string' },
    };
    const reaction = {
      type: 'string',
      enum: [
        '+1',
        '-1',
        'laugh',
        'confused',
        'heart',
        'hooray',
        'rocket',
        'eyes',
      ],
    };
    const tools = [
      { name: 'get_file_contents', inputSchema: { type: 'object' } },
      {
        name: 'update_pull_request',
        description: 'Update an existing pull request in a GitHub repository.',
        inputSchema: {
          type: 'object',
          required: ['owner', 'repo', 'pullNumber'],
          properties: {
            ...targetProperties,
            pullNumber: { type: 'number' },
            title: { type: 'string' },
            body: { type: 'string' },
            state: { type: 'string', enum: ['open', 'closed'] },
            draft: { type: 'boolean' },
            base: { type: 'string', description: 'New base branch name' },
            maintainer_can_modify: { type: 'boolean' },
            reviewers: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      {
        name: 'add_issue_comment',
        description:
          'Add a comment and/or reaction to a specific issue or issue comment in a GitHub repository. Use this tool with pull requests as well (in this case pass pull request number as issue_number), but only if user is not asking specifically to add or react to review comments. At least one of body or reaction is required.',
        inputSchema: {
          type: 'object',
          required: ['owner', 'repo', 'issue_number'],
          properties: {
            ...targetProperties,
            issue_number: { type: 'number' },
            comment_id: { type: 'integer', minimum: 1 },
            body: { type: 'string', minLength: 1 },
            reaction,
          },
        },
      },
      {
        name: 'add_reply_to_pull_request_comment',
        description:
          'Add a reply and/or reaction to an existing pull request comment. This can create a new comment linked as a reply to the specified comment, add an emoji reaction to the specified comment, or do both. At least one of body or reaction is required.',
        inputSchema: {
          type: 'object',
          required: ['owner', 'repo', 'commentId'],
          properties: {
            ...targetProperties,
            pullNumber: { type: 'number' },
            commentId: { type: 'number', minimum: 1 },
            body: { type: 'string' },
            reaction,
          },
        },
      },
      { name: 'merge_pull_request' },
      { name: 'actions_run_trigger' },
      { name: 'issue_write' },
    ];
    for (const sse of [false, true]) {
      const payload = { jsonrpc: '2.0', id: 7, result: { tools } };
      mocks.upstream.mockResolvedValueOnce(
        sse
          ? new Response(`data: ${JSON.stringify(payload)}\n\n`, {
              headers: { 'content-type': 'text/event-stream' },
            })
          : Response.json(payload),
      );
      const response = await post({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/list',
      });
      const visible = (await response.json()).result.tools;
      expect(visible).toEqual(tools.slice(0, 4));
    }
    expect(
      new Headers(mocks.upstream.mock.calls[0]![1].headers).get(
        'X-MCP-Readonly',
      ),
    ).toBe('false');
    expect(mocks.mint).toHaveBeenCalledWith(
      {
        type: 'installationId',
        installationId: expect.any(String),
        repositoryIds: [expect.any(Number)],
      },
      appCredentials,
    );
  });

  it('preserves an unparseable upstream discovery response', async () => {
    mocks.upstream.mockResolvedValueOnce(new Response('not JSON'));
    const response = await post({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/list',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('not JSON');
  });

  it('keeps ordinary reads upstream-readonly', async () => {
    expect(
      (await call('pull_request_read', { ...args, method: 'get' })).status,
    ).toBe(200);
    expect(mocks.mint).toHaveBeenCalledExactlyOnceWith(
      {
        type: 'installationId',
        installationId: installation.id,
        repositoryIds: [repository.githubRepoId],
      },
      appCredentials,
    );
    expect(
      new Headers(mocks.upstream.mock.calls[0]![1].headers).get(
        'X-MCP-Readonly',
      ),
    ).toBe('true');
  });

  it('rejects an unconnected repository', async () => {
    expect(
      (await call('update_pull_request', { ...args, repo: 'unconnected' }))
        .status,
    ).toBe(403);
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it.each(['initialize', 'tools/list'])(
    'uses a deterministic scoped credential for %s with multiple installations',
    async (method) => {
      const expected =
        installation.id < secondInstallation.id
          ? { installation, repository }
          : { installation: secondInstallation, repository: secondRepository };
      for (let i = 0; i < 2; i++) {
        mocks.upstream.mockResolvedValueOnce(
          Response.json({ jsonrpc: '2.0', id: 7, result: { tools: [] } }),
        );
        expect((await post({ jsonrpc: '2.0', id: 7, method })).status).toBe(
          200,
        );
      }
      expect(mocks.mint).toHaveBeenCalledTimes(2);
      for (const [scope, credentials] of mocks.mint.mock.calls) {
        expect(scope).toEqual({
          type: 'installationId',
          installationId: expected.installation.id,
          repositoryIds: [expected.repository.githubRepoId],
        });
        expect(credentials).toEqual(appCredentials);
      }
    },
  );

  it.each([
    'get_file_contents',
    'pull_request_read',
    'update_pull_request',
    'add_issue_comment',
    'add_reply_to_pull_request_comment',
  ])(
    'routes %s to the second repository without granting access to the first',
    async (name) => {
      const arguments_ =
        name === 'add_issue_comment'
          ? { owner, repo: 'second', issue_number: 42, body: 'Comment' }
          : name === 'add_reply_to_pull_request_comment'
            ? {
                owner,
                repo: 'second',
                pullNumber: 42,
                commentId: 12,
                body: 'Reply',
              }
            : { ...args, repo: 'second' };
      expect((await call(name, arguments_)).status).toBe(200);
      expect(mocks.mint).toHaveBeenCalledExactlyOnceWith(
        {
          type: 'installationId',
          installationId: secondInstallation.id,
          repositoryIds: [secondRepository.githubRepoId],
        },
        appCredentials,
      );
    },
  );

  it.each(['search_code', 'search_pull_requests', 'search_repositories'])(
    'routes a single-repo %s unchanged',
    async (name) => {
      const arguments_ = {
        query: `repo:${owner}/second`,
        perPage: 5,
      };
      expect((await call(name, arguments_)).status).toBe(200);
      expect(mocks.mint).toHaveBeenCalledExactlyOnceWith(
        {
          type: 'installationId',
          installationId: secondInstallation.id,
          repositoryIds: [secondRepository.githubRepoId],
        },
        appCredentials,
      );
      expect(
        JSON.parse(mocks.upstream.mock.calls[0]![1].body).params.arguments,
      ).toEqual(arguments_);
    },
  );

  it.each([
    { owner },
    { repo: 'second' },
    { owner: owner.toUpperCase(), repo: 'SECOND' },
  ])('allows matching optional PR search scope %j', async (scope) => {
    const arguments_ = { query: `repo:${owner}/second is:open`, ...scope };
    expect((await call('search_pull_requests', arguments_)).status).toBe(200);
    expect(mocks.mint).toHaveBeenCalledExactlyOnceWith(
      {
        type: 'installationId',
        installationId: secondInstallation.id,
        repositoryIds: [secondRepository.githubRepoId],
      },
      appCredentials,
    );
    expect(
      JSON.parse(mocks.upstream.mock.calls[0]![1].body).params.arguments,
    ).toEqual(arguments_);
  });

  it.each([
    'fix',
    `org:${owner}`,
    `repo:${owner}/example repo:${owner}/second`,
    `repo:${owner}/example OR fix`,
    `NOT repo:${owner}/example`,
    `-repo:${owner}/example`,
    `(repo:${owner}/example)`,
    `repo:"${owner}/example"`,
    `"repo:${owner}/example"`,
    `repo:${owner}/example /fix|other/`,
    `repo:${owner}/example org:${owner}`,
    `repo:${owner}/*`,
    `repo:${owner}/example OR(repo:${owner}/second)`,
  ])(
    'rejects ambiguous or unscoped search %s before credentials',
    async (query) => {
      for (const name of [
        'search_code',
        'search_pull_requests',
        'search_repositories',
      ]) {
        const response = await call(name, { query });
        expect(response.status).toBe(400);
        expect((await response.json()).error.message).toContain(
          'Split searches',
        );
      }
      expect(mocks.mint).not.toHaveBeenCalled();
      expect(mocks.upstream).not.toHaveBeenCalled();
    },
  );

  it.each([
    'example',
    `example in:name org:${owner}`,
    `org:${owner}`,
    `example in:name org:${owner} org:another`,
    `example in:name org:${owner} OR second`,
    `example in:description org:${owner}`,
    `"example" in:name org:${owner}`,
  ])('rejects unsupported repository search %s', async (query) => {
    expect((await call('search_repositories', { query })).status).toBe(400);
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    'query',
    {},
    { query: null },
    { query: 42 },
    { query: '' },
    { query: `repo:${owner}/second`, owner: null },
    { query: `repo:${owner}/second`, repo: 42 },
    { query: `repo:${owner}/second`, owner: '../outside' },
    { query: `repo:${owner}/second`, owner: 'another' },
    { query: `repo:${owner}/second`, repo: 'example' },
  ])(
    'rejects malformed or conflicting search arguments %j without credentials',
    async (arguments_) => {
      for (const name of [
        'search_code',
        'search_pull_requests',
        'search_repositories',
      ])
        expect((await call(name, arguments_)).status).toBe(400);
      expect(mocks.mint).not.toHaveBeenCalled();
      expect(mocks.upstream).not.toHaveBeenCalled();
    },
  );

  it.each([
    { isActive: false },
    { host: 'enterprise.example' },
    { githubRepoId: -1 },
    { sourceControlProvider: 'gitlab' as const },
  ])(
    'never falls back to another installation for an invalid read target %j',
    async (update) => {
      await db
        .update(repositories)
        .set(update)
        .where(eq(repositories.id, repository.id));
      for (const [name, arguments_] of [
        ['get_file_contents', { owner, repo: 'example' }],
        ['search_code', { query: `repo:${owner}/example fix` }],
        ['search_repositories', { query: `repo:${owner}/example` }],
      ] as const)
        expect((await call(name, arguments_)).status).toBe(
          name === 'get_file_contents' ? 404 : 400,
        );
      expect(mocks.mint).not.toHaveBeenCalled();
      expect(mocks.upstream).not.toHaveBeenCalled();
    },
  );

  it.each([{ suspendedAt: new Date() }, { appId: 456 }])(
    'excludes ineligible installations from reads and discovery %j',
    async (update) => {
      await db
        .update(githubInstallations)
        .set(update)
        .where(eq(githubInstallations.id, installation.id));
      expect(
        (await call('get_file_contents', { owner, repo: 'example' })).status,
      ).toBe(404);
      expect(mocks.mint).not.toHaveBeenCalled();
      expect(
        (await post({ jsonrpc: '2.0', id: 7, method: 'initialize' })).status,
      ).toBe(200);
      expect(mocks.mint).toHaveBeenCalledExactlyOnceWith(
        {
          type: 'installationId',
          installationId: secondInstallation.id,
          repositoryIds: [secondRepository.githubRepoId],
        },
        appCredentials,
      );
    },
  );

  it('rejects disconnected and unspecified reads without using the discovery credential', async () => {
    expect(
      (await call('get_file_contents', { owner, repo: 'disconnected' })).status,
    ).toBe(404);
    expect(
      (
        await call('search_repositories', {
          query: `repo:${owner}/disconnected`,
        })
      ).status,
    ).toBe(400);
    expect((await call('get_file_contents', {})).status).toBe(400);
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it('skips inactive repositories for discovery and uses public discovery when none remain connected', async () => {
    await db
      .update(repositories)
      .set({ isActive: false })
      .where(eq(repositories.id, repository.id));
    expect(
      (await post({ jsonrpc: '2.0', id: 7, method: 'initialize' })).status,
    ).toBe(200);
    expect(mocks.mint).toHaveBeenCalledExactlyOnceWith(
      {
        type: 'installationId',
        installationId: secondInstallation.id,
        repositoryIds: [secondRepository.githubRepoId],
      },
      appCredentials,
    );
    await db
      .update(repositories)
      .set({ isActive: false })
      .where(eq(repositories.id, secondRepository.id));
    try {
      expect(
        (await post({ jsonrpc: '2.0', id: 7, method: 'initialize' })).status,
      ).toBe(200);
      expect(mocks.mint).toHaveBeenCalledTimes(1);
    } finally {
      await db
        .update(repositories)
        .set({ isActive: true })
        .where(eq(repositories.id, secondRepository.id));
    }
  });

  it('preserves well-scoped single-installation reads and searches', async () => {
    await db
      .update(githubInstallations)
      .set({ suspendedAt: new Date() })
      .where(eq(githubInstallations.id, secondInstallation.id));
    try {
      for (const [name, arguments_] of [
        ['get_file_contents', { owner, repo: 'example' }],
        ['search_code', { query: `repo:${owner}/example fix` }],
        ['search_pull_requests', { query: `repo:${owner}/example is:open` }],
        ['search_repositories', { query: `repo:${owner}/example` }],
      ] as const)
        expect((await call(name, arguments_)).status).toBe(200);
      expect(mocks.mint).toHaveBeenCalledTimes(4);
      for (const [scope] of mocks.mint.mock.calls)
        expect(scope).toEqual({
          type: 'installationId',
          installationId: installation.id,
          repositoryIds: [repository.githubRepoId],
        });
    } finally {
      await db
        .update(githubInstallations)
        .set({ suspendedAt: null })
        .where(eq(githubInstallations.id, secondInstallation.id));
    }
  });

  it('requires active members for read and protocol traffic as well as writes', async () => {
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, actor.id));
    expect(
      (await call('get_file_contents', { owner, repo: 'example' })).status,
    ).toBe(403);
    expect(
      (await post({ jsonrpc: '2.0', id: 7, method: 'initialize' })).status,
    ).toBe(403);
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it('keeps actorless persisted run reads scoped and read-only and rejects missing runs', async () => {
    const run = await runFactory.create({ actingUserId: null });
    try {
      const target = app({
        tokenType: 'run',
        version: 1,
        runId: run.id,
        userId: null,
        principal: 'deployment',
      });
      expect(
        (await call('get_file_contents', { owner, repo: 'second' }, target))
          .status,
      ).toBe(200);
      expect(mocks.mint).toHaveBeenCalledExactlyOnceWith(
        {
          type: 'installationId',
          installationId: secondInstallation.id,
          repositoryIds: [secondRepository.githubRepoId],
        },
        appCredentials,
      );
      expect(
        new Headers(mocks.upstream.mock.calls[0]![1].headers).get(
          'X-MCP-Readonly',
        ),
      ).toBe('true');
      expect(
        (await call('update_pull_request', { ...args, repo: 'second' }, target))
          .status,
      ).toBe(403);
      await db.delete(taskRuns).where(eq(taskRuns.id, run.id));
      expect(
        (await call('get_file_contents', { owner, repo: 'second' }, target))
          .status,
      ).toBe(404);
      expect(mocks.mint).toHaveBeenCalledTimes(1);
    } finally {
      await db.delete(taskRuns).where(eq(taskRuns.id, run.id));
      await db.delete(tasks).where(eq(tasks.id, run.taskId));
    }
  });

  it('does not authorize a same-name repository on another provider', async () => {
    await db
      .update(repositories)
      .set({ sourceControlProvider: 'gitlab' })
      .where(eq(repositories.id, repository.id));
    expect((await call()).status).toBe(403);
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it.each([
    { isActive: false },
    { githubRepoId: -1 },
    { githubRepoId: 0 },
    { host: 'other.example' },
  ])('rejects inactive or invalid repository connection %j', async (update) => {
    await db
      .update(repositories)
      .set(update)
      .where(eq(repositories.id, repository.id));
    expect((await call()).status).toBe(403);
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it.each([{ suspendedAt: new Date() }, { appId: 456 }])(
    'rejects suspended or wrong-app installation %j',
    async (update) => {
      await db
        .update(githubInstallations)
        .set(update)
        .where(eq(githubInstallations.id, installation.id));
      expect((await call()).status).toBe(403);
      expect(mocks.mint).not.toHaveBeenCalled();
      expect(mocks.upstream).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    {},
    { issues: 'read', pull_requests: 'read' },
    { issues: 'write' },
    { pull_requests: 'write' },
  ])(
    'leaves live write permissions to GitHub despite stored permissions %j',
    async (permissions) => {
      await db
        .update(githubInstallations)
        .set({
          permissions: permissions === null ? sql`'null'::jsonb` : permissions,
        })
        .where(eq(githubInstallations.id, installation.id));
      for (const [name, fields] of writeCases) {
        const arguments_ = { owner, repo: 'example', ...fields };
        expect((await call(name, arguments_)).status).toBe(200);
        expect(mocks.mint).toHaveBeenLastCalledWith(
          {
            type: 'installationId',
            installationId: installation.id,
            repositoryIds: [repository.githubRepoId],
          },
          appCredentials,
        );
        expect(
          JSON.parse(mocks.upstream.mock.lastCall![1].body).params.arguments,
        ).toEqual(arguments_);
      }
    },
  );

  it('denies deleted actors and missing authentication without forwarding', async () => {
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, actor.id));
    expect((await call()).status).toBe(403);
    expect((await call('update_pull_request', args, app(null))).status).toBe(
      401,
    );
    expect(
      (
        await call(
          'update_pull_request',
          args,
          app({ tokenType: 'auth', version: 1, userId: crypto.randomUUID() }),
        )
      ).status,
    ).toBe(403);
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it('keeps run tokens read-only, including runs with a human actor', async () => {
    const run = await runFactory.create({ actingUserId: actor.id });
    try {
      const target = app({
        tokenType: 'run',
        version: 1,
        runId: run.id,
        userId: actor.id,
        principal: 'user',
      });
      expect((await call('update_pull_request', args, target)).status).toBe(
        403,
      );
      expect(mocks.mint).not.toHaveBeenCalled();
      expect(mocks.upstream).not.toHaveBeenCalled();
      mocks.upstream.mockResolvedValueOnce(
        Response.json({
          jsonrpc: '2.0',
          id: 7,
          result: {
            tools: [
              { name: 'pull_request_read' },
              { name: 'update_pull_request' },
            ],
          },
        }),
      );
      const response = await post(
        { jsonrpc: '2.0', id: 7, method: 'tools/list' },
        target,
      );
      expect(
        (await response.json()).result.tools.map(
          (tool: { name: string }) => tool.name,
        ),
      ).toEqual(['pull_request_read']);
      expect(
        new Headers(mocks.upstream.mock.calls[0]![1].headers).get(
          'X-MCP-Readonly',
        ),
      ).toBe('true');
    } finally {
      await db.delete(taskRuns).where(eq(taskRuns.id, run.id));
      await db.delete(tasks).where(eq(tasks.id, run.taskId));
    }
  });

  it.each(writeCases)(
    'preserves upstream permission failures for %s without retrying or escalating credentials',
    async (name, fields) => {
      await db
        .update(githubInstallations)
        .set({ permissions: sql`'null'::jsonb` })
        .where(eq(githubInstallations.id, installation.id));
      const error = {
        jsonrpc: '2.0',
        id: 7,
        error: {
          code: -32000,
          message: 'Resource not accessible by integration',
        },
      };
      mocks.upstream.mockResolvedValueOnce(
        Response.json(error, { status: 403 }),
      );
      const response = await call(name, { owner, repo: 'example', ...fields });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(error);
      expect(mocks.mint).toHaveBeenCalledTimes(1);
      expect(mocks.upstream).toHaveBeenCalledTimes(1);
    },
  );

  it('audits trusted metadata without logging forwarded argument names or comment text', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const arguments_ = {
      owner,
      repo: 'example',
      issue_number: 42,
      body: 'private-comment-text',
      'sensitive-caller-controlled-key': 'private-value',
    };
    try {
      const response = await call('add_issue_comment', arguments_);
      expect(response.status).toBe(200);
      expect(
        JSON.parse(mocks.upstream.mock.calls[0]![1].body).params.arguments,
      ).toEqual(arguments_);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('github_mcp_write_authorized'),
      );
      const audit = JSON.parse(log.mock.calls[0]![0]);
      expect(audit).toMatchObject({
        userId: actor.id,
        repositoryId: repository.id,
        installationId: installation.installationId,
        tool: 'add_issue_comment',
        targetNumber: 42,
      });
      expect(audit).not.toHaveProperty('fields');
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        'sensitive-caller-controlled-key',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-value');
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        'private-comment-text',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('scoped-test-token');
    } finally {
      log.mockRestore();
    }
  });

  it('omits nonnumeric audit IDs without rejecting or logging their payloads', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const arguments_ = {
      owner,
      repo: 'example',
      pullNumber: { private: 'private-target-payload' },
      commentId: 'private-comment-id',
      reaction: 'eyes',
    };
    try {
      const error = {
        jsonrpc: '2.0',
        id: 7,
        error: { code: -32602, message: 'Invalid commentId' },
      };
      mocks.upstream.mockResolvedValueOnce(Response.json(error));
      const response = await call(
        'add_reply_to_pull_request_comment',
        arguments_,
      );
      expect(await response.json()).toEqual(error);
      expect(
        JSON.parse(mocks.upstream.mock.calls[0]![1].body).params.arguments,
      ).toEqual(arguments_);
      const audit = JSON.parse(log.mock.calls[0]![0]);
      expect(audit).not.toHaveProperty('targetNumber');
      expect(audit).not.toHaveProperty('commentId');
      expect(audit).not.toHaveProperty('fields');
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        'private-target-payload',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        'private-comment-id',
      );
    } finally {
      log.mockRestore();
    }
  });

  const publicTarget = { owner: 'public-owner', repo: 'public-repository' };
  const publicRoot =
    'https://api.github.com/repos/public-owner/public-repository';
  function publicMetadata() {
    return Response.json({
      private: false,
      full_name: 'public-owner/public-repository',
    });
  }

  it.each(['inactive', 'uninstalled'])(
    'discovers native read contracts with %s repositories and no app credentials',
    async (connectionState) => {
      await db.transaction(async (tx) => {
        for (const repo of [repository, secondRepository]) {
          if (connectionState === 'inactive')
            await tx
              .update(repositories)
              .set({ isActive: false })
              .where(eq(repositories.id, repo.id));
          else
            await tx.delete(repositories).where(eq(repositories.id, repo.id));
        }
        if (connectionState === 'uninstalled') {
          for (const installed of [installation, secondInstallation])
            await tx
              .delete(githubInstallations)
              .where(eq(githubInstallations.id, installed.id));
        }
      });
      mocks.credentials.mockRejectedValue(
        new Error('No GitHub App configured'),
      );
      mocks.tryCredentials.mockResolvedValue(null);
      const run = await runFactory.create({ actingUserId: actor.id });
      try {
        const initialized = await post({
          jsonrpc: '2.0',
          id: 'init',
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          },
        });
        expect(await initialized.json()).toMatchObject({
          id: 'init',
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
          },
        });
        expect(
          (await post({ jsonrpc: '2.0', method: 'notifications/initialized' }))
            .status,
        ).toBe(202);
        const response = await post({
          jsonrpc: '2.0',
          id: 'list',
          method: 'tools/list',
        });
        const tools = (await response.json()).result.tools;
        expect(tools).toEqual(githubPublicTools);
        expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
          'get_file_contents',
          'issue_read',
          'pull_request_read',
          'list_pull_requests',
          'search_pull_requests',
        ]);
        expect(
          tools.find(
            (tool: { name: string }) => tool.name === 'get_file_contents',
          ).inputSchema,
        ).toMatchObject({
          required: ['owner', 'repo'],
          properties: {
            path: { default: '/' },
            ref: { type: 'string' },
            sha: { type: 'string' },
          },
        });
        const restricted = await post(
          { jsonrpc: '2.0', id: 7, method: 'tools/list' },
          app(undefined, true, ['issue_read']),
        );
        expect((await restricted.json()).result.tools).toEqual([
          githubPublicTools.find((tool) => tool.name === 'issue_read'),
        ]);
        const localApp = new Hono<{ Variables: Variables }>();
        localApp.use('*', tokenAuthMiddleware());
        localApp.route('/github', createGithubMcp());
        const token = await createRunToken({
          runId: run.id,
          userId: actor.id,
          timeoutMs: 60_000,
        });
        const client = new Client({ name: 'public-github-test', version: '1' });
        try {
          await client.connect(
            new StreamableHTTPClientTransport(
              new URL('http://localhost/github'),
              {
                requestInit: { headers: { authorization: `Bearer ${token}` } },
                fetch: async (input, init) =>
                  localApp.request(new Request(input, init)),
              },
            ),
          );
          expect((await client.listTools()).tools).toEqual(githubPublicTools);
          mocks.publicFetch
            .mockResolvedValueOnce(publicMetadata())
            .mockResolvedValueOnce(Response.json({ title: 'Public issue' }));
          const result = await client.callTool({
            name: 'issue_read',
            arguments: { ...publicTarget, method: 'get', issue_number: 17 },
          });
          expect(result.content).toEqual([
            { type: 'text', text: '{"title":"Public issue"}' },
          ]);
        } finally {
          await client.close();
        }
        expect(mocks.credentials).not.toHaveBeenCalled();
        expect(mocks.mint).not.toHaveBeenCalled();
        expect(mocks.upstream).not.toHaveBeenCalled();
        expect(mocks.publicFetch).toHaveBeenCalledTimes(2);
      } finally {
        await db.delete(taskRuns).where(eq(taskRuns.id, run.id));
        await db.delete(tasks).where(eq(tasks.id, run.taskId));
        if (connectionState === 'uninstalled') {
          await db.transaction(async (tx) => {
            await tx
              .insert(githubInstallations)
              .values([installation, secondInstallation]);
            await tx
              .insert(repositories)
              .values([repository, secondRepository]);
          });
        } else {
          await db
            .update(repositories)
            .set({ isActive: true })
            .where(eq(repositories.id, secondRepository.id));
        }
      }
    },
  );

  it.each([
    ['issue_read', { method: 'get', issue_number: 17 }, '/issues/17'],
    [
      'issue_read',
      { method: 'get_comments', issue_number: 17 },
      '/issues/17/comments?page=1&per_page=30',
    ],
    [
      'issue_read',
      { method: 'get_sub_issues', issue_number: 17 },
      '/issues/17/sub_issues?page=1&per_page=30',
    ],
    [
      'issue_read',
      { method: 'get_labels', issue_number: 17 },
      '/issues/17/labels?page=1&per_page=30',
    ],
    ['pull_request_read', { method: 'get', pullNumber: 18 }, '/pulls/18'],
    [
      'pull_request_read',
      { method: 'get_files', pullNumber: 18, page: 2, perPage: 5 },
      '/pulls/18/files?page=2&per_page=5',
    ],
    [
      'pull_request_read',
      { method: 'get_reviews', pullNumber: 18 },
      '/pulls/18/reviews?page=1&per_page=30',
    ],
    [
      'pull_request_read',
      { method: 'get_comments', pullNumber: 18 },
      '/issues/18/comments?page=1&per_page=30',
    ],
    [
      'list_pull_requests',
      {
        state: 'closed',
        head: 'fork:fix/thing',
        base: 'main',
        sort: 'updated',
        direction: 'asc',
      },
      '/pulls?page=1&per_page=30&state=closed&head=fork%3Afix%2Fthing&base=main&sort=updated&direction=asc',
    ],
  ] as const)(
    'reads public %s %j with no installation token or caller headers',
    async (name, fields, suffix) => {
      mocks.publicFetch
        .mockResolvedValueOnce(publicMetadata())
        .mockResolvedValueOnce(Response.json({ evidence: 'public result' }));
      const response = await call(name, { ...publicTarget, ...fields });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        jsonrpc: '2.0',
        id: 7,
        result: {
          content: [{ type: 'text', text: '{"evidence":"public result"}' }],
        },
      });
      expect(mocks.publicFetch.mock.calls.map(([url]) => String(url))).toEqual([
        publicRoot,
        publicRoot + suffix,
      ]);
      for (const [, init] of mocks.publicFetch.mock.calls) {
        expect(init.method).toBe('GET');
        expect(init.redirect).toBe('manual');
        expect(new Headers(init.headers).get('authorization')).toBeNull();
        expect(new Headers(init.headers).get('cookie')).toBeNull();
        expect(new Headers(init.headers).get('x-github-token')).toBeNull();
        expect(init.signal).toBeInstanceOf(AbortSignal);
      }
      expect(mocks.credentials).not.toHaveBeenCalled();
      expect(mocks.mint).not.toHaveBeenCalled();
      expect(mocks.upstream).not.toHaveBeenCalled();
    },
  );

  it('reads exact source paths with encoded ref, sha precedence, and no raw URL downloads', async () => {
    for (const [fields, query] of [
      [
        { ref: 'refs/heads/feature/source' },
        'ref=refs%2Fheads%2Ffeature%2Fsource',
      ],
      [
        { ref: 'refs/heads/feature/source', sha: 'a'.repeat(40) },
        `ref=${'a'.repeat(40)}`,
      ],
    ] as const) {
      mocks.publicFetch
        .mockResolvedValueOnce(publicMetadata())
        .mockResolvedValueOnce(
          Response.json({
            type: 'file',
            encoding: 'base64',
            content: Buffer.from('public source').toString('base64'),
            size: 13,
            sha: 'abc',
            download_url: 'https://private.example/secret',
          }),
        );
      const response = await call('get_file_contents', {
        ...publicTarget,
        path: '/src/file #1.ts',
        ...fields,
      });
      expect(response.status).toBe(200);
      expect((await response.json()).result.content[0].text).toBe(
        'File SHA: abc\npublic source',
      );
      expect(String(mocks.publicFetch.mock.lastCall![0])).toBe(
        `${publicRoot}/contents/src/file%20%231.ts?${query}`,
      );
    }
    expect(mocks.publicFetch).toHaveBeenCalledTimes(4);
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it('reads the repository root without inventing a file path', async () => {
    mocks.publicFetch
      .mockResolvedValueOnce(publicMetadata())
      .mockResolvedValueOnce(Response.json([{ name: 'src', type: 'dir' }]));
    const response = await call('get_file_contents', publicTarget);
    expect(response.status).toBe(200);
    expect(String(mocks.publicFetch.mock.lastCall![0])).toBe(
      `${publicRoot}/contents/`,
    );
    expect(JSON.parse((await response.json()).result.content[0].text)).toEqual([
      { name: 'src', type: 'dir' },
    ]);
  });

  it('reads PR diffs using the GitHub diff media type', async () => {
    mocks.publicFetch
      .mockResolvedValueOnce(publicMetadata())
      .mockResolvedValueOnce(new Response('diff --git a/x b/x'));
    const response = await call('pull_request_read', {
      ...publicTarget,
      pullNumber: 18,
      method: 'get_diff',
    });
    expect((await response.json()).result.content[0].text).toBe(
      'diff --git a/x b/x',
    );
    expect(
      new Headers(mocks.publicFetch.mock.lastCall![1].headers).get('accept'),
    ).toBe('application/vnd.github.diff');
  });

  it.each(['get_status', 'get_check_runs'])(
    'reads %s against the validated head SHA, never a returned URL',
    async (method) => {
      mocks.publicFetch
        .mockResolvedValueOnce(publicMetadata())
        .mockResolvedValueOnce(
          Response.json({
            head: {
              sha: 'a'.repeat(40),
              repo: { url: 'https://private.example' },
            },
          }),
        )
        .mockResolvedValueOnce(Response.json({ state: 'success' }));
      const response = await call('pull_request_read', {
        ...publicTarget,
        pullNumber: 18,
        method,
      });
      expect(response.status).toBe(200);
      expect(String(mocks.publicFetch.mock.lastCall![0])).toBe(
        `${publicRoot}/commits/${'a'.repeat(40)}/${method === 'get_status' ? 'status' : 'check-runs'}?page=1&per_page=30`,
      );
      expect(mocks.publicFetch).toHaveBeenCalledTimes(3);
    },
  );

  it('uses bounded anonymous repository-scoped PR search', async () => {
    mocks.publicFetch
      .mockResolvedValueOnce(publicMetadata())
      .mockResolvedValueOnce(
        Response.json({ total_count: 1, items: [{ number: 18 }] }),
      );
    const response = await call('search_pull_requests', {
      query: 'repo:public-owner/public-repository fix',
      page: 2,
      perPage: 5,
      sort: 'updated',
      order: 'desc',
    });
    expect(response.status).toBe(200);
    const url = mocks.publicFetch.mock.lastCall![0] as URL;
    expect(url.origin).toBe('https://api.github.com');
    expect(url.pathname).toBe('/search/issues');
    expect(url.searchParams.get('q')).toBe(
      'repo:public-owner/public-repository fix is:pr',
    );
    expect(url.searchParams.get('per_page')).toBe('5');
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it.each([
    { private: true },
    {},
    { private: 'false' },
    { private: false, full_name: 'different/repository' },
  ])(
    'rejects unconfirmed public visibility %j before the requested operation',
    async (metadata) => {
      mocks.publicFetch.mockResolvedValueOnce(Response.json(metadata));
      const response = await call('issue_read', {
        ...publicTarget,
        method: 'get',
        issue_number: 1,
      });
      expect(response.status).toBe(403);
      expect(mocks.publicFetch).toHaveBeenCalledTimes(1);
      expect(mocks.mint).not.toHaveBeenCalled();
      expect(mocks.upstream).not.toHaveBeenCalled();
    },
  );

  it.each([301, 302, 401, 403, 404, 429, 500])(
    'never retries public metadata HTTP %s with authentication',
    async (status) => {
      mocks.publicFetch.mockResolvedValueOnce(
        new Response('secret upstream detail', {
          status,
          headers: {
            location: 'https://private.example/redirect',
            'retry-after': '1',
          },
        }),
      );
      const response = await call('issue_read', {
        ...publicTarget,
        method: 'get',
        issue_number: 1,
      });
      expect(response.status).toBe(
        status >= 400 && status < 500 ? status : 502,
      );
      expect(await response.text()).not.toContain('secret upstream detail');
      expect(mocks.publicFetch).toHaveBeenCalledTimes(1);
      expect(mocks.credentials).not.toHaveBeenCalled();
      expect(mocks.mint).not.toHaveBeenCalled();
      expect(mocks.upstream).not.toHaveBeenCalled();
    },
  );

  it.each([302, 403, 404, 429, 500])(
    'never retries public operation HTTP %s or falls back to a default ref',
    async (status) => {
      mocks.publicFetch
        .mockResolvedValueOnce(publicMetadata())
        .mockResolvedValueOnce(new Response(null, { status }));
      const response = await call('get_file_contents', {
        ...publicTarget,
        path: 'missing',
        ref: 'missing-branch',
      });
      expect(response.status).toBe(
        status >= 400 && status < 500 ? status : 502,
      );
      expect(mocks.publicFetch).toHaveBeenCalledTimes(2);
      expect(mocks.mint).not.toHaveBeenCalled();
      expect(mocks.upstream).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['get_file_contents', { path: '../secret' }],
    ['get_file_contents', { path: 'src/../../secret' }],
    ['get_file_contents', { path: '%2e%2e/secret' }],
    ['get_file_contents', { path: '//api.example' }],
    ['get_file_contents', { path: 'src\\..\\secret' }],
    ['get_file_contents', { ref: 'main\nAuthorization: secret' }],
    ['get_file_contents', { ref: 'x?secret=true' }],
    ['get_file_contents', { ref: 'refs/heads/../secret' }],
    ['get_file_contents', { sha: 'x'.repeat(1025) }],
    ['issue_read', { method: 'get', issue_number: -1 }],
    ['issue_read', { method: 'get', issue_number: 1.5 }],
    ['issue_read', { method: 'get' }],
    ['issue_read', { method: 'delete', issue_number: 1 }],
    ['issue_read', { method: 'get', issue_number: 1, perPage: 101 }],
    ['issue_read', { method: 'get', issue_number: 1, page: 1001 }],
    ['issue_read', { method: 'get', issue_number: 1, page: 0 }],
    [
      'issue_read',
      { method: 'get', issue_number: 1, url: 'https://private.example' },
    ],
    ['pull_request_read', { method: 'get_review_comments', pullNumber: 18 }],
    ['list_pull_requests', { state: 'merged' }],
  ] as const)(
    'rejects unsupported or unsafe public %s arguments %j before HTTP',
    async (name, fields) => {
      const response = await call(name, { ...publicTarget, ...fields });
      expect(response.status).toBe(400);
      expect(mocks.publicFetch).not.toHaveBeenCalled();
      expect(mocks.mint).not.toHaveBeenCalled();
    },
  );

  it('reports anonymous code search as unsupported, not empty results', async () => {
    const response = await call('search_code', {
      query: 'repo:public-owner/public-repository fix',
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain(
      'code search is unsupported',
    );
    expect(mocks.publicFetch).not.toHaveBeenCalled();
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it.each(['declared', 'streamed', 'combined'])(
    'bounds %s response bytes and cancels oversized bodies',
    async (kind) => {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new Uint8Array(
              kind === 'combined' ? 2 * 1024 * 1024 - 1 : 2 * 1024 * 1024 + 1,
            ),
          );
        },
        cancel,
      });
      const oversized = new Response(body, {
        headers:
          kind === 'declared'
            ? { 'content-length': String(2 * 1024 * 1024 + 1) }
            : {},
      });
      if (kind === 'combined')
        mocks.publicFetch
          .mockResolvedValueOnce(publicMetadata())
          .mockResolvedValueOnce(oversized);
      else mocks.publicFetch.mockResolvedValueOnce(oversized);
      const response = await call('issue_read', {
        ...publicTarget,
        method: 'get',
        issue_number: 1,
      });
      expect(response.status).toBe(413);
      expect(cancel).toHaveBeenCalled();
      expect(mocks.publicFetch).toHaveBeenCalledTimes(
        kind === 'combined' ? 2 : 1,
      );
      expect(mocks.mint).not.toHaveBeenCalled();
    },
  );

  it('uses one deadline for metadata and the operation and sanitizes network errors', async () => {
    mocks.publicFetch
      .mockResolvedValueOnce(publicMetadata())
      .mockRejectedValueOnce(new Error('sensitive network details'));
    const response = await call('issue_read', {
      ...publicTarget,
      method: 'get',
      issue_number: 1,
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('sensitive network details');
    expect(mocks.publicFetch.mock.calls[0]![1].signal).toBe(
      mocks.publicFetch.mock.calls[1]![1].signal,
    );
    expect(mocks.publicFetch).toHaveBeenCalledTimes(2);
  });

  it.each(['headers', 'body'])(
    'aborts stalled public %s at the shared deadline without retry',
    async (phase) => {
      const deadline = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(deadline.signal);
      mocks.publicFetch.mockImplementationOnce(
        async (_url, init: RequestInit) => {
          const signal = init.signal!;
          setTimeout(
            () =>
              deadline.abort(
                new DOMException('Deadline exceeded', 'TimeoutError'),
              ),
            0,
          );
          if (phase === 'headers')
            return new Promise((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              }),
            );
          return new Response(
            new ReadableStream({
              start(controller) {
                signal.addEventListener(
                  'abort',
                  () => controller.error(signal.reason),
                  { once: true },
                );
              },
            }),
          );
        },
      );
      try {
        const response = await call('issue_read', {
          ...publicTarget,
          method: 'get',
          issue_number: 1,
        });
        expect(response.status).toBe(504);
        expect(timeout).toHaveBeenCalledWith(15_000);
        expect(mocks.publicFetch).toHaveBeenCalledTimes(1);
        expect(mocks.mint).not.toHaveBeenCalled();
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it.each([
    { isActive: false },
    { host: 'enterprise.example' },
    { sourceControlProvider: 'gitlab' as const },
  ])(
    'reads public github.com independently of an ineligible same-name connection %j',
    async (update) => {
      await db
        .update(repositories)
        .set(update)
        .where(eq(repositories.id, repository.id));
      mocks.publicFetch
        .mockResolvedValueOnce(
          Response.json({ private: false, full_name: `${owner}/example` }),
        )
        .mockResolvedValueOnce(Response.json({ title: 'Public issue' }));
      const response = await call('issue_read', {
        owner,
        repo: 'example',
        method: 'get',
        issue_number: 1,
      });
      expect(response.status).toBe(200);
      expect(mocks.credentials).not.toHaveBeenCalled();
      expect(mocks.mint).not.toHaveBeenCalled();
      expect(mocks.upstream).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed metadata and does not read source or retry', async () => {
    mocks.publicFetch.mockResolvedValueOnce(new Response('not-json'));
    expect((await call('get_file_contents', publicTarget)).status).toBe(502);
    expect(mocks.publicFetch).toHaveBeenCalledTimes(1);
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it('does not retry an authenticated connected read through the anonymous route', async () => {
    mocks.upstream.mockResolvedValueOnce(
      Response.json(
        { error: 'Resource not accessible by integration' },
        { status: 403 },
      ),
    );
    expect(
      (await call('get_file_contents', { owner, repo: 'example' })).status,
    ).toBe(403);
    expect(mocks.mint).toHaveBeenCalledTimes(1);
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
    expect(mocks.publicFetch).not.toHaveBeenCalled();
  });

  it('keeps connected private repository reads on their scoped installation credential', async () => {
    await db
      .update(repositories)
      .set({ private: true })
      .where(eq(repositories.id, repository.id));
    expect(
      (
        await call('issue_read', {
          owner,
          repo: 'example',
          method: 'get',
          issue_number: 1,
        })
      ).status,
    ).toBe(200);
    expect(mocks.mint).toHaveBeenCalledExactlyOnceWith(
      {
        type: 'installationId',
        installationId: installation.id,
        repositoryIds: [repository.githubRepoId],
      },
      appCredentials,
    );
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
    expect(mocks.publicFetch).not.toHaveBeenCalled();
  });

  it('denies public reads to missing, deleted, and actorless members', async () => {
    const arguments_ = { ...publicTarget, method: 'get', issue_number: 1 };
    for (const auth of [
      null,
      { tokenType: 'auth', version: 1, userId: crypto.randomUUID() },
      { tokenType: 'auth', version: 1, userId: '' },
    ] as const) {
      expect((await call('issue_read', arguments_, app(auth))).status).toBe(
        auth ? 403 : 401,
      );
    }
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, actor.id));
    expect((await call('issue_read', arguments_)).status).toBe(403);
    expect(mocks.publicFetch).not.toHaveBeenCalled();
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'supports public reads and discovery with signed run tokens but denies private reads and writes (human actor: %s)',
    async (human) => {
      const run = await runFactory.create({
        actingUserId: human ? actor.id : null,
      });
      try {
        const token = await createRunToken({
          runId: run.id,
          userId: human ? actor.id : null,
          timeoutMs: 60_000,
        });
        const target = new Hono<{ Variables: Variables }>();
        target.use('*', tokenAuthMiddleware());
        target.route('/github', createGithubMcp());
        const request = (method: string, params?: unknown) =>
          target.request('/github', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
          });
        mocks.tryCredentials.mockResolvedValue(null);
        expect((await request('initialize')).status).toBe(200);
        expect(
          (await (await request('tools/list')).json()).result.tools,
        ).toEqual(githubPublicTools);
        mocks.publicFetch
          .mockResolvedValueOnce(publicMetadata())
          .mockResolvedValueOnce(Response.json({ number: 1 }));
        const read = () =>
          request('tools/call', {
            name: 'issue_read',
            arguments: { ...publicTarget, method: 'get', issue_number: 1 },
          });
        expect((await read()).status).toBe(200);
        expect(mocks.publicFetch).toHaveBeenCalledTimes(2);
        for (const [, init] of mocks.publicFetch.mock.calls) {
          expect(new Headers(init.headers).has('authorization')).toBe(false);
        }
        mocks.tryCredentials.mockResolvedValue(appCredentials);
        mocks.publicFetch
          .mockResolvedValueOnce(publicMetadata())
          .mockResolvedValueOnce(Response.json({ number: 1 }));
        expect((await read()).status).toBe(200);
        mocks.publicFetch
          .mockReset()
          .mockResolvedValue(
            Response.json({ message: 'Not Found' }, { status: 404 }),
          );
        expect((await read()).status).toBe(404);
        expect(mocks.publicFetch).toHaveBeenCalledTimes(1);
        mocks.publicFetch.mockResolvedValueOnce(
          Response.json({
            private: true,
            full_name: 'public-owner/public-repository',
          }),
        );
        expect((await read()).status).toBe(403);
        mocks.publicFetch.mockClear();
        for (const [name, fields] of writeCases) {
          expect(
            (
              await request('tools/call', {
                name,
                arguments: { ...publicTarget, ...fields },
              })
            ).status,
          ).toBe(403);
        }
        expect(mocks.mint).not.toHaveBeenCalled();
        expect(mocks.publicFetch).not.toHaveBeenCalled();

        // A connected private target must stay on scoped installation auth,
        // including after an upstream denial or a credential-minting failure.
        mocks.tryCredentials.mockResolvedValue(appCredentials);
        await db
          .update(repositories)
          .set({ private: true })
          .where(eq(repositories.id, repository.id));
        mocks.upstream.mockResolvedValue(
          Response.json({ error: 'denied' }, { status: 403 }),
        );
        const connectedRead = () =>
          request('tools/call', {
            name: 'issue_read',
            arguments: {
              owner,
              repo: 'example',
              method: 'get',
              issue_number: 1,
            },
          });
        expect((await connectedRead()).status).toBe(403);
        expect(mocks.mint).toHaveBeenCalledExactlyOnceWith(
          {
            type: 'installationId',
            installationId: installation.id,
            repositoryIds: [repository.githubRepoId],
          },
          appCredentials,
        );
        expect(
          new Headers(mocks.upstream.mock.calls[0]![1].headers).get(
            'X-MCP-Readonly',
          ),
        ).toBe('true');
        mocks.mint.mockRejectedValueOnce(new Error('installation denied'));
        expect((await connectedRead()).status).toBe(500);
        expect(mocks.upstream).toHaveBeenCalledTimes(1);
        expect(mocks.publicFetch).not.toHaveBeenCalled();

        if (human) {
          await db
            .update(users)
            .set({ deletedAt: new Date() })
            .where(eq(users.id, actor.id));
          expect((await read()).status).toBe(401);
          await db
            .update(users)
            .set({ deletedAt: null })
            .where(eq(users.id, actor.id));
          expect(mocks.publicFetch).not.toHaveBeenCalled();
        }
        await db.delete(taskRuns).where(eq(taskRuns.id, run.id));
        expect((await read()).status).toBe(404);
        expect((await request('tools/list')).status).toBe(404);
        expect(mocks.publicFetch).not.toHaveBeenCalled();
      } finally {
        await db.delete(taskRuns).where(eq(taskRuns.id, run.id));
        await db.delete(tasks).where(eq(tasks.id, run.taskId));
      }
    },
  );

  it('enforces endpoint policy before anonymous reads and writes', async () => {
    expect(
      (
        await call(
          'issue_read',
          { ...publicTarget, method: 'get', issue_number: 1 },
          app(undefined, true, ['get_file_contents']),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call('issue_write', {
          ...publicTarget,
          method: 'create',
          title: 'write',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('add_issue_comment', {
          ...publicTarget,
          issue_number: 1,
          body: 'write',
        })
      ).status,
    ).toBe(403);
    expect(mocks.publicFetch).not.toHaveBeenCalled();
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it('runs the local response hook only after per-request proxy policy', async () => {
    const handler = vi.fn(async () =>
      Response.json({ jsonrpc: '2.0', id: 7, result: {} }),
    );
    const target = new Hono<{ Variables: Variables }>();
    target.use('*', async (c, next) => {
      c.set('authContext', { tokenType: 'auth', version: 1, userId: actor.id });
      await next();
    });
    target.route(
      '/github',
      createMcpProxy({
        name: 'test-local',
        allowAuthTokens: true,
        allowedToolNames: ['issue_read'],
        resolveCredentials: async () => ({
          authHeader: null,
          disabledToolNames: ['issue_read'],
          localResponse: handler,
        }),
      }),
    );
    expect(
      (
        await call(
          'issue_read',
          { ...publicTarget, method: 'get', issue_number: 1 },
          target,
        )
      ).status,
    ).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([null, { appId: '999', privateKey: 'other-app-key' }])(
    'ignores stale wrong-App connections for public discovery and targets with configuration %j',
    async (credentials) => {
      mocks.tryCredentials.mockResolvedValue(credentials);
      mocks.credentials.mockRejectedValue(
        new Error('Throwing resolver must not be used for public reads'),
      );
      expect(
        (await post({ jsonrpc: '2.0', id: 7, method: 'initialize' })).status,
      ).toBe(200);
      const discovered = await post({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/list',
      });
      expect((await discovered.json()).result.tools).toEqual(githubPublicTools);
      mocks.publicFetch
        .mockResolvedValueOnce(
          Response.json({ private: false, full_name: `${owner}/example` }),
        )
        .mockResolvedValueOnce(Response.json({ title: 'Public issue' }));
      expect(
        (
          await call('issue_read', {
            owner,
            repo: 'example',
            method: 'get',
            issue_number: 1,
          })
        ).status,
      ).toBe(200);
      expect(mocks.tryCredentials).toHaveBeenCalledTimes(3);
      expect(mocks.credentials).not.toHaveBeenCalled();
      expect(mocks.mint).not.toHaveBeenCalled();
      expect(mocks.upstream).not.toHaveBeenCalled();
      expect(mocks.publicFetch).toHaveBeenCalledTimes(2);
    },
  );

  it('propagates configuration lookup failures without public downgrade', async () => {
    mocks.tryCredentials.mockRejectedValue(
      new Error('Deployment lookup failed'),
    );
    expect(
      (
        await call('issue_read', {
          ...publicTarget,
          method: 'get',
          issue_number: 1,
        })
      ).status,
    ).toBe(500);
    expect(
      (await post({ jsonrpc: '2.0', id: 7, method: 'tools/list' })).status,
    ).toBe(500);
    expect(mocks.publicFetch).not.toHaveBeenCalled();
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it('preserves configuration lookup failures for writes and run-token reads', async () => {
    mocks.credentials.mockRejectedValue(
      new Error('GitHub App credentials are not configured.'),
    );
    const write = await call('add_issue_comment', {
      owner,
      repo: 'example',
      issue_number: 1,
      body: 'comment',
    });
    expect(write.status).toBe(500);
    expect((await write.json()).error.message).toContain(
      'GitHub App credentials are not configured.',
    );
    expect(mocks.tryCredentials).not.toHaveBeenCalled();
    mocks.tryCredentials.mockRejectedValue(
      new Error('Deployment lookup failed'),
    );
    const run = await runFactory.create({ actingUserId: actor.id });
    try {
      const target = app({
        tokenType: 'run',
        version: 1,
        runId: run.id,
        userId: actor.id,
        principal: 'user',
      });
      const response = await call(
        'get_file_contents',
        { owner, repo: 'example' },
        target,
      );
      expect(response.status).toBe(500);
      expect((await response.json()).error.message).toContain(
        'Deployment lookup failed',
      );
      expect(mocks.tryCredentials).toHaveBeenCalledTimes(1);
      expect(mocks.publicFetch).not.toHaveBeenCalled();
      expect(mocks.mint).not.toHaveBeenCalled();
    } finally {
      await db.delete(taskRuns).where(eq(taskRuns.id, run.id));
      await db.delete(tasks).where(eq(tasks.id, run.taskId));
    }
  });

  it.each([403, 429])(
    'explains anonymous HTTP %s rate limits and safe retry/reset headers without retrying',
    async (status) => {
      mocks.publicFetch
        .mockResolvedValueOnce(publicMetadata())
        .mockResolvedValueOnce(
          new Response('private upstream body', {
            status,
            headers: {
              'x-ratelimit-remaining': '0',
              'retry-after': '60',
              'x-ratelimit-reset': '2000000000',
            },
          }),
        );
      const response = await call('issue_read', {
        ...publicTarget,
        method: 'get',
        issue_number: 1,
      });
      expect(response.status).toBe(status);
      const message = (await response.json()).error.message;
      expect(message).toContain('GitHub rate limit reached');
      expect(message).toContain('outbound IP limit (normally 60 requests/hour');
      expect(message).toContain('Retry after 60 seconds');
      expect(message).toContain('2033-05-18T03:33:20.000Z');
      expect(message).not.toContain('private upstream body');
      expect(mocks.publicFetch).toHaveBeenCalledTimes(2);
      expect(mocks.mint).not.toHaveBeenCalled();
    },
  );

  it('does not echo unsafe rate-limit headers or misclassify an ordinary 403', async () => {
    mocks.publicFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 403,
        headers: {
          'retry-after': 'secret-value',
          'x-ratelimit-reset': '999999999999999999999',
        },
      }),
    );
    const response = await call('issue_read', {
      ...publicTarget,
      method: 'get',
      issue_number: 1,
    });
    const message = (await response.json()).error.message;
    expect(message).toContain('may be denying access or applying a rate limit');
    expect(message).not.toContain('secret-value');
    expect(message).not.toContain('999999999999999999999');
    expect(mocks.publicFetch).toHaveBeenCalledTimes(1);
  });
});
