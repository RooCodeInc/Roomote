import { Hono } from 'hono';
import { generateKeyPairSync } from 'node:crypto';
import { configureAuthClientEnv } from '@roomote/auth/client';
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
  upstream: vi.fn(),
}));
vi.mock('@roomote/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/auth')>()),
  createGitHubToken: mocks.mint,
  resolveRuntimeGitHubAppCredentials: mocks.credentials,
}));
vi.mock('../../long-lived-fetch', () => ({
  fetchWithLongLivedStreamDispatcher: mocks.upstream,
}));

import { createGithubMcp } from '../github';

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
    mocks.mint.mockReset().mockResolvedValue('scoped-test-token');
    mocks.credentials.mockReset().mockResolvedValue(appCredentials);
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
    'excludes invalid read targets from the representative token scope %j',
    async (update) => {
      await db
        .update(repositories)
        .set(update)
        .where(eq(repositories.id, repository.id));
      mocks.upstream.mockImplementation(
        async () => new Response('Not Found', { status: 404 }),
      );
      for (const [name, arguments_] of [
        ['get_file_contents', { owner, repo: 'example' }],
        ['search_code', { query: `repo:${owner}/example fix` }],
        ['search_repositories', { query: `repo:${owner}/example` }],
      ] as const)
        expect((await call(name, arguments_)).status).toBe(404);
      expect(mocks.mint.mock.calls).toEqual(
        Array.from({ length: 3 }, () => [
          {
            type: 'installationId',
            installationId: secondInstallation.id,
            repositoryIds: [secondRepository.githubRepoId],
          },
          appCredentials,
        ]),
      );
      expect(mocks.upstream).toHaveBeenCalledTimes(3);
    },
  );

  it.each([{ suspendedAt: new Date() }, { appId: 456 }])(
    'excludes ineligible installations from reads and discovery %j',
    async (update) => {
      await db
        .update(githubInstallations)
        .set(update)
        .where(eq(githubInstallations.id, installation.id));
      mocks.upstream.mockResolvedValueOnce(
        new Response('Not Found', { status: 404 }),
      );
      expect(
        (await call('get_file_contents', { owner, repo: 'example' })).status,
      ).toBe(404);
      expect(mocks.mint).toHaveBeenCalledExactlyOnceWith(
        {
          type: 'installationId',
          installationId: secondInstallation.id,
          repositoryIds: [secondRepository.githubRepoId],
        },
        appCredentials,
      );
      expect(mocks.upstream).toHaveBeenCalledTimes(1);
      mocks.mint.mockClear();
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

  it('rejects unspecified reads without using the discovery credential', async () => {
    expect((await call('get_file_contents', {})).status).toBe(400);
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it('skips inactive repositories for discovery and rejects discovery when none remain connected', async () => {
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
      ).toBe(404);
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
  const publicFullName = `${publicTarget.owner}/${publicTarget.repo}`;

  it.each([
    ['get_file_contents', { ...publicTarget, path: 'README.md', ref: 'main' }],
    [
      'search_code',
      { query: `Hello repo:${publicFullName}`, perPage: 5, page: 2 },
    ],
    ['search_repositories', { query: `repo:${publicFullName}`, perPage: 5 }],
    [
      'search_pull_requests',
      { query: `repo:${publicFullName} is:open`, sort: 'updated' },
    ],
    [
      'pull_request_read',
      { ...publicTarget, method: 'get_review_comments', pullNumber: 42 },
    ],
    ['issue_read', { ...publicTarget, method: 'get', issue_number: 42 }],
  ])(
    'forwards unconnected %s with untouched native arguments and one scoped credential',
    async (name, arguments_) => {
      expect((await call(name as string, arguments_)).status).toBe(200);
      const expected =
        installation.id < secondInstallation.id
          ? { installation, repository }
          : { installation: secondInstallation, repository: secondRepository };
      expect(mocks.mint).toHaveBeenCalledExactlyOnceWith(
        {
          type: 'installationId',
          installationId: expected.installation.id,
          repositoryIds: [expected.repository.githubRepoId],
        },
        appCredentials,
      );
      expect(mocks.upstream).toHaveBeenCalledOnce();
      const init = mocks.upstream.mock.calls[0]![1] as RequestInit;
      expect(JSON.parse(init.body as string).params.arguments).toEqual(
        arguments_,
      );
      expect(new Headers(init.headers).get('X-MCP-Readonly')).toBe('true');
      expect(new Headers(init.headers).get('authorization')).toBe(
        'Bearer scoped-test-token',
      );
    },
  );

  it('accepts exactly 2 MiB of native JSON for an unconnected read', async () => {
    const output = 'x'.repeat(
      2 * 1024 * 1024 - JSON.stringify({ result: '' }).length,
    );
    mocks.upstream.mockResolvedValueOnce(Response.json({ result: output }));
    const response = await call('get_file_contents', publicTarget);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: output });
    expect(mocks.mint).toHaveBeenCalledOnce();
    expect(mocks.upstream).toHaveBeenCalledOnce();
  });

  it.each([
    ['application/json', 'declared'],
    ['application/json', 'missing length'],
    ['application/json', 'understated length'],
    ['text/event-stream', 'declared'],
    ['text/event-stream', 'missing length'],
    ['text/event-stream', 'understated length'],
  ])('bounds actual native bytes for %s (%s)', async (contentType, kind) => {
    const cancel = vi.fn().mockRejectedValue(new Error('cancel failed'));
    let reads = 0;
    // Multibyte text catches accidental character-count rather than byte limits.
    const chunk = new TextEncoder().encode('\u00e9'.repeat(256 * 1024));
    mocks.upstream.mockResolvedValueOnce(
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              reads++;
              controller.enqueue(chunk);
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
        {
          headers: {
            'content-type': contentType!,
            ...(kind === 'declared'
              ? { 'content-length': String(2 * 1024 * 1024 + 1) }
              : kind === 'understated length'
                ? { 'content-length': '1' }
                : {}),
          },
        },
      ),
    );
    const response = await call('get_file_contents', publicTarget);
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toContain('size limit');
    expect(reads).toBe(kind === 'declared' ? 0 : 5);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.upstream).toHaveBeenCalledOnce();
    expect(mocks.mint).toHaveBeenCalledOnce();
  });

  it('returns a normal native SSE reply without waiting for closure', async () => {
    const payload = { jsonrpc: '2.0', id: 7, result: { content: [] } };
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode(
      `data: ${JSON.stringify(payload)}\n\n`,
    );
    mocks.upstream.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 11));
            controller.enqueue(bytes.slice(11));
          },
          cancel,
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const response = await call('get_file_contents', publicTarget);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(['application/json', 'text/event-stream'])(
    'keeps the native 15-second deadline active through a stalled %s body',
    async (contentType) => {
      const abort = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValueOnce(abort.signal);
      const cancel = vi.fn();
      mocks.upstream.mockImplementationOnce(async (_url, init: RequestInit) => {
        expect(init.signal!.aborted).toBe(false);
        return new Response(
          new ReadableStream(
            {
              pull() {
                abort.abort(new DOMException('Timed out', 'TimeoutError'));
              },
              cancel,
            },
            { highWaterMark: 0 },
          ),
          { headers: { 'content-type': contentType } },
        );
      });
      try {
        const response = await call('get_file_contents', publicTarget);
        expect(response.status).toBe(502);
        expect((await response.json()).error.message).toContain('Timed out');
        expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000);
        expect(cancel).toHaveBeenCalledOnce();
        expect(mocks.upstream).toHaveBeenCalledOnce();
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it.each(['application/json', 'text/event-stream'])(
    'does not apply unconnected byte or deadline bounds to connected %s calls',
    async (contentType) => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      const payload = {
        jsonrpc: '2.0',
        id: 7,
        result: 'x'.repeat(2 * 1024 * 1024 + 1),
      };
      mocks.upstream.mockResolvedValueOnce(
        new Response(
          contentType === 'application/json'
            ? JSON.stringify(payload)
            : `data: ${JSON.stringify(payload)}\n\n`,
          { headers: { 'content-type': contentType } },
        ),
      );
      try {
        const response = await call('get_file_contents', {
          owner,
          repo: 'example',
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(payload);
        expect(timeout).not.toHaveBeenCalled();
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it.each(['application/json', 'text/event-stream'])(
    'fails closed on a native %s body error without retrying',
    async (contentType) => {
      mocks.upstream.mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error('Body failed'));
            },
          }),
          { headers: { 'content-type': contentType } },
        ),
      );
      const response = await call('get_file_contents', publicTarget);
      expect(response.status).toBe(502);
      expect((await response.json()).error.message).toContain('Body failed');
      expect(mocks.upstream).toHaveBeenCalledOnce();
    },
  );

  it('fails closed when unconnected SSE ends without a matching response', async () => {
    mocks.upstream.mockResolvedValueOnce(
      new Response('data: {"id":8,"result":{}}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const response = await call('get_file_contents', publicTarget);
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toContain('No matching');
    expect(mocks.upstream).toHaveBeenCalledOnce();
  });

  it('applies the unconnected native deadline before response headers arrive', async () => {
    const abort = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(abort.signal);
    mocks.upstream.mockImplementationOnce(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener(
            'abort',
            () => reject(init.signal!.reason),
            { once: true },
          );
          abort.abort(new DOMException('Timed out', 'TimeoutError'));
        }),
    );
    try {
      const response = await call('get_file_contents', publicTarget);
      expect(response.status).toBe(502);
      expect((await response.json()).error.message).toContain('Timed out');
      expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000);
      expect(mocks.upstream).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });

  it('requires configured App credentials for unconnected reads and discovery', async () => {
    mocks.credentials.mockRejectedValue(
      new Error('GitHub App credentials are not configured.'),
    );
    expect((await call('get_file_contents', publicTarget)).status).toBe(500);
    expect(
      (await post({ jsonrpc: '2.0', id: 7, method: 'tools/list' })).status,
    ).toBe(500);
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it('requires an eligible connected repository even for unconnected targets', async () => {
    mocks.credentials.mockResolvedValue({
      appId: '999999',
      privateKey: 'other-key',
    });
    expect((await call('get_file_contents', publicTarget)).status).toBe(404);
    expect(
      (await post({ jsonrpc: '2.0', id: 7, method: 'tools/list' })).status,
    ).toBe(404);
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it('propagates repository lookup errors without attempting unconnected access', async () => {
    const select = vi
      .spyOn(Object.getPrototypeOf(db.select().from(repositories)), 'limit')
      .mockImplementationOnce(() => {
        throw new Error('lookup failed');
      });
    try {
      expect((await call('get_file_contents', publicTarget)).status).toBe(500);
      expect(mocks.mint).not.toHaveBeenCalled();
      expect(mocks.upstream).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
    }
  });

  it('does not retry token mint failures through a different credential', async () => {
    mocks.mint.mockRejectedValueOnce(new Error('installation token denied'));
    expect((await call('get_file_contents', publicTarget)).status).toBe(500);
    expect(mocks.mint).toHaveBeenCalledOnce();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'never retries an upstream authorization denial (connected=%s)',
    async (connected) => {
      mocks.upstream.mockResolvedValueOnce(
        new Response('Denied', { status: 403 }),
      );
      expect(
        (
          await call(
            'get_file_contents',
            connected ? { owner, repo: 'example' } : publicTarget,
          )
        ).status,
      ).toBe(403);
      expect(mocks.mint).toHaveBeenCalledOnce();
      expect(mocks.upstream).toHaveBeenCalledOnce();
    },
  );

  it.each(['get_file_contents', 'search_repositories'])(
    'preserves upstream 404 for unconnected private %s without broad fallback or retry',
    async (name) => {
      const arguments_ =
        name === 'search_repositories'
          ? { query: `repo:${owner}/private-unconnected` }
          : { owner, repo: 'private-unconnected' };
      const error = { message: 'Not Found' };
      mocks.upstream.mockResolvedValueOnce(
        Response.json(error, { status: 404 }),
      );
      const response = await call(name, arguments_);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(error);
      const expected =
        installation.id < secondInstallation.id
          ? { installation, repository }
          : { installation: secondInstallation, repository: secondRepository };
      expect(mocks.mint).toHaveBeenCalledExactlyOnceWith(
        {
          type: 'installationId',
          installationId: expected.installation.id,
          repositoryIds: [expected.repository.githubRepoId],
        },
        appCredentials,
      );
      expect(mocks.upstream).toHaveBeenCalledOnce();
      const init = mocks.upstream.mock.calls[0]![1] as RequestInit;
      expect(JSON.parse(init.body as string).params.arguments).toEqual(
        arguments_,
      );
      expect(new Headers(init.headers).get('authorization')).toBe(
        'Bearer scoped-test-token',
      );
      expect(new Headers(init.headers).get('X-MCP-Readonly')).toBe('true');
    },
  );

  it('preserves connected private reads with a per-target token', async () => {
    await db
      .update(repositories)
      .set({ private: true })
      .where(eq(repositories.id, repository.id));
    expect(
      (await call('get_file_contents', { owner, repo: 'example' })).status,
    ).toBe(200);
    expect(mocks.mint).toHaveBeenCalledExactlyOnceWith(
      {
        type: 'installationId',
        installationId: installation.id,
        repositoryIds: [repository.githubRepoId],
      },
      appCredentials,
    );
  });

  it.each(writeCases)(
    'never permits unconnected %s writes',
    async (name, arguments_) => {
      expect(
        (await call(name, { ...arguments_, ...publicTarget })).status,
      ).toBe(403);
      expect(mocks.mint).not.toHaveBeenCalled();
      expect(mocks.upstream).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'keeps unconnected native search read-only for persisted runs (human=%s)',
    async (human) => {
      const run = await runFactory.create({
        actingUserId: human ? actor.id : null,
      });
      const target = app({
        tokenType: 'run',
        version: 1,
        runId: run.id,
        userId: human ? actor.id : null,
        principal: human ? 'user' : 'deployment',
      });
      const arguments_ = { query: `Hello repo:${publicFullName}`, perPage: 5 };
      try {
        expect((await call('search_code', arguments_, target)).status).toBe(
          200,
        );
        const init = mocks.upstream.mock.calls[0]![1] as RequestInit;
        expect(JSON.parse(init.body as string).params.arguments).toEqual(
          arguments_,
        );
        expect(new Headers(init.headers).get('X-MCP-Readonly')).toBe('true');
        expect(
          (
            await call(
              'add_issue_comment',
              { ...publicTarget, issue_number: 1, body: 'No write' },
              target,
            )
          ).status,
        ).toBe(403);
        await db.delete(taskRuns).where(eq(taskRuns.id, run.id));
        expect((await call('search_code', arguments_, target)).status).toBe(
          404,
        );
        expect(mocks.mint).toHaveBeenCalledOnce();
      } finally {
        await db.delete(taskRuns).where(eq(taskRuns.id, run.id));
        await db.delete(tasks).where(eq(tasks.id, run.taskId));
      }
    },
  );
});
