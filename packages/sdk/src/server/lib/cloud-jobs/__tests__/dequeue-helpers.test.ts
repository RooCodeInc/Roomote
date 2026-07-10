import { CloudTaskStatus, TaskPayloadKind } from '@roomote/types';
import type { Run } from '@roomote/db/server';

const {
  mockDecryptSecrets,
  mockEnvironmentVariablesFindMany,
  mockCreateCloudJobWorkerGitHubToken,
  mockCreateCloudJobScopedGitLabTokens,
  mockCreateCloudJobGiteaCredentials,
  mockCreateCloudJobAdoCredentials,
} = vi.hoisted(() => ({
  mockDecryptSecrets: vi.fn(),
  mockEnvironmentVariablesFindMany: vi.fn(),
  mockCreateCloudJobWorkerGitHubToken: vi.fn(),
  mockCreateCloudJobScopedGitLabTokens: vi.fn(),
  mockCreateCloudJobGiteaCredentials: vi.fn(),
  mockCreateCloudJobAdoCredentials: vi.fn(),
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
    },
    select: () => ({
      from: () => ({
        where: async () => [],
      }),
    }),
    transaction: vi.fn(),
  },
  cloudJobs: { id: 'cloudJobs.id' },
  repositories: {
    fullName: 'repositories.fullName',
    sourceControlProvider: 'repositories.sourceControlProvider',
  },
  // Shared provider resolver: default to "unresolved" so unstamped payloads
  // fall through to the GitHub default. Provider-stamped payloads never reach
  // it. Individual tests override with mockResolvedValueOnce when needed.
  resolveWorkspaceSourceControlProvider: vi.fn(async () => undefined),
  inArray: vi.fn(),
  markTaskStartParallelCountEndedAt: vi.fn(),
  resolveTaskAttribution: vi.fn(),
  stringifyDecryptedEnvVarValue: (value: unknown) => String(value),
  eq: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@roomote/github', () => ({
  createCloudJobWorkerGitHubToken: (...args: unknown[]) =>
    mockCreateCloudJobWorkerGitHubToken(...args),
}));

vi.mock('@roomote/gitlab', () => ({
  createCloudJobScopedGitLabTokens: (...args: unknown[]) =>
    mockCreateCloudJobScopedGitLabTokens(...args),
}));

vi.mock('@roomote/gitea', () => ({
  createCloudJobGiteaCredentials: (...args: unknown[]) =>
    mockCreateCloudJobGiteaCredentials(...args),
}));

vi.mock('@roomote/ado', () => ({
  createCloudJobAdoCredentials: (...args: unknown[]) =>
    mockCreateCloudJobAdoCredentials(...args),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  releaseCloudTask: vi.fn(),
}));

import { resolveWorkspaceSourceControlProvider } from '@roomote/db/server';

import {
  createSourceControlTokenForJob,
  redactControlPlaneEnvVars,
  redactSourceControlProviderEnvVars,
} from '../dequeue-helpers';

function makeCloudJob(payload: Run['payload']): Run {
  return {
    id: 123,
    status: CloudTaskStatus.Dequeued,
    kind: 'fresh',
    payloadKind: TaskPayloadKind.StandardTask,
    taskId: 'task-123',
    actingUserId: 'user-123',
    payload,
    result: null,
  } as Run;
}

