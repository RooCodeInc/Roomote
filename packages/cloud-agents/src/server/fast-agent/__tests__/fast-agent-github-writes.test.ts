import {
  db,
  eq,
  githubInstallationFactory,
  githubInstallations,
  githubUserMappings,
  repositories,
  repositoryFactory,
  userFactory,
  users,
} from '@roomote/db/server';

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  get: vi.fn(),
  permission: vi.fn(),
  update: vi.fn(),
  comment: vi.fn(),
}));
vi.mock('@roomote/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/auth')>()),
  createGitHubToken: mocks.token,
}));
vi.mock('@roomote/github', () => ({
  getOctokit: () => ({
    repos: { get: mocks.get, getCollaboratorPermissionLevel: mocks.permission },
    pulls: { update: mocks.update },
    issues: { createComment: mocks.comment },
  }),
}));

import {
  callFastGitHubWrite,
  FAST_GITHUB_WRITE_TOOLS,
} from '../fast-agent-github-writes';
import {
  getAllowedRouterMcpToolNames,
  getRouterMcpUpstreamConstraints,
} from '../../mcp-policy';

it('keeps deployment-wide GitHub MCP credentials read-only', () => {
  expect(getRouterMcpUpstreamConstraints('github')?.readonly).toBe(true);
  expect(getAllowedRouterMcpToolNames('github')).toEqual(
    expect.arrayContaining(['actions_get', 'actions_list', 'get_job_logs']),
  );
  for (const { name } of FAST_GITHUB_WRITE_TOOLS) {
    expect(getAllowedRouterMcpToolNames('github')).not.toContain(name);
  }
});

