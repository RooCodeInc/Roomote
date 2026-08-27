import { RunStatus, TaskPayloadKind } from '@roomote/types';
import type { TaskRun } from '@roomote/db/server';

const {
  mockDecryptSecrets,
  mockEnvironmentVariablesFindMany,
  mockCreateTaskRunWorkerGitHubTokenWithMetadata,
  mockGetGitHubRateLimitRetryAfterMs,
  mockCreateTaskRunScopedGitLabTokens,
  mockCreateTaskRunGiteaCredentials,
  mockCreateTaskRunAdoCredentials,
  mockCreateTaskRunBitbucketCredentials,
  mockResolveSandboxModelRuntimeEnv,
  mockTaskRunsFindFirst,
  mockNotifySourceRunOnSettle,
  mockCaptureTaskSettled,
  mockFinishRun,
} = vi.hoisted(() => ({
  mockDecryptSecrets: vi.fn(),
  mockEnvironmentVariablesFindMany: vi.fn(),
  mockCreateTaskRunWorkerGitHubTokenWithMetadata: vi.fn(),
  mockGetGitHubRateLimitRetryAfterMs: vi.fn(),
  mockCreateTaskRunScopedGitLabTokens: vi.fn(),
  mockCreateTaskRunGiteaCredentials: vi.fn(),
  mockCreateTaskRunAdoCredentials: vi.fn(),
  mockCreateTaskRunBitbucketCredentials: vi.fn(),
  mockResolveSandboxModelRuntimeEnv: vi.fn(),
  mockTaskRunsFindFirst: vi.fn(),
  mockNotifySourceRunOnSettle: vi.fn(),
  mockCaptureTaskSettled: vi.fn(),
  mockFinishRun: vi.fn(),
}));

vi.mock('@roomote/db/encryption', () => ({
  decryptSecrets: (...args: unknown[]) => mockDecryptSecrets(...args),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      environmentVariables: {
        findMany: (...args: unknown[]) =>
          mockEnvironmentVariablesFindMany(...args),
      },
      taskRuns: {
        findFirst: (...args: unknown[]) => mockTaskRunsFindFirst(...args),
      },
    },
    select: () => ({
      from: () => ({
        where: async () => [],
      }),
    }),
    transaction: vi.fn(),
  },
  taskRuns: { id: 'taskRuns.id' },
  repositories: {
    fullName: 'repositories.fullName',
    sourceControlProvider: 'repositories.sourceControlProvider',
  },
  // Shared provider resolver: default to "unresolved" so unstamped payloads
  // fall through to the GitHub default. Provider-stamped payloads never reach
  // it. Individual tests override with mockResolvedValueOnce when needed.
  resolveWorkspaceSourceControlProvider: vi.fn(async () => undefined),
  resolveSandboxModelRuntimeEnv: (...args: unknown[]) =>
    mockResolveSandboxModelRuntimeEnv(...args),
  inArray: vi.fn(),
  markTaskStartParallelCountEndedAt: vi.fn(),
  resolveTaskAttribution: vi.fn(),
  stringifyDecryptedEnvVarValue: (value: unknown) => String(value),
  eq: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@roomote/github', () => ({
  createTaskRunWorkerGitHubTokenWithMetadata: (...args: unknown[]) =>
    mockCreateTaskRunWorkerGitHubTokenWithMetadata(...args),
  getGitHubRateLimitRetryAfterMs: (...args: unknown[]) =>
    mockGetGitHubRateLimitRetryAfterMs(...args),
}));

vi.mock('@roomote/gitlab', () => ({
  createTaskRunScopedGitLabTokens: (...args: unknown[]) =>
    mockCreateTaskRunScopedGitLabTokens(...args),
}));

vi.mock('@roomote/gitea', () => ({
  createTaskRunGiteaCredentials: (...args: unknown[]) =>
    mockCreateTaskRunGiteaCredentials(...args),
}));

vi.mock('@roomote/ado', () => ({
  createTaskRunAdoCredentials: (...args: unknown[]) =>
    mockCreateTaskRunAdoCredentials(...args),
}));

vi.mock('@roomote/bitbucket', () => ({
  createTaskRunBitbucketCredentials: (...args: unknown[]) =>
    mockCreateTaskRunBitbucketCredentials(...args),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  releaseTaskRun: vi.fn(),
}));

vi.mock('@roomote/telemetry/server', () => ({
  captureTaskSettled: (...args: unknown[]) => mockCaptureTaskSettled(...args),
}));

vi.mock('../notify-source-run-on-settle', () => ({
  notifySourceRunOnSettle: (...args: unknown[]) =>
    mockNotifySourceRunOnSettle(...args),
}));

