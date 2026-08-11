import { Hono } from 'hono';

import { type AuthTokenContext, type RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { launchTask } from '../launchTask';

const {
  mockEnqueueTask,
  mockEnvironmentsFindFirst,
  mockRepositoriesFindMany,
  mockTaskRunsFindFirst,
  mockSelectRows,
  mockResolveWorkspaceRepositoryProviders,
  mockGetMembershipRole,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
  mockEnvironmentsFindFirst: vi.fn(),
  mockRepositoriesFindMany: vi.fn(),
  mockTaskRunsFindFirst: vi.fn(),
  mockSelectRows: vi.fn(),
  mockResolveWorkspaceRepositoryProviders: vi.fn(),
  mockGetMembershipRole: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: (...args: unknown[]) => mockEnqueueTask(...args),
  DeploymentReadOnlyError: class DeploymentReadOnlyError extends Error {
    code = 'deployment_read_only';
  },
  resolveRequestedWorkKindDecision: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args) => ({ type: 'and', args })),
  eq: vi.fn((...args) => ({ type: 'eq', args })),
  inArray: vi.fn((...args) => ({ type: 'inArray', args })),
  environments: {},
  environmentRepositoryMappings: {},
  repositories: {},
  taskRuns: {},
  resolveWorkspaceRepositoryProviders: (...args: unknown[]) =>
    mockResolveWorkspaceRepositoryProviders(...args),
  db: {
    query: {
      environments: {
        findFirst: (...args: unknown[]) => mockEnvironmentsFindFirst(...args),
      },
      repositories: {
        findMany: (...args: unknown[]) => mockRepositoriesFindMany(...args),
      },
      taskRuns: {
        findFirst: (...args: unknown[]) => mockTaskRunsFindFirst(...args),
      },
    },
    select: () => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => Promise.resolve(mockSelectRows()),
      };
      return chain;
    },
  },
}));

vi.mock('../membership', () => ({
  getMembershipRole: (...args: unknown[]) => mockGetMembershipRole(...args),
}));

function createApp(authContext?: AuthTokenContext | RunTokenContext) {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    if (authContext) {
      c.set('authContext', authContext);
    }
    await next();
  });
  app.use('*', mcpAuthMiddleware);
  app.post('/tasks', launchTask);

  return app;
}