describe('Fast GitHub write authorization', () => {
  let userId: string;
  let installationId: string;
  let repositoryId: string;
  let githubRepoId: number;
  let githubUserId: number;
  let owner: string;
  const repo = 'repo';

  beforeEach(async () => {
    vi.resetAllMocks();
    const user = await userFactory.create();
    userId = user.id;
    owner = `test-${crypto.randomUUID()}`;
    const installation = await githubInstallationFactory.create({
      installedByUserId: userId,
    });
    installationId = installation.id;
    const repository = await repositoryFactory.create({
      installationId,
      linkedByUserId: userId,
      fullName: `${owner}/${repo}`,
    });
    repositoryId = repository.id;
    githubRepoId = repository.githubRepoId!;
    githubUserId = Math.floor(Math.random() * 1_000_000_000);
    await db
      .insert(githubUserMappings)
      .values({ userId, githubLogin: 'linked-user', githubUserId });
    mocks.token.mockResolvedValue('test-repo-token');
    mocks.get.mockResolvedValue({
      data: { id: githubRepoId, full_name: `${owner}/${repo}` },
    });
    mocks.permission.mockResolvedValue({
      data: { permission: 'write', user: { id: githubUserId } },
    });
    mocks.update.mockResolvedValue({
      data: {
        number: 17,
        html_url: 'https://github.com/example/repo/pull/17',
        state: 'closed',
        title: 'PR',
      },
    });
    mocks.comment.mockResolvedValue({
      data: {
        id: 23,
        html_url: 'https://github.com/example/repo/issues/17#issuecomment-23',
      },
    });
  });

  afterEach(async () => {
    await db.delete(repositories).where(eq(repositories.id, repositoryId));
    await db
      .delete(githubInstallations)
      .where(eq(githubInstallations.id, installationId));
    await db.delete(users).where(eq(users.id, userId));
  });

  function call(
    args: Record<string, unknown> = {},
    toolName = 'update_pull_request',
    actor = userId,
  ) {
    return callFastGitHubWrite({
      userId: actor,
      toolName,
      args: {
        owner,
        repo,
        ...(toolName === 'update_pull_request'
          ? { pullNumber: 17, state: 'closed' }
          : { issue_number: 17, body: 'Comment' }),
        ...args,
      },
      signal: new AbortController().signal,
    });
  }

  it('closes the requested PR using only its actual installation and repository', async () => {
    // A different active installation must never be selected as a fallback.
    const other = await githubInstallationFactory.create({
      installedByUserId: userId,
    });
    try {
      await expect(call()).resolves.toMatchObject({
        number: 17,
        state: 'closed',
      });
      expect(mocks.token).toHaveBeenCalledWith({
        type: 'installationId',
        installationId,
        repositoryIds: [githubRepoId],
      });
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          owner,
          repo,
          pull_number: 17,
          state: 'closed',
        }),
      );
      expect(mocks.permission).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'linked-user' }),
      );
    } finally {
      await db
        .delete(githubInstallations)
        .where(eq(githubInstallations.id, other.id));
    }
  });

  it.each(FAST_GITHUB_WRITE_TOOLS.map((tool) => tool.name))(
    'dispatches discovered tool %s',
    async (toolName) => {
      await call({}, toolName);
      expect(
        toolName === 'update_pull_request' ? mocks.update : mocks.comment,
      ).toHaveBeenCalledOnce();
    },
  );

  it('updates title/body and reopens without enabling base changes', async () => {
    await call({ state: 'open', title: 'New title', body: '' });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'open', title: 'New title', body: '' }),
    );
  });

  it.each([
    'inactive',
    'unconnected',
    'suspended',
    'missing-installation',
    'wrong-provider',
  ])('denies %s repository before minting credentials', async (state) => {
    if (state === 'suspended') {
      await db
        .update(githubInstallations)
        .set({ suspendedAt: new Date() })
        .where(eq(githubInstallations.id, installationId));
    } else if (state === 'missing-installation') {
      await db.delete(repositories).where(eq(repositories.id, repositoryId));
      await db
        .delete(githubInstallations)
        .where(eq(githubInstallations.id, installationId));
    } else {
      await db
        .update(repositories)
        .set(
          state === 'inactive'
            ? { isActive: false }
            : state === 'unconnected'
              ? { fullName: `${owner}/different` }
              : { sourceControlProvider: 'gitlab' },
        )
        .where(eq(repositories.id, repositoryId));
    }
    await expect(call()).rejects.toThrow('active connected repository');
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('denies a requester without a linked identity even when another user is linked', async () => {
    await expect(
      call({}, 'update_pull_request', 'unlinked-user'),
    ).rejects.toThrow('Link your GitHub account');
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it.each([
    { permission: 'read', user: { id: 0 } },
    { permission: 'read', user: { permissions: { push: false } } },
    { permission: 'write', user: { id: 0 } },
    { permission: 'write' },
  ])(
    'denies missing permission or a recycled GitHub login: %j',
    async (permission) => {
      mocks.permission.mockResolvedValue({
        data: {
          ...permission,
          ...(permission.user
            ? { user: { id: githubUserId, ...permission.user } }
            : {}),
        },
      });
      await expect(call()).rejects.toThrow('does not have write access');
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it('allows custom roles only with push permission on the verified identity', async () => {
    mocks.permission.mockResolvedValue({
      data: {
        permission: 'custom',
        user: { id: githubUserId, permissions: { push: true } },
      },
    });
    await call();
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it('denies a renamed/transferred or mismatched repository', async () => {
    mocks.get.mockResolvedValue({
      data: { id: githubRepoId + 1, full_name: `${owner}/${repo}` },
    });
    await expect(call()).rejects.toThrow('identity has changed');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 422, 500])(
    'fails closed on permission API HTTP %s',
    async (status) => {
      mocks.permission.mockRejectedValue(
        Object.assign(new Error('provider error'), { status }),
      );
      await expect(call()).rejects.toThrow(`HTTP ${status}`);
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it('reports App write permission errors without success or retry', async () => {
    mocks.update.mockRejectedValue(
      Object.assign(new Error('Resource not accessible by integration'), {
        status: 403,
      }),
    );
    await expect(call()).rejects.toThrow('write was not confirmed');
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it('rechecks live actor permission on every write', async () => {
    await call();
    mocks.permission.mockResolvedValue({
      data: { permission: 'read', user: { id: githubUserId } },
    });
    await expect(call()).rejects.toThrow('does not have write access');
    expect(mocks.permission).toHaveBeenCalledTimes(2);
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it('does not fall back to broader credentials when scoped token issuance fails', async () => {
    mocks.token.mockRejectedValue(new Error('Installation permission denied'));
    await expect(call()).rejects.toThrow('Installation permission denied');
    expect(mocks.token).toHaveBeenCalledOnce();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    { base: 'main' },
    { state: 'merged' },
    { pullNumber: -1 },
    { userId: 'other-user' },
    { body: 'x'.repeat(65_537) },
  ])(
    'rejects unsupported or unsafe arguments before credentials',
    async (args) => {
      await expect(call(args)).rejects.toThrow();
      expect(mocks.token).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown tools and cancelled writes', async () => {
    await expect(call({}, 'merge_pull_request')).rejects.toThrow(
      'not supported',
    );
    await expect(
      callFastGitHubWrite({
        userId,
        toolName: 'update_pull_request',
        args: { owner, repo, pullNumber: 17, state: 'closed' },
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(mocks.token).not.toHaveBeenCalled();
  });
});