vi.mock('../notify-fast-agent-parent-on-settle', () => ({
  notifyFastAgentParentOnSettle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../finish-run', () => ({
  finishRun: (...args: unknown[]) => mockFinishRun(...args),
}));

import { resolveWorkspaceSourceControlProvider } from '@roomote/db/server';

import {
  cancelAndReleaseTaskRun,
  createSourceControlTokenForTaskRun,
  fetchResolvedRuntimeEnvVars,
  notifyCanceledTaskRunOnSettle,
  redactControlPlaneEnvVars,
  redactSourceControlProviderEnvVars,
} from '../dequeue-helpers';

describe('cancelAndReleaseTaskRun', () => {
  it('uses the terminal finalizer so linked review artifacts cannot remain pending', async () => {
    const taskRun = {
      ...makeTaskRun({ repo: 'owner/repo' }),
      payloadKind: TaskPayloadKind.GithubPrReview,
    } as TaskRun;

    await cancelAndReleaseTaskRun(
      taskRun,
      'Failed to create source control token.',
    );

    expect(mockFinishRun).toHaveBeenCalledWith({
      id: taskRun.id,
      status: RunStatus.Canceled,
      error: 'Failed to create source control token.',
    });
  });
});

function makeTaskRun(payload: TaskRun['payload']): TaskRun {
  return {
    id: 123,
    status: RunStatus.Dequeued,
    kind: 'fresh',
    payloadKind: TaskPayloadKind.StandardTask,
    taskId: 'task-123',
    actingUserId: 'user-123',
    payload,
    result: null,
  } as TaskRun;
}

describe('createSourceControlTokenForTaskRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: provider unresolved -> unstamped payloads fall to the GitHub
    // default. clearAllMocks keeps implementations, so reset it explicitly.
    vi.mocked(resolveWorkspaceSourceControlProvider).mockResolvedValue(
      undefined,
    );
    mockDecryptSecrets.mockImplementation(async (value) => value);
    mockEnvironmentVariablesFindMany.mockResolvedValue([]);
    mockCreateTaskRunWorkerGitHubTokenWithMetadata.mockResolvedValue({
      token: 'ghs_app_token',
      source: 'app',
      expiresAt: new Date('2030-01-01T01:00:00.000Z'),
    });
    mockGetGitHubRateLimitRetryAfterMs.mockReturnValue(null);
    mockCreateTaskRunScopedGitLabTokens.mockResolvedValue({
      credentials: [
        {
          host: 'gitlab.com',
          repositoryFullName: 'group/project',
          username: 'oauth2',
          token: 'glptt_scoped_token',
        },
      ],
      proxyCredentials: [],
      artifactsPatch: {
        gitlabScopedProjectTokens: [
          {
            repositoryFullName: 'group/project',
            projectId: '101',
            tokenId: 202,
          },
        ],
      },
      expiresAt: null,
    });
    mockCreateTaskRunGiteaCredentials.mockResolvedValue({
      credentials: [
        {
          host: 'git.example.com',
          repositoryFullName: 'group/project',
          username: 'roomote-bot',
          token: 'gitea_deployment_token',
          originBaseUrl: 'https://git.example.com',
        },
      ],
      expiresAt: new Date('2026-08-10T15:00:00.000Z'),
    });
    mockCreateTaskRunAdoCredentials.mockResolvedValue({
      credentials: [
        {
          host: 'dev.azure.com',
          repositoryFullName: 'acme/Platform/_git/backend',
          username: 'ado',
          token: 'ado_deployment_token',
          originBaseUrl: 'https://dev.azure.com',
        },
      ],
      expiresAt: new Date('2026-08-10T14:00:00.000Z'),
    });
    mockCreateTaskRunBitbucketCredentials.mockResolvedValue({
      credentials: [],
      expiresAt: new Date('2026-08-10T13:00:00.000Z'),
    });
  });

  it('creates GitHub token metadata by default', async () => {
    const taskRun = makeTaskRun({
      repo: 'owner/repo',
      description: 'Work on GitHub',
    });

    const result = await createSourceControlTokenForTaskRun(taskRun, '[test]', {
      maxRetries: 1,
    });

    expect(result).toMatchObject({
      provider: 'github',
      token: 'ghs_app_token',
      envVar: 'GH_TOKEN',
      envVars: { GH_TOKEN: 'ghs_app_token' },
      source: 'app',
      expiresAt: new Date('2030-01-01T01:00:00.000Z'),
    });
    expect(mockCreateTaskRunWorkerGitHubTokenWithMetadata).toHaveBeenCalledWith(
      taskRun,
    );
  });

  it('creates GitLab token metadata from repo-scoped credentials', async () => {
    const result = await createSourceControlTokenForTaskRun(
      makeTaskRun({
        repo: 'group/project',
        description: 'Work on GitLab',
        sourceControlProvider: 'gitlab',
      }),
      '[test]',
      { maxRetries: 1 },
    );

    expect(result).toMatchObject({
      provider: 'gitlab',
      token: 'glptt_scoped_token',
      envVar: 'GITLAB_TOKEN',
      envVars: {},
      gitCredentials: [
        {
          host: 'gitlab.com',
          repositoryFullName: 'group/project',
          username: 'oauth2',
          token: 'glptt_scoped_token',
        },
      ],
      source: 'app',
      expiresAt: null,
      artifactsPatch: {
        gitlabScopedProjectTokens: [
          {
            repositoryFullName: 'group/project',
            projectId: '101',
            tokenId: 202,
          },
        ],
      },
    });
    expect(
      mockCreateTaskRunWorkerGitHubTokenWithMetadata,
    ).not.toHaveBeenCalled();
    expect(mockCreateTaskRunScopedGitLabTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 123,
        payload: expect.objectContaining({
          sourceControlProvider: 'gitlab',
        }),
      }),
    );
  });

  it('maps GitLab deployment-token fallback credentials into proxy credentials', async () => {
    mockCreateTaskRunScopedGitLabTokens.mockResolvedValue({
      credentials: [],
      proxyCredentials: [
        {
          host: 'gitlab.com',
          repositoryFullName: 'group/project',
          username: 'oauth2',
          token: 'glpat_deployment_token',
        },
      ],
      artifactsPatch: {
        gitlabScopedProjectTokens: [],
      },
      expiresAt: null,
    });

    const result = await createSourceControlTokenForTaskRun(
      makeTaskRun({
        repo: 'group/project',
        description: 'Work on GitLab',
        sourceControlProvider: 'gitlab',
      }),
      '[test]',
      { maxRetries: 1 },
    );

    expect(result).toMatchObject({
      provider: 'gitlab',
      token: '',
      gitCredentials: [],
      gitProxyCredentials: [
        {
          provider: 'gitlab',
          host: 'gitlab.com',
          repositoryFullName: 'group/project',
          username: 'oauth2',
          token: 'glpat_deployment_token',
        },
      ],
    });
  });

  it('threads GitLab OAuth access-token expiry into runtime token metadata', async () => {
    const expiresAt = new Date(Date.now() + 90 * 60 * 1000);
    mockCreateTaskRunScopedGitLabTokens.mockResolvedValue({
      credentials: [],
      proxyCredentials: [
        {
          host: 'gitlab.com',
          repositoryFullName: 'group/project',
          username: 'oauth2',
          token: 'oauth_access_token',
          originBaseUrl: 'https://gitlab.com',
        },
      ],
      artifactsPatch: {
        gitlabScopedProjectTokens: [],
      },
      expiresAt,
    });

    const result = await createSourceControlTokenForTaskRun(
      makeTaskRun({
        repo: 'group/project',
        description: 'Work on GitLab',
        sourceControlProvider: 'gitlab',
      }),
      '[test]',
      { maxRetries: 1 },
    );

    expect(result).toMatchObject({
      provider: 'gitlab',
      source: 'app',
      expiresAt,
      gitProxyCredentials: [
        {
          provider: 'gitlab',
          token: 'oauth_access_token',
        },
      ],
    });
  });

  it('creates Gitea token metadata from proxy-backed credentials', async () => {
    const result = await createSourceControlTokenForTaskRun(
      makeTaskRun({
        repo: 'group/project',
        description: 'Work on Gitea',
        sourceControlProvider: 'gitea',
      }),
      '[test]',
      { maxRetries: 1 },
    );

    expect(result).toMatchObject({
      provider: 'gitea',
      token: '',
      envVar: 'GITEA_TOKEN',
      envVars: {},
      gitProxyCredentials: [
        {
          provider: 'gitea',
          host: 'git.example.com',
          repositoryFullName: 'group/project',
          username: 'roomote-bot',
          token: 'gitea_deployment_token',
          originBaseUrl: 'https://git.example.com',
        },
      ],
      source: 'app',
      expiresAt: new Date('2026-08-10T15:00:00.000Z'),
    });
    expect(
      mockCreateTaskRunWorkerGitHubTokenWithMetadata,
    ).not.toHaveBeenCalled();
    expect(mockCreateTaskRunGiteaCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 123,
        payload: expect.objectContaining({
          sourceControlProvider: 'gitea',
        }),
      }),
    );
  });

  it('creates Azure DevOps token metadata from proxy-backed credentials', async () => {
    const result = await createSourceControlTokenForTaskRun(
      makeTaskRun({
        repo: 'acme/Platform/backend',
        description: 'Work on Azure DevOps',
        sourceControlProvider: 'ado',
      }),
      '[test]',
      { maxRetries: 1 },
    );

    expect(result).toMatchObject({
      provider: 'ado',
      token: '',
      envVar: 'ADO_TOKEN',
      envVars: {},
      gitProxyCredentials: [
        {
          provider: 'ado',
          host: 'dev.azure.com',
          repositoryFullName: 'acme/Platform/_git/backend',
          username: 'ado',
          token: 'ado_deployment_token',
          originBaseUrl: 'https://dev.azure.com',
        },
      ],
      source: 'app',
      expiresAt: new Date('2026-08-10T14:00:00.000Z'),
    });
    expect(
      mockCreateTaskRunWorkerGitHubTokenWithMetadata,
    ).not.toHaveBeenCalled();
    expect(mockCreateTaskRunAdoCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 123,
        payload: expect.objectContaining({
          sourceControlProvider: 'ado',
        }),
      }),
    );
  });

  it('creates Bitbucket token metadata with its OAuth expiry', async () => {
    const result = await createSourceControlTokenForTaskRun(
      makeTaskRun({
        repo: 'group/project',
        description: 'Work on Bitbucket',
        sourceControlProvider: 'bitbucket',
      }),
      '[test]',
      { maxRetries: 1 },
    );

    expect(result).toMatchObject({
      provider: 'bitbucket',
      envVar: 'BITBUCKET_OAUTH',
      expiresAt: new Date('2026-08-10T13:00:00.000Z'),
    });
  });

  it('resolves the provider via the shared resolver when the payload is unstamped', async () => {
    // Environment-workspace payload (no repo, no explicit provider): the shared
    // resolver reports gitlab, so a GitLab token is minted instead of the
    // GitHub default.
    // resolveTaskRunSourceControlProvider runs twice per token creation (label +
    // token mint), so use a persistent resolution rather than a one-shot.
    vi.mocked(resolveWorkspaceSourceControlProvider).mockResolvedValue(
      'gitlab',
    );

    const result = await createSourceControlTokenForTaskRun(
      makeTaskRun({
        repo: '',
        environmentId: 'env-123',
        description: 'Work in a gitlab environment',
      }),
      '[test]',
      { maxRetries: 1 },
    );

    expect(result).toMatchObject({ provider: 'gitlab' });
    expect(
      mockCreateTaskRunWorkerGitHubTokenWithMetadata,
    ).not.toHaveBeenCalled();
    expect(mockCreateTaskRunScopedGitLabTokens).toHaveBeenCalled();
  });

  it('mints the stamped primary provider first and merges aggregate metadata', async () => {
    const gitlabExpiresAt = new Date(Date.now() + 90 * 60 * 1000);
    mockCreateTaskRunScopedGitLabTokens.mockResolvedValue({
      credentials: [
        {
          host: 'gitlab.com',
          repositoryFullName: 'group/project',
          username: 'oauth2',
          token: 'glptt_scoped_token',
        },
      ],
      proxyCredentials: [],
      artifactsPatch: {
        gitlabScopedProjectTokens: [
          {
            repositoryFullName: 'group/project',
            projectId: '101',
            tokenId: 202,
          },
        ],
      },
      expiresAt: gitlabExpiresAt,
    });

    const taskRun = makeTaskRun({
      repo: 'group/project',
      selectedRepositories: ['owner/repo', 'group/project'],
      sourceControlProvider: 'github',
      repositoryProviders: {
        'group/project': 'gitlab',
        'owner/repo': 'github',
      },
      description: 'Work across providers',
    } as TaskRun['payload']);

    const result = await createSourceControlTokenForTaskRun(taskRun, '[test]', {
      maxRetries: 1,
    });

    expect(result).toEqual({
      provider: 'github',
      token: 'ghs_app_token',
      envVar: 'GH_TOKEN',
      envVars: { GH_TOKEN: 'ghs_app_token' },
      gitCredentials: [
        {
          host: 'gitlab.com',
          repositoryFullName: 'group/project',
          username: 'oauth2',
          token: 'glptt_scoped_token',
        },
      ],
      gitProxyCredentials: [],
      source: 'app',
      // GitHub has null expiry; keep GitLab OAuth expiry for the refresh loop.
      expiresAt: gitlabExpiresAt,
      artifactsPatch: {
        gitlabScopedProjectTokens: [
          {
            repositoryFullName: 'group/project',
            projectId: '101',
            tokenId: 202,
          },
        ],
      },
    });
    expect(
      mockCreateTaskRunWorkerGitHubTokenWithMetadata.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      mockCreateTaskRunScopedGitLabTokens.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps the earliest expiry when merging multiple providers', async () => {
    const result = await createSourceControlTokenForTaskRun(
      makeTaskRun({
        repo: 'owner/repo',
        sourceControlProvider: 'github',
        repositoryProviders: {
          'owner/repo': 'github',
          'group/project': 'gitea',
        },
        description: 'Work across GitHub and Gitea',
      } as TaskRun['payload']),
      '[test]',
      { maxRetries: 1 },
    );

    expect(result?.expiresAt).toEqual(new Date('2026-08-10T15:00:00.000Z'));
  });

  it('retries only the failing provider and returns no partial token', async () => {
    mockCreateTaskRunScopedGitLabTokens.mockRejectedValue(
      new Error('GitLab unavailable'),
    );
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      const result = await createSourceControlTokenForTaskRun(
        makeTaskRun({
          repo: 'owner/repo',
          repositoryProviders: {
            'owner/repo': 'github',
            'group/project': 'gitlab',
          },
          description: 'Work across providers',
        } as TaskRun['payload']),
        '[test]',
        { maxRetries: 2, baseDelayMs: 0 },
      );

      expect(result).toBeNull();
      expect(
        mockCreateTaskRunWorkerGitHubTokenWithMetadata,
      ).toHaveBeenCalledTimes(1);
      expect(mockCreateTaskRunScopedGitLabTokens).toHaveBeenCalledTimes(2);
    } finally {
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it('does not mint GitLab scoped tokens before a later provider succeeds', async () => {
    mockCreateTaskRunAdoCredentials.mockRejectedValue(
      new Error('Azure DevOps unavailable'),
    );
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      const result = await createSourceControlTokenForTaskRun(
        makeTaskRun({
          repo: 'group/project',
          sourceControlProvider: 'gitlab',
          repositoryProviders: {
            'group/project': 'gitlab',
            'acme/Platform/backend': 'ado',
          },
          description: 'Work across providers',
        } as TaskRun['payload']),
        '[test]',
        { maxRetries: 2, baseDelayMs: 0 },
      );

      expect(result).toBeNull();
      expect(mockCreateTaskRunAdoCredentials).toHaveBeenCalledTimes(2);
      expect(mockCreateTaskRunScopedGitLabTokens).not.toHaveBeenCalled();
    } finally {
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it('does not retry GitHub token creation before a provider reset', async () => {
    const rateLimitError = Object.assign(
      new Error('API rate limit exceeded for installation ID'),
      { status: 403 },
    );
    mockCreateTaskRunWorkerGitHubTokenWithMetadata.mockRejectedValue(
      rateLimitError,
    );
    mockGetGitHubRateLimitRetryAfterMs.mockReturnValue(15 * 60 * 1000);
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      const result = await createSourceControlTokenForTaskRun(
        makeTaskRun({
          repo: 'owner/repo',
          description: 'Work on GitHub',
        }),
        '[test]',
        { maxRetries: 3, baseDelayMs: 0 },
      );

      expect(result).toBeNull();
      expect(
        mockCreateTaskRunWorkerGitHubTokenWithMetadata,
      ).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('source_control_token_creation_rate_limited'),
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('honors a short GitHub retry-after delay once before succeeding', async () => {
    const rateLimitError = Object.assign(new Error('Secondary rate limit'), {
      status: 429,
    });
    mockCreateTaskRunWorkerGitHubTokenWithMetadata
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({
        token: 'ghs_recovered_token',
        source: 'app',
        expiresAt: new Date('2030-01-01T01:00:00.000Z'),
      });
    mockGetGitHubRateLimitRetryAfterMs.mockReturnValue(1);
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    try {
      const result = await createSourceControlTokenForTaskRun(
        makeTaskRun({
          repo: 'owner/repo',
          description: 'Work on GitHub',
        }),
        '[test]',
        { maxRetries: 3, baseDelayMs: 0 },
      );

      expect(result?.token).toBe('ghs_recovered_token');
      expect(
        mockCreateTaskRunWorkerGitHubTokenWithMetadata,
      ).toHaveBeenCalledTimes(2);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"action":"retry"'),
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('caps repeated short GitHub rate limits at one inline retry', async () => {
    const rateLimitError = Object.assign(new Error('Secondary rate limit'), {
      status: 429,
    });
    mockCreateTaskRunWorkerGitHubTokenWithMetadata.mockRejectedValue(
      rateLimitError,
    );
    mockGetGitHubRateLimitRetryAfterMs.mockReturnValue(1);
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      const result = await createSourceControlTokenForTaskRun(
        makeTaskRun({
          repo: 'owner/repo',
          description: 'Work on GitHub',
        }),
        '[test]',
        { maxRetries: 3, baseDelayMs: 0 },
      );

      expect(result).toBeNull();
      expect(
        mockCreateTaskRunWorkerGitHubTokenWithMetadata,
      ).toHaveBeenCalledTimes(2);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"action":"retry"'),
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"action":"abort"'),
      );
    } finally {
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it('returns null when GitLab token is missing', async () => {
    mockCreateTaskRunScopedGitLabTokens.mockRejectedValueOnce(
      new Error('GITLAB_TOKEN is required for GitLab source control jobs.'),
    );
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      await expect(
        createSourceControlTokenForTaskRun(
          makeTaskRun({
            repo: 'group/project',
            description: 'Work on GitLab',
            sourceControlProvider: 'gitlab',
          }),
          '[test]',
          { maxRetries: 1 },
        ),
      ).resolves.toBeNull();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe('notifyCanceledTaskRunOnSettle', () => {
  it('loads the finalized bootstrap error and notifies the launching run', async () => {
    const taskRun = {
      ...makeTaskRun({
        repo: 'owner/repo',
        description: 'Verify an environment',
        notifySourceRunOnSettle: true,
      }),
      sourceRunId: 99,
      task: {
        title: 'Verify environment',
        workflow: 'standard',
        surface: 'web',
        trigger: 'manual',
        modelProvider: 'openai',
        model: 'gpt-5.4',
      },
    } as TaskRun & {
      task: {
        title: string;
        workflow: 'standard';
        surface: 'web';
        trigger: 'manual';
        modelProvider: string;
        model: string;
      };
    };
    mockTaskRunsFindFirst.mockResolvedValueOnce({
      error: 'Failed to create source control token.',
    });

    await notifyCanceledTaskRunOnSettle(taskRun);

    expect(mockNotifySourceRunOnSettle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: taskRun.id,
        error: 'Failed to create source control token.',
      }),
      RunStatus.Canceled,
      'Verify environment',
    );
    expect(mockCaptureTaskSettled).toHaveBeenCalledWith(
      taskRun.id,
      RunStatus.Canceled,
    );
  });
});

describe('redactSourceControlProviderEnvVars', () => {
  it('removes the deployment GitLab token for GitLab jobs', () => {
    expect(
      redactSourceControlProviderEnvVars(
        {
          GITLAB_TOKEN: 'glpat_deployment_token',
          OPENAI_API_KEY: 'sk-test',
        },
        'gitlab',
      ),
    ).toEqual({
      OPENAI_API_KEY: 'sk-test',
    });
  });

  it('removes the deployment Gitea token for Gitea jobs', () => {
    expect(
      redactSourceControlProviderEnvVars(
        {
          GITEA_TOKEN: 'gitea_deployment_token',
          OPENAI_API_KEY: 'sk-test',
        },
        'gitea',
      ),
    ).toEqual({
      OPENAI_API_KEY: 'sk-test',
    });
  });

  it('removes the deployment Azure DevOps token for ADO jobs', () => {
    expect(
      redactSourceControlProviderEnvVars(
        {
          ADO_TOKEN: 'ado_deployment_token',
          OPENAI_API_KEY: 'sk-test',
        },
        'ado',
      ),
    ).toEqual({
      OPENAI_API_KEY: 'sk-test',
    });
  });

  it('removes the deployment Bitbucket token after credentials are derived', () => {
    expect(
      redactSourceControlProviderEnvVars(
        {
          BITBUCKET_OAUTH: 'bitbucket_deployment_token',
          OPENAI_API_KEY: 'sk-test',
        },
        'bitbucket',
      ),
    ).toEqual({
      OPENAI_API_KEY: 'sk-test',
    });
  });

  it('leaves unrelated env vars intact for GitHub jobs', () => {
    const envVars = {
      GITLAB_TOKEN: 'glpat_deployment_token',
      GITEA_TOKEN: 'gitea_deployment_token',
      ADO_TOKEN: 'ado_deployment_token',
      OPENAI_API_KEY: 'sk-test',
    };

    expect(redactSourceControlProviderEnvVars(envVars, 'github')).toBe(envVars);
  });

  it('redacts every non-GitHub deployment token for mixed-provider jobs', () => {
    expect(
      redactSourceControlProviderEnvVars(
        {
          GH_TOKEN: 'operator-github-token',
          GITLAB_TOKEN: 'glpat_deployment_token',
          BITBUCKET_OAUTH: 'bitbucket_deployment_token',
          OPENAI_API_KEY: 'sk-test',
        },
        ['github', 'gitlab', 'bitbucket'],
      ),
    ).toEqual({
      GH_TOKEN: 'operator-github-token',
      OPENAI_API_KEY: 'sk-test',
    });
  });
});

describe('redactControlPlaneEnvVars', () => {
  it('strips control-plane and disabled-provider secrets but keeps enabled model keys', () => {
    expect(
      redactControlPlaneEnvVars({
        // Control-plane secrets that must never reach the sandbox.
        ENCRYPTION_KEY: 'enc',
        R_GITHUB_APP_PRIVATE_KEY: 'app-key',
        JOB_AUTH_PRIVATE_KEY: 'job-key',
        MODAL_TOKEN_SECRET: 'modal',
        E2B_API_KEY: 'e2b',
        DAYTONA_API_KEY: 'daytona',
        R_SLACK_SIGNING_SECRET: 'slack',
        R_TELEGRAM_BOT_TOKEN: 'tg',
        R_DISCORD_BOT_TOKEN: 'discord',
        R_DISCORD_GATEWAY_SECRET: 'discord-gateway',
        DASHBOARD_PASSWORD: 'dash',
        DATABASE_URL: 'postgres://x',
        S3_SECRET_ACCESS_KEY: 's3',
        // Derived from the source-control secret catalog.
        GITLAB_WEBHOOK_SECRET: 'gl-webhook',
        GITLAB_CLIENT_SECRET: 'gl-client',
        // Derived from the sign-in auth catalog.
        R_MICROSOFT_CLIENT_SECRET: 'ms',
        // Teams bot secret (hand-listed bot integration).
        R_TEAMS_BOT_APP_PASSWORD: 'teams',
        GOOGLE_APPLICATION_CREDENTIALS: '{"type":"service_account"}',
        MISTRAL_API_KEY: 'mistral-key',
        // Legitimate task + model env that must be preserved.
        OPENAI_API_KEY: 'sk-test',
        ANTHROPIC_API_KEY: 'sk-ant',
        OPENROUTER_API_KEY: 'sk-or',
        MY_APP_CONFIG: 'value',
        // Per-repo source-control access token: kept here (the matching
        // provider's token is handled by redactSourceControlProviderEnvVars).
        GITLAB_TOKEN: 'glpat-scoped',
      }),
    ).toEqual({
      OPENAI_API_KEY: 'sk-test',
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENROUTER_API_KEY: 'sk-or',
      MY_APP_CONFIG: 'value',
      GITLAB_TOKEN: 'glpat-scoped',
    });
  });

  it('returns the same object when no instance secrets are present', () => {
    const envVars = { OPENAI_API_KEY: 'sk-test', MY_APP_CONFIG: 'value' };
    expect(redactControlPlaneEnvVars(envVars)).toBe(envVars);
  });
});

describe('fetchResolvedRuntimeEnvVars', () => {
  it('mirrors resolved model env to legacy ROOMOTE_* aliases for pre-rename snapshot workers', async () => {
    mockResolveSandboxModelRuntimeEnv.mockResolvedValueOnce({
      R_MODEL: 'anthropic/claude-test',
      R_MODEL_REASONING_EFFORT: 'high',
      R_MODEL_ENV_KEYS: 'ANTHROPIC_API_KEY',
      ANTHROPIC_API_KEY: 'sk-ant',
    });

    const envVars = await fetchResolvedRuntimeEnvVars({
      MY_APP_CONFIG: 'value',
    });

    expect(envVars).toMatchObject({
      R_MODEL: 'anthropic/claude-test',
      ROOMOTE_MODEL: 'anthropic/claude-test',
      R_MODEL_REASONING_EFFORT: 'high',
      ROOMOTE_MODEL_REASONING_EFFORT: 'high',
      R_MODEL_ENV_KEYS: 'ANTHROPIC_API_KEY',
      ROOMOTE_MODEL_ENV_KEYS: 'ANTHROPIC_API_KEY',
      MY_APP_CONFIG: 'value',
    });
  });

  it('derives legacy aliases from the resolved model env', async () => {
    mockResolveSandboxModelRuntimeEnv.mockResolvedValueOnce({
      R_MODEL: 'anthropic/claude-test',
    });

    const envVars = await fetchResolvedRuntimeEnvVars({
      ROOMOTE_MODEL: 'operator/explicit',
    });

    expect(envVars.ROOMOTE_MODEL).toBe('anthropic/claude-test');
    expect(envVars.R_MODEL).toBe('anthropic/claude-test');
  });

  it('replaces stale deployment context metadata with the resolved value', async () => {
    mockResolveSandboxModelRuntimeEnv.mockResolvedValueOnce({
      R_MODEL: 'litellm/qwen3.6:35b-unsloth',
      R_TASK_MODEL_CONTEXT_WINDOWS: JSON.stringify({
        'litellm/qwen3.6:35b-unsloth': 210_176,
      }),
    });

    const envVars = await fetchResolvedRuntimeEnvVars({
      R_TASK_MODEL_CONTEXT_WINDOWS: JSON.stringify({
        'litellm/qwen3.6:35b-unsloth': 999_999,
      }),
    });

    expect(JSON.parse(envVars.R_TASK_MODEL_CONTEXT_WINDOWS ?? '{}')).toEqual({
      'litellm/qwen3.6:35b-unsloth': 210_176,
    });
  });

  it('removes stale deployment context metadata when none is resolved', async () => {
    mockResolveSandboxModelRuntimeEnv.mockResolvedValueOnce({
      R_MODEL: 'litellm/coding',
    });

    const envVars = await fetchResolvedRuntimeEnvVars({
      R_TASK_MODEL_CONTEXT_WINDOWS: JSON.stringify({
        'litellm/qwen3.6:35b-unsloth': 999_999,
      }),
    });

    expect(envVars).not.toHaveProperty('R_TASK_MODEL_CONTEXT_WINDOWS');
  });

  it('admits no raw provider keys when the gateway is enabled', async () => {
    mockResolveSandboxModelRuntimeEnv.mockResolvedValueOnce({
      R_MODEL: 'anthropic/claude-test',
      R_INFERENCE_GATEWAY_KEYS: 'ANTHROPIC_API_KEY',
    });

    const envVars = await fetchResolvedRuntimeEnvVars({
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-openai',
      MY_APP_CONFIG: 'value',
    });

    expect(envVars).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(envVars).not.toHaveProperty('OPENAI_API_KEY');
    expect(envVars.MY_APP_CONFIG).toBe('value');
    expect(envVars.R_INFERENCE_GATEWAY_KEYS).toBe('ANTHROPIC_API_KEY');
  });

  it('admits only resolver-selected provider keys when the resolver returns raw keys', async () => {
    mockResolveSandboxModelRuntimeEnv.mockResolvedValueOnce({
      R_MODEL: 'anthropic/claude-test',
      ANTHROPIC_API_KEY: 'sk-ant',
    });

    const envVars = await fetchResolvedRuntimeEnvVars({
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-openai',
      AWS_BEARER_TOKEN_BEDROCK: 'bedrock-token',
      AWS_REGION: 'us-west-2',
      STRIPE_API_KEY: 'sk-stripe',
    });

    expect(envVars.ANTHROPIC_API_KEY).toBe('sk-ant');
    expect(envVars).not.toHaveProperty('OPENAI_API_KEY');
    expect(envVars).not.toHaveProperty('AWS_BEARER_TOKEN_BEDROCK');
    expect(envVars.AWS_REGION).toBe('us-west-2');
    expect(envVars.STRIPE_API_KEY).toBe('sk-stripe');
    expect(envVars).not.toHaveProperty('R_INFERENCE_GATEWAY_KEYS');
  });

  it('treats custom R_MODEL_ENV_KEYS credentials as resolver-managed', async () => {
    mockResolveSandboxModelRuntimeEnv.mockResolvedValueOnce({
      R_MODEL: 'custom/test-model',
      R_MODEL_ENV_KEYS: 'CUSTOM_LLM_TOKEN',
      CUSTOM_LLM_TOKEN: 'selected-token',
    });

    const envVars = await fetchResolvedRuntimeEnvVars({
      R_MODEL_ENV_KEYS: 'CUSTOM_LLM_TOKEN,STALE_LLM_TOKEN',
      CUSTOM_LLM_TOKEN: 'stored-token',
      STALE_LLM_TOKEN: 'stale-token',
      MY_APP_CONFIG: 'value',
    });

    expect(envVars.CUSTOM_LLM_TOKEN).toBe('selected-token');
    expect(envVars).not.toHaveProperty('STALE_LLM_TOKEN');
    expect(envVars.MY_APP_CONFIG).toBe('value');
  });
});
