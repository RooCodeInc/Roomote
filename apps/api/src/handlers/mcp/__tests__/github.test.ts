import { Hono } from 'hono';
import {
  db,
  eq,
  githubInstallationFactory,
  githubInstallations,
  repositories,
  repositoryFactory,
  runFactory,
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
vi.mock('@roomote/auth', () => ({
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
  const appCredentials = { appId: '123', privateKey: 'test-only-key' };
  const owner = `bounded-${crypto.randomUUID()}`;
  const args = { owner, repo: 'example', pullNumber: 42, state: 'closed' };

  beforeAll(async () => {
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
        installationId: installation.id,
        host: 'github.com',
        githubRepoId: repository.githubRepoId,
        sourceControlProvider: 'github',
      })
      .where(eq(repositories.id, repository.id));
  });

  afterAll(async () => {
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
        ...(restrict
          ? { allowedToolNames: getAllowedRouterMcpToolNames('github') }
          : {}),
      }),
    );
    return hono;
  }

  function post(body: unknown, target = app()) {
    return target.request('/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
    [
      'add_issue_comment',
      { owner, repo: 'example', issue_number: 42, body: 'Comment' },
    ],
    [
      'add_reply_to_pull_request_comment',
      { owner, repo: 'example', pullNumber: 42, commentId: 12, body: 'Reply' },
    ],
  ])('forwards %s through the same scoped proxy', async (name, arguments_) => {
    expect((await call(name, arguments_)).status).toBe(200);
    expect(
      JSON.parse(mocks.upstream.mock.calls[0]![1].body).params.arguments,
    ).toEqual(arguments_);
  });

  it.each([
    'base',
    'draft',
    'maintainer_can_modify',
    'reviewers',
    'head',
    'merge',
    '_ui_submitted',
    'unknown',
  ])('rejects update field %s before minting or forwarding', async (field) => {
    expect(
      (await call('update_pull_request', { ...args, [field]: true })).status,
    ).toBe(400);
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it.each([
    { ...args, state: 'merged' },
    { ...args, pullNumber: 0 },
    { ...args, pullNumber: 1.5 },
    { ...args, owner: '../outside' },
    { ...args, repo: '..' },
    { ...args, repo: 'example/other' },
    { owner, repo: 'example', pullNumber: 42 },
    { ...args, title: null },
  ])('rejects malformed or empty updates: %j', async (arguments_) => {
    expect((await call('update_pull_request', arguments_)).status).toBe(400);
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it.each(['reaction', 'comment_id'])(
    'rejects non-comment action field %s',
    async (field) => {
      expect(
        (
          await call('add_issue_comment', {
            owner,
            repo: 'example',
            issue_number: 42,
            body: 'Comment',
            [field]: 'eyes',
          })
        ).status,
      ).toBe(400);
      expect(mocks.upstream).not.toHaveBeenCalled();
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

  it('filters discovery and removes all unsupported write arguments for JSON and SSE', async () => {
    const tools = [
      { name: 'get_file_contents', inputSchema: { type: 'object' } },
      ...[
        'update_pull_request',
        'add_issue_comment',
        'add_reply_to_pull_request_comment',
      ].map((name) => ({
        name,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            [
              'owner',
              'repo',
              'pullNumber',
              'title',
              'body',
              'state',
              'issue_number',
              'commentId',
              'reaction',
              'draft',
              'base',
              'reviewers',
              'maintainer_can_modify',
            ].map((field) => [field, { type: 'string' }]),
          ),
        },
      })),
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
      expect(visible.map((tool: { name: string }) => tool.name)).toEqual(
        tools.slice(0, 4).map((tool) => tool.name),
      );
      expect(Object.keys(visible[1].inputSchema.properties)).toEqual([
        'owner',
        'repo',
        'pullNumber',
        'title',
        'body',
        'state',
      ]);
      expect(Object.keys(visible[2].inputSchema.properties)).toEqual([
        'owner',
        'repo',
        'issue_number',
        'body',
      ]);
      expect(Object.keys(visible[3].inputSchema.properties)).toEqual([
        'owner',
        'repo',
        'pullNumber',
        'commentId',
        'body',
      ]);
      expect(visible[1].inputSchema.additionalProperties).toBe(false);
      expect(visible[2].inputSchema.required).toEqual([
        'owner',
        'repo',
        'issue_number',
        'body',
      ]);
    }
    expect(
      new Headers(mocks.upstream.mock.calls[0]![1].headers).get(
        'X-MCP-Readonly',
      ),
    ).toBe('false');
    expect(mocks.mint).toHaveBeenCalledWith({ type: 'activeInstallation' });
  });

  it('fails closed on an unparseable discovery response', async () => {
    mocks.upstream.mockResolvedValueOnce(new Response('not JSON'));
    expect(
      (await post({ jsonrpc: '2.0', id: 7, method: 'tools/list' })).status,
    ).toBe(502);
  });

  it('keeps ordinary reads upstream-readonly', async () => {
    expect(
      (await call('pull_request_read', { ...args, method: 'get' })).status,
    ).toBe(200);
    expect(mocks.mint).toHaveBeenCalledExactlyOnceWith({
      type: 'activeInstallation',
    });
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

  it.each([
    { suspendedAt: new Date() },
    { appId: 456 },
    { permissions: {} },
    { permissions: { pull_requests: 'read', issues: 'write' } },
  ])(
    'rejects suspended, wrong-app, or underprivileged installation %j',
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

  it('rejects comments without either issue or PR write permission', async () => {
    await db
      .update(githubInstallations)
      .set({ permissions: { issues: 'read', pull_requests: 'read' } })
      .where(eq(githubInstallations.id, installation.id));
    expect(
      (
        await call('add_issue_comment', {
          owner,
          repo: 'example',
          issue_number: 42,
          body: 'Comment',
        })
      ).status,
    ).toBe(403);
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it.each(['issues', 'pull_requests'])(
    'allows a top-level comment with %s write permission, leaving target permission enforcement to GitHub',
    async (permission) => {
      await db
        .update(githubInstallations)
        .set({ permissions: { [permission]: 'write' } })
        .where(eq(githubInstallations.id, installation.id));
      expect(
        (
          await call('add_issue_comment', {
            owner,
            repo: 'example',
            issue_number: 42,
            body: 'Comment',
          })
        ).status,
      ).toBe(200);
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

  it('preserves upstream permission failures without retrying or escalating credentials', async () => {
    const error = {
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: -32000,
        message: 'Resource not accessible by integration',
      },
    };
    mocks.upstream.mockResolvedValueOnce(Response.json(error, { status: 403 }));
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(error);
    expect(mocks.mint).toHaveBeenCalledTimes(1);
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
  });

  it('audits actor, repository, installation, operation and target without comment text', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await call('add_issue_comment', {
        owner,
        repo: 'example',
        issue_number: 42,
        body: 'private-comment-text',
      });
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
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        'private-comment-text',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('scoped-test-token');
    } finally {
      log.mockRestore();
    }
  });
});
