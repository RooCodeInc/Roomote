import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  users: vi.fn(),
  repositories: vi.fn(),
  githubInstallations: vi.fn(),
  environments: vi.fn(),
  githubUserMappings: vi.fn(),
  token: vi.fn(),
  get: vi.fn(),
  permission: vi.fn(),
  getContent: vi.fn(),
  listBranches: vi.fn(),
  listCommits: vi.fn(),
  getCommit: vi.fn(),
  list: vi.fn(),
  pullGet: vi.fn(),
  listFiles: vi.fn(),
  update: vi.fn(),
  checks: vi.fn(),
  statuses: vi.fn(),
  comments: vi.fn(),
  reviewComments: vi.fn(),
  reviews: vi.fn(),
  searchCode: vi.fn(),
  searchPrs: vi.fn(),
  startTask: vi.fn(),
}));
vi.mock('@roomote/auth', () => ({ createGitHubToken: mocks.token }));
vi.mock('@roomote/db/server', () => ({
  db: {
    query: Object.fromEntries(
      [
        'users',
        'repositories',
        'githubInstallations',
        'environments',
        'githubUserMappings',
      ].map((name) => [name, { findFirst: mocks[name as keyof typeof mocks] }]),
    ),
  },
  users: { id: 'user.id', deletedAt: 'user.deletedAt' },
  repositories: {
    fullName: 'repo.fullName',
    isActive: 'repo.active',
    sourceControlProvider: 'repo.provider',
  },
  githubInstallations: {
    id: 'installation.id',
    suspendedAt: 'installation.suspendedAt',
  },
  environments: { id: 'env.id', isEval: 'env.isEval' },
  githubUserMappings: { userId: 'mapping.userId' },
  eq: (...args: unknown[]) => ['eq', ...args],
  and: (...args: unknown[]) => ['and', ...args],
  isNull: (...args: unknown[]) => ['isNull', ...args],
}));
vi.mock('@roomote/github', () => ({
  getOctokit: () => ({
    repos: {
      get: mocks.get,
      getCollaboratorPermissionLevel: mocks.permission,
      getContent: mocks.getContent,
      listBranches: mocks.listBranches,
      listCommits: mocks.listCommits,
      getCommit: mocks.getCommit,
      getCombinedStatusForRef: mocks.statuses,
    },
    pulls: {
      list: mocks.list,
      get: mocks.pullGet,
      listFiles: mocks.listFiles,
      update: mocks.update,
      listReviewComments: mocks.reviewComments,
      listReviews: mocks.reviews,
    },
    checks: { listForRef: mocks.checks },
    issues: { listComments: mocks.comments },
    search: { code: mocks.searchCode, issuesAndPullRequests: mocks.searchPrs },
  }),
}));
vi.mock('@roomote/cloud-agents/server', () => ({ startTask: mocks.startTask }));
vi.mock('../proxy-utils', () => ({
  toMcpToolResult: (value: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify(value) }],
  }),
}));

import type { McpAuth } from '../middleware';
import { registerRoomoteRepositoryTools } from '../roomote-repository-tools';

type Result = { isError?: boolean; content: { text: string }[] };
type Tool = {
  name: string;
  config: {
    inputSchema: z.ZodType;
    annotations: Record<string, boolean>;
    description: string;
  };
  handler: (params: unknown) => Promise<Result>;
};
const auth = {
  userId: 'actor-1',
  authContext: { tokenType: 'auth', userId: 'actor-1' },
} as McpAuth;
const repository = {
  id: 'repo-1',
  fullName: 'acme/project',
  isActive: true,
  sourceControlProvider: 'github',
  installationId: 'installation-1',
  githubRepoId: 123,
  host: 'github.com',
};
const environmentId = 'c930762d-3280-46dc-92ea-c69226eed365';
const base = { repositoryFullName: 'acme/project' };
const write = { ...base, prNumber: 42, userIntent: 'Please close PR 42.' };
const newReads = [
  ['get_pull_request_checks', 'checks', { prNumber: 42 }],
  ['get_pull_request_comments', 'comments', { prNumber: 42 }],
  ['get_pull_request_review_comments', 'reviewComments', { prNumber: 42 }],
  ['get_pull_request_reviews', 'reviews', { prNumber: 42 }],
  ['search_code', 'searchCode', { searchTerms: 'Some_identifier foo.ts' }],
  ['search_pull_requests', 'searchPrs', { searchTerms: 'Fix bug' }],
] as const;
function tools(context = auth) {
  const registered: Tool[] = [];
  registerRoomoteRepositoryTools(
    {
      registerTool: (
        name: string,
        config: Tool['config'],
        handler: Tool['handler'],
      ) => registered.push({ name, config, handler }),
    } as unknown as McpServer,
    context,
  );
  return registered;
}
function call(
  params: Record<string, unknown>,
  name = 'read_repository',
  context = auth,
) {
  return tools(context)
    .find((tool) => tool.name === name)!
    .handler(params);
}

