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
  taskRuns,
  tasks,
  userFactory,
  users,
} from '@roomote/db/server';
import type { Variables } from '../../../types';

const mocks = vi.hoisted(() => ({
  mint: vi.fn(),
  credentials: vi.fn(),
  upstream: vi.fn(),
  octokit: vi.fn(),
  graphql: vi.fn(),
}));
vi.mock('@roomote/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/auth')>()),
  createGitHubToken: mocks.mint,
  resolveRuntimeGitHubAppCredentials: mocks.credentials,
}));
vi.mock('../../long-lived-fetch', () => ({
  fetchWithLongLivedStreamDispatcher: mocks.upstream,
}));
vi.mock('@roomote/github', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/github')>()),
  getOctokit: mocks.octokit,
}));

import { createGithubMcp } from '../github';
import { ENABLE_PULL_REQUEST_AUTO_MERGE_TOOL } from '../github-auto-merge';

describe('GitHub MCP native enable_pull_request_auto_merge', () => {
  let actor: Awaited<ReturnType<typeof userFactory.create>>;
  let installer: Awaited<ReturnType<typeof userFactory.create>>;
  let installation: Awaited<
    ReturnType<typeof githubInstallationFactory.create>
  >;
  let repository: Awaited<ReturnType<typeof repositoryFactory.create>>;
  const appCredentials = { appId: '123', privateKey: 'test-only-key' };
  const tokenCacheOptions = { cache: true, maxCacheAgeMs: 10 * 60_000 };
  const owner = `automerge-${crypto.randomUUID()}`;
  const repositoryFullName = `${owner}/example`;
  const headSha = 'a'.repeat(40);
  const otherHeadSha = 'b'.repeat(40);
  const args = {
    owner,
    repo: 'example',
    pullNumber: 42,
    expectedHeadSha: headSha,
  };

  function autoMergeTarget(overrides?: {
    repository?: Record<string, unknown>;
    pullRequest?: Record<string, unknown> | null;
  }) {
    return {
      repository: {
        autoMergeAllowed: true,
        mergeCommitAllowed: true,
        squashMergeAllowed: true,
        rebaseMergeAllowed: true,
        ...(overrides?.repository ?? {}),
        pullRequest:
          overrides?.pullRequest === null
            ? null
            : {
                id: 'PR_node_id',
                state: 'OPEN',
                merged: false,
                headRefOid: headSha,
                url: `https://github.com/${repositoryFullName}/pull/42`,
                autoMergeRequest: null,
                ...(overrides?.pullRequest ?? {}),
              },
      },
    };
  }

  /** Queue of GraphQL responses for the pre/post-mutation target reads. */
  let targetReads: unknown[];

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
      fullName: repositoryFullName,
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
    mocks.graphql.mockReset().mockImplementation(async (query: unknown) => {
      if (String(query).includes('EnablePullRequestAutoMerge')) {
        return {
          enablePullRequestAutoMerge: {
            pullRequest: { autoMergeRequest: { mergeMethod: 'SQUASH' } },
          },
        };
      }
      const next = targetReads.shift();
      return next ?? autoMergeTarget();
    });
    mocks.octokit.mockReset().mockReturnValue({ graphql: mocks.graphql });
    targetReads = [];
    await db
      .update(users)
      .set({ deletedAt: null })
      .where(eq(users.id, actor.id));
    await db
      .update(githubInstallations)
      .set({ suspendedAt: null, appId: 123 })
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
    configureAuthClientEnv(null);
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
  ) {
    const hono = new Hono<{ Variables: Variables }>();
    hono.use('*', async (c, next) => {
      if (auth) c.set('authContext', auth);
      await next();
    });
    hono.route('/github', createGithubMcp({ allowAuthTokens: true }));
    return hono;
  }

  function post(body: unknown, target = app()) {
    return target.request('/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function call(arguments_: unknown = args, target = app()) {
    return post(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: ENABLE_PULL_REQUEST_AUTO_MERGE_TOOL,
          arguments: arguments_,
        },
      },
      target,
    );
  }

  async function callAndParse(arguments_: unknown = args, target = app()) {
    const response = await call(arguments_, target);
    const body = (await response.json()) as {
      result?: {
        isError?: boolean;
        content?: { text: string }[];
        structuredContent?: Record<string, unknown>;
      };
      error?: { message: string };
    };
    return { response, body };
  }

  function listTools(target = app()) {
    return post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, target);
  }

  it('lists the tool for a member with the head-SHA contract in its schema', async () => {
    mocks.upstream.mockImplementation(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 3,
        result: { tools: [{ name: 'get_pull_request' }] },
      }),
    );
    const response = await listTools();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { tools: { name: string; inputSchema?: unknown }[] };
    };
    const tool = body.result.tools.find(
      (candidate) => candidate.name === ENABLE_PULL_REQUEST_AUTO_MERGE_TOOL,
    );
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool?.inputSchema)).toContain('expectedHeadSha');
  });

  it('hides the tool from a coding-task run token', async () => {
    mocks.upstream.mockImplementation(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 3,
        result: { tools: [{ name: 'get_pull_request' }] },
      }),
    );
    const run = await runFactory.create({ actingUserId: actor.id });
    try {
      const target = app({
        tokenType: 'run',
        version: 1,
        runId: run.id,
        userId: actor.id,
        principal: 'user',
      } as Variables['authContext']);
      const response = await listTools(target);
      const body = (await response.json()) as {
        result: { tools: { name: string }[] };
      };
      expect(
        body.result.tools.some(
          (tool) => tool.name === ENABLE_PULL_REQUEST_AUTO_MERGE_TOOL,
        ),
      ).toBe(false);
    } finally {
      await db.delete(taskRuns).where(eq(taskRuns.id, run.id));
      await db.delete(tasks).where(eq(tasks.id, run.taskId));
    }
  });

  it('requires a user-scoped auth token (explicit human intent)', async () => {
    const target = app({
      tokenType: 'run',
      version: 1,
      runId: 1,
      userId: actor.id,
      principal: 'user',
    } as Variables['authContext']);
    const { response, body } = await callAndParse(args, target);
    expect(response.status).toBe(403);
    expect(body.error?.message).toContain('user-scoped auth token');
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.graphql).not.toHaveBeenCalled();
  });

  it('requires an active connected repository', async () => {
    const { response, body } = await callAndParse({
      ...args,
      owner: 'not-connected',
    });
    expect(response.status).toBe(403);
    expect(body.error?.message).toContain(
      'Active connected GitHub repository required',
    );
    expect(mocks.graphql).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments before any provider call', async () => {
    const { body } = await callAndParse({ ...args, expectedHeadSha: 'abc123' });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain(
      `Invalid ${ENABLE_PULL_REQUEST_AUTO_MERGE_TOOL} arguments`,
    );
    expect(mocks.graphql).not.toHaveBeenCalled();
  });

  it('rejects a stale head instead of acting on a moved pull request', async () => {
    targetReads = [
      autoMergeTarget({ pullRequest: { headRefOid: otherHeadSha } }),
    ];
    const { body } = await callAndParse();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain(
      'not at the expected head SHA',
    );
    expect(
      mocks.graphql.mock.calls.some(([query]) =>
        String(query).includes('EnablePullRequestAutoMerge'),
      ),
    ).toBe(false);
  });

  it.each([
    [{ state: 'CLOSED' }, 'not open'],
    [{ state: 'OPEN', merged: true }, 'already merged'],
  ])('rejects a non-open pull request %o', async (pullRequest, message) => {
    targetReads = [autoMergeTarget({ pullRequest })];
    const { body } = await callAndParse();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain(message);
  });

  it('rejects when the repository does not allow auto-merge', async () => {
    targetReads = [
      autoMergeTarget({ repository: { autoMergeAllowed: false } }),
    ];
    const { body } = await callAndParse();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain(
      'does not allow auto-merge',
    );
  });

  it('rejects a merge method the repository does not allow', async () => {
    targetReads = [
      autoMergeTarget({ repository: { rebaseMergeAllowed: false } }),
    ];
    const { body } = await callAndParse({ ...args, mergeMethod: 'rebase' });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain(
      'does not allow the rebase merge method',
    );
  });

  it('propagates a provider permission failure from the mutation', async () => {
    targetReads = [autoMergeTarget()];
    mocks.graphql.mockImplementation(async (query: unknown) => {
      if (String(query).includes('EnablePullRequestAutoMerge')) {
        const error = new Error('GraphQL mutation failed') as Error & {
          errors: { message: string; type: string }[];
        };
        error.errors = [
          {
            message: 'Resource not accessible by integration',
            type: 'FORBIDDEN',
          },
        ];
        throw error;
      }
      return targetReads.shift() ?? autoMergeTarget();
    });
    const { body } = await callAndParse({ ...args, mergeMethod: 'squash' });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain(
      'Resource not accessible by integration',
    );
  });

  it('enables auto-merge, binds the mutation to the fresh head, verifies the post-read, and audits', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      targetReads = [
        autoMergeTarget(),
        autoMergeTarget({
          pullRequest: {
            autoMergeRequest: {
              mergeMethod: 'SQUASH',
              enabledAt: '2026-09-22T00:00:00Z',
              enabledBy: { login: 'roomote-app' },
            },
          },
        }),
      ];
      const { response, body } = await callAndParse({
        ...args,
        mergeMethod: 'squash',
      });
      expect(response.status).toBe(200);
      expect(body.result?.isError).toBeUndefined();
      expect(body.result?.structuredContent).toMatchObject({
        result: {
          repositoryFullName,
          pullRequestNumber: 42,
          headSha,
          alreadyEnabled: false,
          autoMerge: { enabled: true, mergeMethod: 'SQUASH' },
        },
      });
      expect(mocks.mint).toHaveBeenCalledExactlyOnceWith(
        {
          type: 'installationId',
          installationId: installation.id,
          repositoryIds: [repository.githubRepoId],
        },
        appCredentials,
        tokenCacheOptions,
      );
      const mutation = mocks.graphql.mock.calls.find(([query]) =>
        String(query).includes('EnablePullRequestAutoMerge'),
      );
      expect(mutation?.[1]).toEqual({
        pullRequestId: 'PR_node_id',
        mergeMethod: 'SQUASH',
      });
      expect(JSON.stringify(log.mock.calls)).toContain(
        'source_control_mcp_auto_merge_authorized',
      );
      expect(JSON.stringify(log.mock.calls)).toContain(repositoryFullName);
    } finally {
      log.mockRestore();
    }
  });

  it('reports an already-enabled pull request without mutating', async () => {
    targetReads = [
      autoMergeTarget({
        pullRequest: { autoMergeRequest: { mergeMethod: 'MERGE' } },
      }),
    ];
    const { body } = await callAndParse();
    expect(body.result?.isError).toBeUndefined();
    expect(body.result?.structuredContent).toMatchObject({
      result: { alreadyEnabled: true, autoMerge: { enabled: true } },
    });
    expect(
      mocks.graphql.mock.calls.some(([query]) =>
        String(query).includes('EnablePullRequestAutoMerge'),
      ),
    ).toBe(false);
  });

  it('fails when GitHub does not confirm auto-merge after the mutation', async () => {
    targetReads = [autoMergeTarget(), autoMergeTarget()];
    const { body } = await callAndParse();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('has not confirmed');
  });
});