describe('launchTask', () => {
  const authContext: AuthTokenContext = {
    userId: 'user-1',
    tokenType: 'auth',
    version: 1,
  } as AuthTokenContext;

  beforeEach(() => {
    mockEnqueueTask.mockReset();
    mockEnvironmentsFindFirst.mockReset();
    mockEnvironmentsFindFirst.mockResolvedValue({ id: 'env-1' });
    mockRepositoriesFindMany.mockReset();
    mockTaskRunsFindFirst.mockReset();
    mockTaskRunsFindFirst.mockResolvedValue(undefined);
    mockSelectRows.mockReset();
    mockSelectRows.mockReturnValue([]);
    mockResolveWorkspaceRepositoryProviders.mockReset();
    mockResolveWorkspaceRepositoryProviders.mockResolvedValue({});
    mockGetMembershipRole.mockReset();
    mockGetMembershipRole.mockResolvedValue('org:admin');
  });

  it('returns the LaunchTaskResponse success envelope shape, not the raw Run row', async () => {
    // enqueueTask resolves with the Run DB row, which has `id` +
    // `taskId` but no `success`/`runId`/`error` envelope fields. The
    // handler must map this to the contract the worker MCP client expects.
    mockEnqueueTask.mockResolvedValue({ id: 99, taskId: 'task-new' });

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Investigate this' }),
      }),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json).toEqual({ success: true, runId: 99, taskId: 'task-new' });
    // Guard against the regression: the raw row fields must not leak through.
    expect(json.id).toBeUndefined();
    expect(json.error).toBeUndefined();
  });

  it('maps read-only launch rejection to a stable 409 error', async () => {
    const { DeploymentReadOnlyError } =
      await import('@roomote/cloud-agents/server');
    mockEnqueueTask.mockRejectedValue(new DeploymentReadOnlyError());

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Investigate this' }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'deployment_read_only',
    });
  });

  it('stamps the source-control provider resolved from environment repositories into the payload', async () => {
    mockEnqueueTask.mockResolvedValue({ id: 100, taskId: 'task-gl' });
    mockResolveWorkspaceRepositoryProviders.mockResolvedValue({
      'group/project': 'gitlab',
    });

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Ship a GitLab change',
          environmentId: '6f1f3f0a-9f5e-4d2a-8f4e-1a2b3c4d5e6f',
        }),
      }),
    );

    expect(response.status).toBe(200);
    const enqueuedTask = mockEnqueueTask.mock.calls[0]?.[0] as {
      task: { payload: { sourceControlProvider?: string } };
    };
    expect(enqueuedTask.task.payload.sourceControlProvider).toBe('gitlab');
  });

  it('uses the first environment repository provider for mixed environments', async () => {
    mockEnqueueTask.mockResolvedValue({ id: 100, taskId: 'task-mixed' });
    mockResolveWorkspaceRepositoryProviders.mockResolvedValue({
      'octo/api': 'github',
      'group/web': 'gitlab',
    });

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Ship a mixed-provider change',
          environmentId: '6f1f3f0a-9f5e-4d2a-8f4e-1a2b3c4d5e6f',
        }),
      }),
    );

    expect(response.status).toBe(200);
    const enqueuedTask = mockEnqueueTask.mock.calls[0]?.[0] as {
      task: { payload: { sourceControlProvider?: string } };
    };
    expect(enqueuedTask.task.payload.sourceControlProvider).toBe('github');
  });

  it('leaves the provider unset for prompt-only launches with no repository context', async () => {
    mockEnqueueTask.mockResolvedValue({ id: 101, taskId: 'task-plain' });

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Investigate this' }),
      }),
    );

    expect(response.status).toBe(200);
    const enqueuedTask = mockEnqueueTask.mock.calls[0]?.[0] as {
      task: { payload: { sourceControlProvider?: string } };
    };
    expect(enqueuedTask.task.payload.sourceControlProvider).toBeUndefined();
  });

  it('stamps a requested reasoning effort and model override into the payload', async () => {
    mockEnqueueTask.mockResolvedValue({ id: 103, taskId: 'task-effort' });

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Investigate this',
          model: 'openrouter/z-ai/glm-5.2',
          reasoningEffort: 'xhigh',
        }),
      }),
    );

    expect(response.status).toBe(200);
    const enqueuedTask = mockEnqueueTask.mock.calls[0]?.[0] as {
      task: {
        payload: {
          reasoningEffort?: string;
          harnessModelOverrides?: Record<string, string>;
        };
      };
    };
    expect(enqueuedTask.task.payload.reasoningEffort).toBe('xhigh');
    expect(enqueuedTask.task.payload.harnessModelOverrides).toEqual({
      'opencode-server': 'openrouter/z-ai/glm-5.2',
    });
  });

  it('stamps a requested reasoning effort without a model override', async () => {
    mockEnqueueTask.mockResolvedValue({ id: 104, taskId: 'task-effort-only' });

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Investigate this',
          reasoningEffort: 'low',
        }),
      }),
    );

    expect(response.status).toBe(200);
    const enqueuedTask = mockEnqueueTask.mock.calls[0]?.[0] as {
      task: { payload: { reasoningEffort?: string } };
    };
    expect(enqueuedTask.task.payload.reasoningEffort).toBe('low');
  });

  it('stamps the launching run and settle opt-in for run-token launches with notifyOnSettle', async () => {
    mockEnqueueTask.mockResolvedValue({ id: 102, taskId: 'task-child' });

    const runAuth = {
      runId: 555,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    } as RunTokenContext;

    const app = createApp(runAuth);
    const response = await app.request(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Verify the environment',
          environmentId: '6f1f3f0a-9f5e-4d2a-8f4e-1a2b3c4d5e6f',
          notifyOnSettle: true,
        }),
      }),
    );

    expect(response.status).toBe(200);
    const enqueuedTask = mockEnqueueTask.mock.calls[0]?.[0] as {
      task: {
        sourceRunId?: number;
        payload: { notifySourceRunOnSettle?: boolean };
      };
    };
    expect(enqueuedTask.task.sourceRunId).toBe(555);
    expect(enqueuedTask.task.payload.notifySourceRunOnSettle).toBe(true);
  });

  it.each(['docker', 'modal'] as const)(
    'inherits the %s source run compute provider for run-token child launches',
    async (provider) => {
      mockEnqueueTask.mockResolvedValue({ id: 103, taskId: 'task-child' });
      mockTaskRunsFindFirst.mockResolvedValue({ vendor: provider });

      const runAuth = {
        runId: 555,
        userId: 'user-1',
        principal: 'user',
        tokenType: 'run',
        version: 1,
      } as RunTokenContext;

      const app = createApp(runAuth);
      const response = await app.request(
        new Request('http://localhost/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'Verify the environment' }),
        }),
      );

      expect(response.status).toBe(200);
      const enqueuedTask = mockEnqueueTask.mock.calls[0]?.[0] as {
        task: { computeProvider?: string };
      };
      expect(enqueuedTask.task.computeProvider).toBe(provider);
    },
  );

  it('preserves an explicit compute provider on run-token child launches', async () => {
    mockEnqueueTask.mockResolvedValue({ id: 104, taskId: 'task-child' });

    const runAuth = {
      runId: 556,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    } as RunTokenContext;

    const app = createApp(runAuth);
    const response = await app.request(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Verify the environment',
          computeProvider: 'modal',
        }),
      }),
    );

    expect(response.status).toBe(200);
    const enqueuedTask = mockEnqueueTask.mock.calls[0]?.[0] as {
      task: { computeProvider?: string };
    };
    expect(enqueuedTask.task.computeProvider).toBe('modal');
    expect(mockTaskRunsFindFirst).not.toHaveBeenCalled();
  });

  it('ignores notifyOnSettle for user-token launches', async () => {
    mockEnqueueTask.mockResolvedValue({ id: 103, taskId: 'task-user' });

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Investigate this',
          notifyOnSettle: true,
        }),
      }),
    );

    expect(response.status).toBe(200);
    const enqueuedTask = mockEnqueueTask.mock.calls[0]?.[0] as {
      task: {
        sourceRunId?: number;
        payload: { notifySourceRunOnSettle?: boolean };
      };
    };
    expect(enqueuedTask.task.sourceRunId).toBeUndefined();
    expect(enqueuedTask.task.payload.notifySourceRunOnSettle).toBeUndefined();
  });

  it('carries the parent pointer for context inheritance without stamping sourceRunId', async () => {
    mockEnqueueTask.mockResolvedValue({ id: 104, taskId: 'task-plain-child' });

    const runAuth = {
      runId: 556,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    } as RunTokenContext;

    const app = createApp(runAuth);
    const response = await app.request(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Investigate this' }),
      }),
    );

    expect(response.status).toBe(200);
    const enqueuedTask = mockEnqueueTask.mock.calls[0]?.[0] as {
      task: {
        sourceRunId?: number;
        communicationContextSourceRunId?: number;
        payload: { notifySourceRunOnSettle?: boolean };
      };
    };
    expect(enqueuedTask.task.sourceRunId).toBeUndefined();
    expect(enqueuedTask.task.communicationContextSourceRunId).toBe(556);
    expect(enqueuedTask.task.payload.notifySourceRunOnSettle).toBeUndefined();
  });

  it('allows selected repositories that span multiple providers', async () => {
    mockEnqueueTask.mockResolvedValue({ id: 105, taskId: 'task-mixed-set' });
    mockRepositoriesFindMany.mockResolvedValue([
      { fullName: 'octo/github-repo', installationId: 1 },
      { fullName: 'group/gitlab-repo', installationId: null },
    ]);
    mockResolveWorkspaceRepositoryProviders.mockResolvedValue({
      'octo/github-repo': 'github',
      'group/gitlab-repo': 'gitlab',
    });

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Ship a change',
          selectedRepositories: ['octo/github-repo', 'group/gitlab-repo'],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            selectedRepositories: ['octo/github-repo', 'group/gitlab-repo'],
            sourceControlProvider: 'github',
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it('rejects selected repositories whose source control is ambiguous', async () => {
    mockRepositoriesFindMany.mockResolvedValue([
      { fullName: 'group/project', installationId: null },
    ]);
    mockResolveWorkspaceRepositoryProviders.mockResolvedValue({});

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Ship a change',
          selectedRepositories: ['group/project'],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        'Could not unambiguously resolve source control for: group/project',
    });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('rejects admin-required launches for non-admin members', async () => {
    mockGetMembershipRole.mockResolvedValue('org:member');

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'environment-definition',
          prompt: 'Create an environment definition',
          selectedRepositories: ['octo/github-repo'],
        }),
      }),
    );

    expect(response.status).toBe(403);
    const json = (await response.json()) as { error: string };
    expect(json.error).toBe('Unauthorized');
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('allows non-admin members to launch standard tasks', async () => {
    mockGetMembershipRole.mockResolvedValue('org:member');
    mockEnqueueTask.mockResolvedValue({ id: 102, taskId: 'task-member' });

    const app = createApp(authContext);
    const response = await app.request(
      new Request('http://localhost/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Investigate this' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockEnqueueTask).toHaveBeenCalledTimes(1);
  });
});