describe('member repository tools', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    mocks.users.mockResolvedValue({ id: 'actor-1', deletedAt: null });
    mocks.repositories.mockResolvedValue(repository);
    mocks.githubInstallations.mockResolvedValue({
      id: 'installation-1',
      suspendedAt: null,
    });
    mocks.environments.mockResolvedValue({
      isEval: false,
      config: { repositories: [{ repository: 'acme/project' }] },
    });
    mocks.githubUserMappings.mockResolvedValue({
      githubLogin: 'human',
      githubUserId: 99,
    });
    mocks.token.mockResolvedValue('secret-installation-token');
    mocks.get.mockResolvedValue({
      data: { id: 123, permissions: { admin: true } },
    });
    mocks.permission.mockResolvedValue({
      data: { permission: 'write', user: { id: 99 } },
    });
    for (const mock of [
      mocks.getContent,
      mocks.listBranches,
      mocks.listCommits,
      mocks.getCommit,
      mocks.list,
      mocks.pullGet,
      mocks.listFiles,
      mocks.update,
      mocks.checks,
      mocks.statuses,
      mocks.comments,
      mocks.reviewComments,
      mocks.reviews,
      mocks.searchCode,
      mocks.searchPrs,
    ])
      mock.mockResolvedValue({ data: { ok: true } });
    mocks.pullGet.mockResolvedValue({ data: { head: { sha: 'head-sha' } } });
  });
  afterEach(() => {
    expect(mocks.startTask).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('registers only bounded reads and two annotated narrow writes', () => {
    const registered = tools();
    expect(registered.map((tool) => tool.name)).toEqual([
      'read_repository',
      'rename_pull_request',
      'close_pull_request',
    ]);
    expect(registered.map((tool) => tool.config.annotations)).toEqual([
      {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    ]);
    for (const tool of registered.slice(1))
      expect(tool.config.description).toContain('actual explicit user request');
  });

  it('enforces strict schemas through the real MCP transport', async () => {
    const server = new McpServer({
      name: 'repository-tools-test',
      version: '1',
    });
    const client = new Client({ name: 'test-client', version: '1' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    registerRoomoteRepositoryTools(server, auth);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(3);
      expect(listed.tools[2]!.inputSchema.additionalProperties).toBe(false);
      expect(
        (
          await client.callTool({
            name: 'close_pull_request',
            arguments: { ...write, body: 'unsupported' },
          })
        ).isError,
      ).toBe(true);
      expect(mocks.token).not.toHaveBeenCalled();
      expect(
        (
          await client.callTool({
            name: 'read_repository',
            arguments: { ...base, action: 'get_repository' },
          })
        ).isError,
      ).not.toBe(true);
      expect(
        (
          await client.callTool({
            name: 'rename_pull_request',
            arguments: { ...write, title: 'Title' },
          })
        ).isError,
      ).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('queries current deployment membership and active non-eval scope without an environment owner filter', async () => {
    await call({ ...base, action: 'get_repository', environmentId });
    expect(mocks.users).toHaveBeenCalledWith({
      where: [
        'and',
        ['eq', 'user.id', 'actor-1'],
        ['isNull', 'user.deletedAt'],
      ],
      columns: { id: true, deletedAt: true },
    });
    expect(mocks.repositories).toHaveBeenCalledWith({
      where: [
        'and',
        ['eq', 'repo.fullName', 'acme/project'],
        ['eq', 'repo.active', true],
        ['eq', 'repo.provider', 'github'],
      ],
    });
    expect(mocks.environments).toHaveBeenCalledWith({
      where: [
        'and',
        ['eq', 'env.id', environmentId],
        ['eq', 'env.isEval', false],
      ],
      columns: { config: true, isEval: true },
    });
  });

  it.each([
    ['get_repository', 'get', {}],
    ['get_file', 'getContent', {}],
    ['get_file', 'getContent', { path: 'src/index.ts', ref: 'feature/test' }],
    ['list_branches', 'listBranches', {}],
    ['list_commits', 'listCommits', { path: 'src/index.ts', ref: 'main' }],
    ['get_commit', 'getCommit', { ref: 'abc123' }],
    ['list_pull_requests', 'list', { state: 'closed' }],
    ['get_pull_request', 'pullGet', { prNumber: 42 }],
    ['get_pull_request_files', 'listFiles', { prNumber: 42 }],
    ['get_pull_request_diff', 'pullGet', { prNumber: 42 }],
    ...newReads,
  ] as const)(
    'reads %s through the scoped GitHub API',
    async (action, method, extra) => {
      const result = await call({
        ...base,
        action,
        ...extra,
        environmentId,
        page: 2,
        perPage: 10,
      });
      expect(result.isError).not.toBe(true);
      expect(mocks[method as keyof typeof mocks]).toHaveBeenCalled();
      expect(mocks.token).toHaveBeenCalledWith({
        type: 'installationId',
        installationId: 'installation-1',
        repositoryIds: [123],
      });
      expect(mocks.permission).toHaveBeenCalledWith({
        owner: 'acme',
        repo: 'project',
        username: 'human',
      });
      expect(mocks.githubUserMappings).toHaveBeenCalledWith(
        expect.objectContaining({
          columns: { githubLogin: true, githubUserId: true },
        }),
      );
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it('passes pagination, path, ref and diff media type explicitly', async () => {
    await call({ ...base, action: 'get_file' });
    expect(mocks.getContent).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'project',
      path: '',
      ref: undefined,
    });
    await call({
      ...base,
      action: 'list_commits',
      page: 3,
      perPage: 7,
      path: 'src/a.ts',
      ref: 'feature/a',
    });
    expect(mocks.listCommits).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'project',
      page: 3,
      per_page: 7,
      path: 'src/a.ts',
      sha: 'feature/a',
    });
    await call({ ...base, action: 'get_pull_request_diff', prNumber: 42 });
    expect(mocks.pullGet).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'project',
      pull_number: 42,
      mediaType: { format: 'diff' },
    });
  });

  it.each(newReads)(
    'forwards exact scoped arguments for %s',
    async (action, method, extra) => {
      const result = await call({
        ...base,
        action,
        ...extra,
        page: 2,
        perPage: 7,
      });
      const pagination = { page: 2, per_page: 7 };
      const location = { owner: 'acme', repo: 'project' };
      const expected =
        action === 'search_code'
          ? { ...pagination, q: 'repo:acme/project Some_identifier foo.ts' }
          : action === 'search_pull_requests'
            ? { ...pagination, q: 'repo:acme/project is:pr state:open Fix bug' }
            : action === 'get_pull_request_checks'
              ? { ...location, ...pagination, ref: 'head-sha' }
              : {
                  ...location,
                  ...pagination,
                  [action === 'get_pull_request_comments'
                    ? 'issue_number'
                    : 'pull_number']: 42,
                };
      expect(mocks[method]).toHaveBeenCalledExactlyOnceWith(expected);
      if (action === 'get_pull_request_checks') {
        expect(mocks.pullGet).toHaveBeenCalledExactlyOnceWith({
          ...location,
          pull_number: 42,
        });
        expect(mocks.statuses).toHaveBeenCalledExactlyOnceWith(expected);
        expect(JSON.parse(result.content[0]!.text).result).toEqual({
          headSha: 'head-sha',
          checks: { ok: true },
          statuses: { ok: true },
        });
      } else {
        expect(JSON.parse(result.content[0]!.text).result).toEqual({
          ok: true,
        });
      }
    },
  );

  it.each(['closed', 'all'])('scopes PR search state %s', async (state) => {
    await call({
      ...base,
      action: 'search_pull_requests',
      searchTerms: 'fix',
      state,
    });
    expect(mocks.searchPrs).toHaveBeenCalledExactlyOnceWith({
      page: 1,
      per_page: 30,
      q: `repo:acme/project is:pr${state === 'all' ? '' : ' state:closed'} fix`,
    });
  });

  it.each(newReads)(
    'requires action-specific arguments for %s',
    async (action) => {
      expect((await call({ ...base, action })).isError).toBe(true);
      expect(mocks.token).not.toHaveBeenCalled();
    },
  );

  describe.each(['search_code', 'search_pull_requests'])(
    '%s query boundaries',
    (action) => {
      it.each([
        'repo:other/private',
        'foo OR bar',
        'foo and bar',
        'NOT foo',
        'foo | bar',
        'foo & bar',
        'foo (bar)',
        '"foo"',
        '-foo',
        'foo\nbar',
        'foo\tbar',
        'foo\\bar',
        'foo/bar',
        'foo%3Abar',
        'foo：bar',
        '',
        ' ',
        'x'.repeat(201),
        Array(11).fill('word').join(' '),
      ])('rejects syntax %j', async (searchTerms) => {
        expect((await call({ ...base, action, searchTerms })).isError).toBe(
          true,
        );
        expect(mocks.token).not.toHaveBeenCalled();
      });
      it.each([
        { page: 11, perPage: 100 },
        { q: 'repo:other/private' },
        { query: 'anything' },
        { owner: 'other' },
        { state: 'open OR repo:other/private' },
      ])('rejects escape or excessive pagination %j', async (extra) => {
        expect(
          (await call({ ...base, action, searchTerms: 'fix', ...extra }))
            .isError,
        ).toBe(true);
        expect(mocks.token).not.toHaveBeenCalled();
      });
      it('allows the last bounded page', async () => {
        expect(
          (
            await call({
              ...base,
              action,
              searchTerms: 'fix',
              page: 10,
              perPage: 100,
            })
          ).isError,
        ).not.toBe(true);
      });
    },
  );

  describe.each(newReads)(
    '%s authorization and failures',
    (action, method, extra) => {
      it.each(['actor', 'repository', 'environment', 'permission', 'run'])(
        'denies %s before action dispatch',
        async (denial) => {
          if (denial === 'actor') mocks.users.mockResolvedValue(undefined);
          if (denial === 'repository')
            mocks.repositories.mockResolvedValue({
              ...repository,
              isActive: false,
            });
          if (denial === 'environment')
            mocks.environments.mockResolvedValue(undefined);
          if (denial === 'permission')
            mocks.permission.mockResolvedValue({
              data: { permission: 'none', user: { id: 99 } },
            });
          const context =
            denial === 'run'
              ? ({ ...auth, authContext: { tokenType: 'run' } } as McpAuth)
              : auth;
          expect(
            (
              await call(
                { ...base, action, ...extra, environmentId },
                'read_repository',
                context,
              )
            ).isError,
          ).toBe(true);
          for (const [, providerMethod] of newReads)
            expect(mocks[providerMethod]).not.toHaveBeenCalled();
          expect(mocks.pullGet).not.toHaveBeenCalled();
          expect(mocks.statuses).not.toHaveBeenCalled();
          if (denial !== 'permission')
            expect(mocks.token).not.toHaveBeenCalled();
        },
      );
      it('sanitizes provider errors', async () => {
        mocks[method].mockRejectedValue(
          Object.assign(new Error('secret-token'), { status: 422 }),
        );
        const result = await call({ ...base, action, ...extra });
        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain(
          'GitHub request failed (HTTP 422).',
        );
        expect(
          JSON.stringify([result, vi.mocked(console.info).mock.calls]),
        ).not.toContain('secret-token');
      });
    },
  );

  it.each(['pullGet', 'statuses'] as const)(
    'sanitizes checks prerequisite/status failure %s',
    async (method) => {
      mocks[method].mockRejectedValue(new Error('secret-token'));
      const result = await call({
        ...base,
        action: 'get_pull_request_checks',
        prNumber: 42,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Repository operation failed.');
      expect(
        JSON.stringify([result, vi.mocked(console.info).mock.calls]),
      ).not.toContain('secret-token');
    },
  );

  it('audits the exact intended rename title on failure', async () => {
    mocks.update.mockRejectedValue(new Error('provider failure'));
    await call(
      { ...write, title: 'Exact intended title' },
      'rename_pull_request',
    );
    for (const outcome of ['attempt', 'error']) {
      expect(console.info).toHaveBeenCalledWith(
        'roomote.repository_tool',
        expect.objectContaining({ title: 'Exact intended title', outcome }),
      );
    }
  });

  it.each(['rename_pull_request', 'close_pull_request'])(
    'executes only the exact %s update and audits it',
    async (name) => {
      const input =
        name === 'rename_pull_request'
          ? {
              ...write,
              title: 'New title',
              userIntent: 'Rename PR 42 to New title.',
            }
          : write;
      expect((await call(input, name)).isError).not.toBe(true);
      expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
        owner: 'acme',
        repo: 'project',
        pull_number: 42,
        ...(name === 'rename_pull_request'
          ? { title: 'New title' }
          : { state: 'closed' }),
      });
      for (const outcome of ['attempt', 'success'])
        expect(console.info).toHaveBeenCalledWith(
          'roomote.repository_tool',
          expect.objectContaining({
            actor: 'actor-1',
            repository: 'acme/project',
            environmentId: null,
            prNumber: 42,
            action: name,
            userIntent: input.userIntent,
            ...(name === 'rename_pull_request' ? { title: 'New title' } : {}),
            outcome,
          }),
        );
    },
  );

  it.each([
    { ...auth, userId: undefined },
    { ...auth, authContext: { tokenType: 'run' } } as McpAuth,
  ])(
    'rejects missing actor or run auth before DB/provider access',
    async (context) => {
      expect(
        (
          await call(
            { ...base, action: 'get_repository' },
            'read_repository',
            context,
          )
        ).isError,
      ).toBe(true);
      expect(mocks.users).not.toHaveBeenCalled();
      expect(mocks.token).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['users', undefined],
    ['users', { id: 'actor-1', deletedAt: new Date() }],
    ['repositories', undefined],
    ['repositories', { ...repository, isActive: false }],
    ['repositories', { ...repository, sourceControlProvider: 'gitlab' }],
    ['repositories', { ...repository, githubRepoId: null }],
    ['repositories', { ...repository, installationId: null }],
    ['repositories', { ...repository, host: 'other.example' }],
    ['githubInstallations', undefined],
    ['githubInstallations', { suspendedAt: new Date() }],
    ['environments', undefined],
    ['environments', { isEval: true }],
    [
      'environments',
      {
        isEval: false,
        config: { repositories: [{ repository: 'acme/other' }] },
      },
    ],
    ['githubUserMappings', undefined],
    ['githubUserMappings', { githubLogin: '', githubUserId: 99 }],
  ])(
    'denies invalid %s configuration before minting credentials',
    async (name, value) => {
      mocks[name as keyof typeof mocks].mockResolvedValue(value);
      expect(
        (await call({ ...base, action: 'get_repository', environmentId }))
          .isError,
      ).toBe(true);
      expect(mocks.token).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it('rejects live repository identity mismatch before actor lookup or writes', async () => {
    mocks.get.mockResolvedValue({ data: { id: 456 } });
    expect((await call(write, 'close_pull_request')).isError).toBe(true);
    expect(mocks.permission).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([undefined, 100])(
    'rejects missing or mismatched immutable actor ID %s',
    async (id) => {
      mocks.permission.mockResolvedValue({
        data: { permission: 'admin', user: id ? { id } : undefined },
      });
      expect((await call(write, 'close_pull_request')).isError).toBe(true);
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it.each(['none', 'unknown', ''])(
    'does not mistake app permissions for actor read access (%s)',
    async (permission) => {
      mocks.permission.mockResolvedValue({
        data: { permission, user: { id: 99 } },
      });
      expect(
        (await call({ ...base, action: 'get_file', path: 'README.md' }))
          .isError,
      ).toBe(true);
      expect(mocks.getContent).not.toHaveBeenCalled();
    },
  );

  it.each(['read', 'pull', 'triage'])(
    'allows %s reads but denies writes',
    async (permission) => {
      mocks.permission.mockResolvedValue({
        data: { permission, user: { id: 99 } },
      });
      expect(
        (await call({ ...base, action: 'get_repository' })).isError,
      ).not.toBe(true);
      expect((await call(write, 'close_pull_request')).isError).toBe(true);
      expect(
        (await call({ ...write, title: 'Title' }, 'rename_pull_request'))
          .isError,
      ).toBe(true);
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it.each(['write', 'push', 'maintain', 'admin'])(
    'allows actor %s permission to write',
    async (permission) => {
      mocks.permission.mockResolvedValue({
        data: { permission, user: { id: 99 } },
      });
      expect((await call(write, 'close_pull_request')).isError).not.toBe(true);
    },
  );

  it.each(['token', 'get', 'permission', 'update'])(
    'sanitizes %s provider errors and audits failure',
    async (method) => {
      mocks[method as keyof typeof mocks].mockRejectedValue(
        Object.assign(new Error('secret-installation-token'), {
          status: 403,
          request: { authorization: 'secret' },
        }),
      );
      const result = await call(write, 'close_pull_request');
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('403');
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(
        'secret',
      );
      expect(console.info).toHaveBeenCalledWith(
        'roomote.repository_tool',
        expect.objectContaining({ outcome: 'error', status: 403 }),
      );
    },
  );

  it.each([
    { action: 'merge' },
    { action: 'delete' },
    { action: 'comment' },
    { perPage: 101 },
    { perPage: 0 },
    { page: 1001 },
    { page: 0 },
    { page: 1.5 },
    { repositoryFullName: 'https://github.com/acme/project' },
    { environmentId: '__all_repositories__' },
    { path: '../secret' },
    { path: '/absolute' },
    { path: 'a/../secret' },
    { path: 'a\\b' },
    { path: 'x'.repeat(1025) },
    { ref: '../main' },
    { ref: 'x'.repeat(256) },
    { ref: 'a\nb' },
    { prNumber: 0 },
    { action: 'get_commit' },
    { action: 'get_pull_request' },
    { unexpected: true },
  ])(
    'rejects invalid/unsupported read input %j without provider access',
    async (extra) => {
      expect(
        (await call({ ...base, action: 'get_repository', ...extra })).isError,
      ).toBe(true);
      expect(mocks.token).not.toHaveBeenCalled();
    },
  );

  it.each([
    { userIntent: undefined },
    { userIntent: ' ' },
    { userIntent: 'x'.repeat(2001) },
    { prNumber: -1 },
    { state: 'open' },
    { body: 'new body' },
    { merge: true },
  ])(
    'strict writes reject %j at schema and handler boundaries',
    async (extra) => {
      for (const name of ['rename_pull_request', 'close_pull_request']) {
        const params = {
          ...write,
          ...(name === 'rename_pull_request' ? { title: 'Title' } : {}),
          ...extra,
        };
        expect(
          tools()
            .find((tool) => tool.name === name)!
            .config.inputSchema.safeParse(params).success,
        ).toBe(false);
        expect((await call(params, name)).isError).toBe(true);
      }
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it.each(['', ' ', 'x'.repeat(257), 'a\nb'])(
    'rejects invalid title',
    async (title) => {
      expect(
        (await call({ ...write, title }, 'rename_pull_request')).isError,
      ).toBe(true);
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );
});