describe('createSourceControlTokenForJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: provider unresolved -> unstamped payloads fall to the GitHub
    // default. clearAllMocks keeps implementations, so reset it explicitly.
    vi.mocked(resolveWorkspaceSourceControlProvider).mockResolvedValue(
      undefined,
    );
    mockDecryptSecrets.mockImplementation(async (value) => value);
    mockEnvironmentVariablesFindMany.mockResolvedValue([]);
    mockCreateCloudJobWorkerGitHubToken.mockResolvedValue('ghs_app_token');
    mockCreateCloudJobScopedGitLabTokens.mockResolvedValue({
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
    });
    mockCreateCloudJobGiteaCredentials.mockResolvedValue({
      credentials: [
        {
          host: 'git.example.com',
          repositoryFullName: 'group/project',
          username: 'roomote-bot',
          token: 'gitea_deployment_token',
          originBaseUrl: 'https://git.example.com',
        },
      ],
    });
    mockCreateCloudJobAdoCredentials.mockResolvedValue({
      credentials: [
        {
          host: 'dev.azure.com',
          repositoryFullName: 'acme/Platform/_git/backend',
          username: 'ado',
          token: 'ado_deployment_token',
          originBaseUrl: 'https://dev.azure.com',
        },
      ],
    });
  });

  it('creates GitHub token metadata by default', async () => {
    const cloudJob = makeCloudJob({
      repo: 'owner/repo',
      description: 'Work on GitHub',
    });

    const result = await createSourceControlTokenForJob(cloudJob, '[test]', {
      maxRetries: 1,
    });

    expect(result).toMatchObject({
      provider: 'github',
      token: 'ghs_app_token',
      envVar: 'GH_TOKEN',
      envVars: { GH_TOKEN: 'ghs_app_token' },
      source: 'app',
      expiresAt: null,
    });
    expect(mockCreateCloudJobWorkerGitHubToken).toHaveBeenCalledWith(cloudJob);
  });

  it('creates GitLab token metadata from repo-scoped credentials', async () => {
    const result = await createSourceControlTokenForJob(
      makeCloudJob({
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
    expect(mockCreateCloudJobWorkerGitHubToken).not.toHaveBeenCalled();
    expect(mockCreateCloudJobScopedGitLabTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 123,
        payload: expect.objectContaining({
          sourceControlProvider: 'gitlab',
        }),
      }),
    );
  });

  it('maps GitLab deployment-token fallback credentials into proxy credentials', async () => {
    mockCreateCloudJobScopedGitLabTokens.mockResolvedValue({
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
    });

    const result = await createSourceControlTokenForJob(
      makeCloudJob({
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

  it('creates Gitea token metadata from proxy-backed credentials', async () => {
    const result = await createSourceControlTokenForJob(
      makeCloudJob({
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
      expiresAt: null,
    });
    expect(mockCreateCloudJobWorkerGitHubToken).not.toHaveBeenCalled();
    expect(mockCreateCloudJobGiteaCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 123,
        payload: expect.objectContaining({
          sourceControlProvider: 'gitea',
        }),
      }),
    );
  });

  it('creates Azure DevOps token metadata from proxy-backed credentials', async () => {
    const result = await createSourceControlTokenForJob(
      makeCloudJob({
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
      expiresAt: null,
    });
    expect(mockCreateCloudJobWorkerGitHubToken).not.toHaveBeenCalled();
    expect(mockCreateCloudJobAdoCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 123,
        payload: expect.objectContaining({
          sourceControlProvider: 'ado',
        }),
      }),
    );
  });

  it('resolves the provider via the shared resolver when the payload is unstamped', async () => {
    // Environment-workspace payload (no repo, no explicit provider): the shared
    // resolver reports gitlab, so a GitLab token is minted instead of the
    // GitHub default.
    // resolveJobSourceControlProvider runs twice per token creation (label +
    // token mint), so use a persistent resolution rather than a one-shot.
    vi.mocked(resolveWorkspaceSourceControlProvider).mockResolvedValue(
      'gitlab',
    );

    const result = await createSourceControlTokenForJob(
      makeCloudJob({
        repo: '',
        environmentId: 'env-123',
        description: 'Work in a gitlab environment',
      }),
      '[test]',
      { maxRetries: 1 },
    );

    expect(result).toMatchObject({ provider: 'gitlab' });
    expect(mockCreateCloudJobWorkerGitHubToken).not.toHaveBeenCalled();
    expect(mockCreateCloudJobScopedGitLabTokens).toHaveBeenCalled();
  });

  it('returns null when GitLab token is missing', async () => {
    mockCreateCloudJobScopedGitLabTokens.mockRejectedValueOnce(
      new Error('GITLAB_TOKEN is required for GitLab source control jobs.'),
    );
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      await expect(
        createSourceControlTokenForJob(
          makeCloudJob({
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

  it('leaves unrelated env vars intact for GitHub jobs', () => {
    const envVars = {
      GITLAB_TOKEN: 'glpat_deployment_token',
      GITEA_TOKEN: 'gitea_deployment_token',
      ADO_TOKEN: 'ado_deployment_token',
      OPENAI_API_KEY: 'sk-test',
    };

    expect(redactSourceControlProviderEnvVars(envVars, 'github')).toBe(envVars);
  });
});

describe('redactControlPlaneEnvVars', () => {
  it('strips instance/control-plane secrets but keeps task env and model keys', () => {
    expect(
      redactControlPlaneEnvVars({
        // Control-plane secrets that must never reach the sandbox.
        ENCRYPTION_KEY: 'enc',
        GITHUB_APP_PRIVATE_KEY: 'app-key',
        JOB_AUTH_PRIVATE_KEY: 'job-key',
        MODAL_TOKEN_SECRET: 'modal',
        E2B_API_KEY: 'e2b',
        DAYTONA_API_KEY: 'daytona',
        SLACK_SIGNING_SECRET: 'slack',
        TELEGRAM_BOT_TOKEN: 'tg',
        DASHBOARD_PASSWORD: 'dash',
        DATABASE_URL: 'postgres://x',
        S3_SECRET_ACCESS_KEY: 's3',
        // Derived from the source-control secret catalog.
        GITLAB_WEBHOOK_SECRET: 'gl-webhook',
        GITLAB_CLIENT_SECRET: 'gl-client',
        // Derived from the sign-in auth catalog.
        ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET: 'ms',
        // Teams bot secret (hand-listed bot integration).
        TEAMS_BOT_APP_PASSWORD: 'teams',
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
