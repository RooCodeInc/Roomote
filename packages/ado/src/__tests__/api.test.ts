import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { RunStatus, TaskPayloadKind } from '@roomote/types';
import type { TaskRun } from '@roomote/db/server';

const {
  mockEnvironmentVariablesFindMany,
  mockRepositoriesFindMany,
  mockEnvironmentsFindFirst,
  mockAuthAccountsFindFirst,
  mockAuthAccountsUpdate,
} = vi.hoisted(() => ({
  mockEnvironmentVariablesFindMany: vi.fn(),
  mockRepositoriesFindMany: vi.fn(),
  mockEnvironmentsFindFirst: vi.fn(),
  mockAuthAccountsFindFirst: vi.fn(),
  mockAuthAccountsUpdate: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      environmentVariables: {
        findMany: (...args: unknown[]) =>
          mockEnvironmentVariablesFindMany(...args),
      },
      repositories: {
        findMany: (...args: unknown[]) => mockRepositoriesFindMany(...args),
        findFirst: vi.fn(),
      },
      environments: {
        findFirst: (...args: unknown[]) => mockEnvironmentsFindFirst(...args),
      },
      authAccounts: {
        findFirst: (...args: unknown[]) => mockAuthAccountsFindFirst(...args),
      },
    },
    select: vi.fn(),
    insert: vi.fn(),
    update: (...args: unknown[]) => mockAuthAccountsUpdate(...args),
  },
  environments: {
    id: 'environments.id',
  },
  repositories: {
    id: 'repositories.id',
    sourceControlProvider: 'repositories.sourceControlProvider',
    isActive: 'repositories.isActive',
    fullName: 'repositories.fullName',
    cloneUrl: 'repositories.cloneUrl',
    externalRepoId: 'repositories.externalRepoId',
  },
  authAccounts: {
    id: 'authAccounts.id',
    accountId: 'authAccounts.accountId',
    providerId: 'authAccounts.providerId',
  },
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
  inArray: vi.fn((left: unknown, right: unknown) => ({
    type: 'inArray',
    left,
    right,
  })),
  stringifyDecryptedEnvVarValue: (value: unknown) => String(value),
  resolveDeploymentEnvVar: vi.fn(async (name: string) => {
    const value = process.env[name]?.trim();
    return value || null;
  }),
}));

vi.mock('@roomote/db/encryption', () => ({
  decryptSecrets: vi.fn(async (value: unknown) => value),
}));

import {
  AdoApiError,
  buildAdoOrganizationApiBaseUrl,
  buildAdoRepositoryValues,
  clearAdoDeploymentUserCache,
  clearAdoEntraTokenCache,
  createAdoPullRequestComment,
  createTaskRunAdoCredentials,
  describeAdoApiError,
  ensureAdoServiceHooksForRepositories,
  removeAdoServiceHooksForRepositories,
  getAdoBuildFailureEvidence,
  getAdoDeploymentUser,
  getLatestAdoBuild,
  listAdoRepositories,
  normalizeAdoLinkedAccountKey,
  resolveAdoToken,
  selectInnermostFailedAdoTimelineRecords,
  validateAdoDelegatedCredentials,
  validateAdoEntraCredentials,
  validateAdoToken,
  type AdoRepository,
} from '../api';

const ENTRA_PERMISSION_GUIDANCE =
  'Azure DevOps API permissions Code, Graph, and User Delegation / Impersonation';

/**
 * Mocks the two hops an Entra credential makes: the Microsoft tenant token
 * request, then the Azure DevOps call that the token is used for.
 */
function mockEntraThenAdo(adoResponse: () => Response) {
  return vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url).includes('login.microsoftonline.com')) {
      return new Response(
        JSON.stringify({
          access_token: 'header.payload.signature',
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }

    return adoResponse();
  });
}

function makeTaskRun(payload: TaskRun['payload']): TaskRun {
  return {
    id: 123,
    status: RunStatus.Dequeued,
    kind: 'fresh' as const,
    payloadKind: TaskPayloadKind.StandardTask,
    taskId: 'task-123',
    actingUserId: 'user-123',
    payload,
    result: null,
    artifacts: null,
  } as TaskRun;
}

describe('Azure DevOps API helpers', () => {
  const originalAdoToken = process.env.ADO_TOKEN;
  const originalAdoOrganization = process.env.ADO_ORGANIZATION;
  const originalAdoBaseUrl = process.env.ADO_BASE_URL;
  const originalAdoUsername = process.env.ADO_USERNAME;
  const originalAdoClientId = process.env.ADO_CLIENT_ID;
  const originalAdoClientSecret = process.env.ADO_CLIENT_SECRET;
  const originalAdoTenantId = process.env.ADO_TENANT_ID;
  const originalAdoAuthMode = process.env.ADO_AUTH_MODE;
  const originalAdoLinkedAccountId = process.env.ADO_LINKED_ACCOUNT_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    clearAdoDeploymentUserCache();
    clearAdoEntraTokenCache();
    process.env.ADO_TOKEN = 'ado_deployment_token';
    process.env.ADO_ORGANIZATION = 'acme';
    delete process.env.ADO_BASE_URL;
    delete process.env.ADO_USERNAME;
    delete process.env.ADO_CLIENT_ID;
    delete process.env.ADO_CLIENT_SECRET;
    delete process.env.ADO_TENANT_ID;
    delete process.env.ADO_AUTH_MODE;
    delete process.env.ADO_LINKED_ACCOUNT_ID;
    mockEnvironmentVariablesFindMany.mockResolvedValue([]);
    mockEnvironmentsFindFirst.mockResolvedValue(null);
    mockAuthAccountsFindFirst.mockResolvedValue(null);
    mockAuthAccountsUpdate.mockReturnValue({
      set: vi
        .fn()
        .mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
    mockRepositoriesFindMany.mockResolvedValue([
      {
        fullName: 'acme/Platform/backend',
        cloneUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
      },
    ]);
  });

  afterEach(() => {
    if (originalAdoToken === undefined) {
      delete process.env.ADO_TOKEN;
    } else {
      process.env.ADO_TOKEN = originalAdoToken;
    }

    if (originalAdoOrganization === undefined) {
      delete process.env.ADO_ORGANIZATION;
    } else {
      process.env.ADO_ORGANIZATION = originalAdoOrganization;
    }

    if (originalAdoBaseUrl === undefined) {
      delete process.env.ADO_BASE_URL;
    } else {
      process.env.ADO_BASE_URL = originalAdoBaseUrl;
    }

    if (originalAdoUsername === undefined) {
      delete process.env.ADO_USERNAME;
    } else {
      process.env.ADO_USERNAME = originalAdoUsername;
    }

    for (const [name, value] of [
      ['ADO_CLIENT_ID', originalAdoClientId],
      ['ADO_CLIENT_SECRET', originalAdoClientSecret],
      ['ADO_TENANT_ID', originalAdoTenantId],
      ['ADO_AUTH_MODE', originalAdoAuthMode],
      ['ADO_LINKED_ACCOUNT_ID', originalAdoLinkedAccountId],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('builds the organization API base URL from the Azure DevOps instance URL', () => {
    expect(
      buildAdoOrganizationApiBaseUrl({
        baseUrl: 'https://dev.azure.com/',
        organization: 'acme',
      }),
    ).toBe('https://dev.azure.com/acme');
  });

  it('acquires and caches a Microsoft Entra service-principal token when no PAT is configured', async () => {
    delete process.env.ADO_TOKEN;
    process.env.ADO_CLIENT_ID = 'client-id';
    process.env.ADO_CLIENT_SECRET = 'client-secret';
    process.env.ADO_TENANT_ID = 'tenant-id';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'header.payload.signature',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );

    const first = await resolveAdoToken();
    const second = await resolveAdoToken();

    expect(first).toBe('header.payload.signature');
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(URLSearchParams),
      }),
    );
  });

  it('refreshes and persists an Azure DevOps delegated token', async () => {
    delete process.env.ADO_TOKEN;
    process.env.ADO_AUTH_MODE = 'delegated';
    process.env.ADO_LINKED_ACCOUNT_ID = 'ado-user@example.com';
    process.env.ADO_CLIENT_ID = 'client-id';
    process.env.ADO_CLIENT_SECRET = 'client-secret';
    process.env.ADO_TENANT_ID = 'tenant-id';
    mockAuthAccountsFindFirst.mockResolvedValue({
      id: 'account-1',
      accountId: 'ado-user@example.com',
      accessToken: 'expired.token.value',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new.header.signature',
          refresh_token: 'rotated-refresh-token',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );

    await expect(resolveAdoToken()).resolves.toBe('new.header.signature');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockAuthAccountsUpdate).toHaveBeenCalledTimes(1);
  });

  it('lists Azure DevOps repositories with PAT basic auth', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          count: 2,
          value: [
            {
              id: 'repo-1',
              name: 'backend',
              project: {
                id: 'project-1',
                name: 'Platform',
                visibility: 'private',
              },
              defaultBranch: 'refs/heads/main',
              remoteUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
              webUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
            },
            {
              id: 'repo-2',
              name: 'archived',
              project: {
                id: 'project-1',
                name: 'Platform',
                visibility: 'private',
              },
              isDisabled: true,
            },
          ],
        }),
        {
          status: 200,
        },
      ),
    );

    const repositories = await listAdoRepositories({
      baseUrl: 'https://dev.azure.com',
      organization: 'acme',
      fetchImpl: fetchMock,
      token: 'ado_test',
    });

    expect(repositories.map((repository) => repository.name)).toEqual([
      'backend',
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://dev.azure.com/acme/_apis/git/repositories?api-version=7.1&includeHidden=false&includeAllUrls=true',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from(':ado_test').toString('base64')}`,
        }),
      }),
    );
  });

  it('requires a token and organization to list repositories', async () => {
    await expect(
      listAdoRepositories({
        token: '',
        organization: 'acme',
      }),
    ).rejects.toThrow(
      'ADO_TOKEN is required to sync Azure DevOps repositories.',
    );

    await expect(
      listAdoRepositories({
        token: 'ado_test',
        organization: '',
      }),
    ).rejects.toThrow(
      'ADO_ORGANIZATION is required to sync Azure DevOps repositories.',
    );
  });

  it('strips the organization userinfo Azure DevOps embeds in remote URLs', () => {
    const repository = {
      id: 'repo-1',
      name: 'Test ADO',
      project: {
        id: 'project-1',
        name: 'Test ADO',
        description: null,
        state: 'wellFormed',
        visibility: 'private',
      },
      defaultBranch: 'refs/heads/main',
      remoteUrl: 'https://acme@dev.azure.com/acme/Test%20ADO/_git/Test%20ADO',
      webUrl: 'https://dev.azure.com/acme/Test%20ADO/_git/Test%20ADO',
    } satisfies AdoRepository;

    const values = buildAdoRepositoryValues({
      repository,
      linkedByUserId: 'user-1',
      organization: 'acme',
    });

    expect(values.cloneUrl).toBe(
      'https://dev.azure.com/acme/Test%20ADO/_git/Test%20ADO',
    );
  });

  it('maps Azure DevOps repository fields into provider-tagged repository rows', () => {
    const repository = {
      id: 'repo-1',
      name: 'backend',
      project: {
        id: 'project-1',
        name: 'Platform',
        description: 'Platform project',
        state: 'wellFormed',
        visibility: 'private',
      },
      defaultBranch: 'refs/heads/develop',
      remoteUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
      webUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
    } satisfies AdoRepository;

    expect(
      buildAdoRepositoryValues({
        repository,
        linkedByUserId: 'user-1',
        organization: 'acme',
      }),
    ).toEqual({
      sourceControlProvider: 'ado',
      installationId: null,
      userId: null,
      githubRepoId: null,
      externalRepoId: 'repo-1',
      host: 'dev.azure.com',
      name: 'backend',
      fullName: 'acme/Platform/backend',
      description: 'Platform project',
      private: true,
      defaultBranch: 'develop',
      cloneUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
      htmlUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
      permissions: {
        projectId: 'project-1',
        projectState: 'wellFormed',
        projectVisibility: 'private',
      },
      isActive: true,
      linkedByUserId: 'user-1',
    });
  });

  it('validates Azure DevOps tokens against the repository listing the sync uses', async () => {
    // Not /_apis/connectionData: that resource is preview-only and answers 400
    // unless the api-version carries `-preview`, which made every valid
    // credential look unverifiable.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ count: 1, value: [] }), { status: 200 }),
      );

    await expect(
      validateAdoToken({
        token: 'ado_test',
        organization: 'acme',
        baseUrl: 'https://dev.azure.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({ status: 'valid' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://dev.azure.com/acme/_apis/git/repositories?api-version=7.1&%24top=1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from(':ado_test').toString('base64')}`,
        }),
      }),
    );
  });

  it('rejects definitively invalid Azure DevOps tokens during validation', async () => {
    // Azure DevOps answers rejected PATs with a 203 sign-in page.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html>Sign in</html>', { status: 203 }));

    await expect(
      validateAdoToken({
        token: 'bad_token',
        organization: 'acme',
        baseUrl: 'https://dev.azure.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({
      status: 'invalid',
      error:
        'Azure DevOps rejected the access token. Confirm it is active, belongs to the organization, and has Code read access.',
    });
  });

  it('rejects a Microsoft Entra app registration that cannot reach Azure DevOps', async () => {
    // The `.default` scope issues a token regardless of what was consented,
    // so only the Azure DevOps call reveals the problem. Azure DevOps names it
    // in the body, which is more specific than anything the status implies.
    const fetchMock = mockEntraThenAdo(
      () =>
        new Response(
          JSON.stringify({
            message:
              'TF401444: Please sign-in at least once as tenant\\tenant\\object-id in a web browser to enable access.',
          }),
          { status: 401 },
        ),
    );

    const result = await validateAdoEntraCredentials({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tenantId: 'tenant-id',
      organization: 'acme',
      baseUrl: 'https://dev.azure.com',
      fetchImpl: fetchMock,
    });

    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.error).toContain('TF401444');
    expect(result.status === 'invalid' && result.error).toContain(
      ENTRA_PERMISSION_GUIDANCE,
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://dev.azure.com/acme/_apis/git/repositories?api-version=7.1&%24top=1',
    );
  });

  it('accepts a Microsoft Entra service principal that can reach Azure DevOps', async () => {
    const fetchMock = mockEntraThenAdo(
      () =>
        new Response(JSON.stringify({ count: 1, value: [] }), { status: 200 }),
    );

    await expect(
      validateAdoEntraCredentials({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
        organization: 'acme',
        baseUrl: 'https://dev.azure.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({ status: 'valid' });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: 'Bearer header.payload.signature',
      }),
    });
  });

  it('rejects Microsoft Entra credentials the tenant will not issue a token for', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 401 }));

    const result = await validateAdoEntraCredentials({
      clientId: 'client-id',
      clientSecret: 'wrong-secret',
      tenantId: 'tenant-id',
      organization: 'acme',
      baseUrl: 'https://dev.azure.com',
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({
      status: 'invalid',
      error: expect.stringContaining(
        'Microsoft Entra did not issue an Azure DevOps token',
      ),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('validates the delegated account with its stored access token', async () => {
    mockAuthAccountsFindFirst.mockResolvedValue({
      id: 'account-1',
      accountId: 'ado-user@example.com',
      accessToken: 'header.payload.signature',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 401 }));

    const result = await validateAdoDelegatedCredentials({
      linkedAccountId: 'ado-user@example.com',
      organization: 'acme',
      baseUrl: 'https://dev.azure.com',
      fetchImpl: fetchMock,
    });

    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.error).toContain(
      ENTRA_PERMISSION_GUIDANCE,
    );
  });

  it('reports a delegated connection that was never completed', async () => {
    mockAuthAccountsFindFirst.mockResolvedValue(null);

    await expect(
      validateAdoDelegatedCredentials({
        linkedAccountId: 'ado-user@example.com',
        organization: 'acme',
        baseUrl: 'https://dev.azure.com',
      }),
    ).resolves.toEqual({
      status: 'invalid',
      error:
        'No Azure DevOps account is connected. Connect with Microsoft again, then save.',
    });
  });

  it('explains a rejected Entra credential instead of echoing the raw status', async () => {
    delete process.env.ADO_TOKEN;
    process.env.ADO_AUTH_MODE = 'entra';

    const message = await describeAdoApiError(
      new AdoApiError(401, 'Unauthorized'),
    );

    expect(message).toContain('(status 401)');
    expect(message).toContain(ENTRA_PERMISSION_GUIDANCE);
  });

  it('surfaces the Azure DevOps explanation captured from a failed request', async () => {
    delete process.env.ADO_TOKEN;
    process.env.ADO_AUTH_MODE = 'entra';
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          message:
            'TF401444: Please sign-in at least once as tenant\\tenant\\object-id in a web browser to enable access.',
        }),
        { status: 401, statusText: 'Unauthorized' },
      ),
    );

    // The repository sync fails here, so this is the error an admin sees.
    const error = await listAdoRepositories({
      token: 'header.payload.signature',
      organization: 'acme',
      baseUrl: 'https://dev.azure.com',
      fetchImpl: fetchMock,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AdoApiError);
    await expect(describeAdoApiError(error)).resolves.toContain('TF401444');
  });

  it('keeps non-authorization Azure DevOps failures verbatim', async () => {
    await expect(
      describeAdoApiError(new AdoApiError(500, 'Internal Server Error')),
    ).resolves.toBe(
      'Azure DevOps API request failed: 500 Internal Server Error',
    );
    await expect(
      describeAdoApiError(new Error('socket hang up')),
    ).resolves.toBe('socket hang up');
  });

  it('returns unknown when Azure DevOps token validation cannot complete', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('network unreachable'));

    await expect(
      validateAdoToken({
        token: 'ado_test',
        organization: 'acme',
        baseUrl: 'https://dev.azure.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({
      status: 'unknown',
      error:
        'Could not verify the Azure DevOps credential: network unreachable',
    });
  });

  it('resolves and caches the Azure DevOps deployment token identity', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticatedUser: {
            id: 'user-guid',
            uniqueName: 'roomote-bot@acme.example',
            displayName: 'Roomote Bot',
          },
        }),
        { status: 200 },
      ),
    );

    const first = await getAdoDeploymentUser({ fetchImpl: fetchMock });
    const second = await getAdoDeploymentUser({ fetchImpl: fetchMock });

    expect(first).toEqual({
      id: 'user-guid',
      uniqueName: 'roomote-bot@acme.example',
      displayName: 'Roomote Bot',
    });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://dev.azure.com/acme/_apis/connectionData?api-version=7.1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from(':ado_deployment_token').toString(
            'base64',
          )}`,
        }),
      }),
    );
  });

  it('creates Azure DevOps pull request comment replies on an existing thread', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 11 }), { status: 200 }),
      );

    const result = await createAdoPullRequestComment({
      repositoryFullName: 'acme/Platform/backend',
      repositoryId: 'repo-1',
      pullRequestNumber: 42,
      threadId: '5',
      parentCommentId: 900,
      body: 'I started a review task.',
      token: 'ado_test',
      baseUrl: 'https://dev.azure.com',
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ threadId: '5', commentId: '11' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://dev.azure.com/acme/Platform/_apis/git/repositories/repo-1/pullRequests/42/threads/5/comments?api-version=7.1',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from(':ado_test').toString('base64')}`,
        }),
        body: JSON.stringify({
          content: 'I started a review task.',
          commentType: 'text',
          parentCommentId: 900,
        }),
      }),
    );
  });

  it('creates Azure DevOps pull request comment threads when no thread id is available', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 6,
          comments: [{ id: 12 }],
        }),
        { status: 200 },
      ),
    );

    const result = await createAdoPullRequestComment({
      repositoryFullName: 'acme/Platform/backend',
      repositoryId: 'repo-1',
      pullRequestNumber: 42,
      body: 'I started a review task.',
      token: 'ado_test',
      baseUrl: 'https://dev.azure.com',
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ threadId: '6', commentId: '12' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://dev.azure.com/acme/Platform/_apis/git/repositories/repo-1/pullRequests/42/threads?api-version=7.1',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          comments: [
            {
              content: 'I started a review task.',
              commentType: 'text',
              parentCommentId: 0,
            },
          ],
          status: 'active',
        }),
      }),
    );
  });

  it('creates proxy-backed git credentials for selected Azure DevOps repositories', async () => {
    const result = await createTaskRunAdoCredentials(
      makeTaskRun({
        repo: 'acme/Platform/backend',
        description: 'Work on Azure DevOps',
        sourceControlProvider: 'ado',
      }),
    );

    expect(result).toEqual({
      credentials: [
        {
          host: 'dev.azure.com',
          repositoryFullName: 'acme/Platform/_git/backend',
          username: 'ado',
          token: 'ado_deployment_token',
          authScheme: 'basic',
          originBaseUrl: 'https://dev.azure.com',
        },
      ],
    });
    expect(mockRepositoriesFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: { fullName: true, cloneUrl: true },
      }),
    );
  });

  it('strips the Azure DevOps base-path prefix before building proxy-backed credentials', async () => {
    mockRepositoriesFindMany.mockResolvedValue([
      {
        fullName: 'acme/Platform/backend',
        cloneUrl: 'https://ado.example.com/tfs/acme/Platform/_git/backend',
      },
    ]);

    const result = await createTaskRunAdoCredentials(
      makeTaskRun({
        repo: 'acme/Platform/backend',
        description: 'Work on Azure DevOps Server',
        sourceControlProvider: 'ado',
      }),
      {
        baseUrl: 'https://ado.example.com/tfs',
      },
    );

    expect(result).toEqual({
      credentials: [
        {
          host: 'ado.example.com',
          repositoryFullName: 'acme/Platform/_git/backend',
          username: 'ado',
          token: 'ado_deployment_token',
          authScheme: 'basic',
          originBaseUrl: 'https://ado.example.com/tfs',
        },
      ],
    });
  });

  it('removes Roomote service hook subscriptions from repositories and reports not_found when absent', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: 'subscription-1',
                publisherId: 'tfs',
                eventType: 'git.pullrequest.created',
                consumerId: 'webHooks',
                consumerActionId: 'httpRequest',
                publisherInputs: {
                  projectId: 'project-1',
                  repository: 'repo-1',
                },
                consumerInputs: {
                  url: 'https://roomote.example.com/api/webhooks/ado',
                },
              },
              {
                id: 'subscription-2',
                publisherId: 'tfs',
                eventType: 'git.pullrequest.updated',
                consumerId: 'webHooks',
                consumerActionId: 'httpRequest',
                publisherInputs: {
                  projectId: 'project-1',
                  repository: 'repo-1',
                  notificationType: 'PushNotification',
                },
                consumerInputs: {
                  url: 'https://roomote.example.com/api/webhooks/ado?notificationType=PushNotification',
                },
              },
              {
                id: 'subscription-other',
                publisherId: 'tfs',
                eventType: 'git.pullrequest.created',
                consumerId: 'webHooks',
                consumerActionId: 'httpRequest',
                publisherInputs: {
                  projectId: 'project-1',
                  repository: 'repo-1',
                },
                consumerInputs: {
                  url: 'https://unrelated.example.com/api/webhooks/ado',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockImplementation(async () => new Response(null, { status: 204 }));

    await expect(
      removeAdoServiceHooksForRepositories({
        repositories: [
          {
            repositoryFullName: 'acme/Platform/backend',
            repositoryId: 'repo-1',
            projectId: 'project-1',
          },
          {
            repositoryFullName: 'acme/Platform/tools',
            repositoryId: 'repo-2',
            projectId: 'project-1',
          },
        ],
        webhookUrl: 'https://roomote.example.com/api/webhooks/ado',
        token: 'ado_test',
        organization: 'acme',
        baseUrl: 'https://dev.azure.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual([
      { repositoryFullName: 'acme/Platform/backend', status: 'removed' },
      { repositoryFullName: 'acme/Platform/tools', status: 'not_found' },
    ]);

    const deleteCalls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === 'DELETE',
    );
    expect(deleteCalls.map(([url]) => url)).toEqual([
      'https://dev.azure.com/acme/_apis/hooks/subscriptions/subscription-1?api-version=7.1',
      'https://dev.azure.com/acme/_apis/hooks/subscriptions/subscription-2?api-version=7.1',
    ]);
  });

  it('keeps project-scoped work item hooks when another repository in the project stays mapped', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: 'subscription-repo',
                publisherId: 'tfs',
                eventType: 'git.pullrequest.created',
                consumerId: 'webHooks',
                consumerActionId: 'httpRequest',
                publisherInputs: {
                  projectId: 'project-1',
                  repository: 'repo-1',
                },
                consumerInputs: {
                  url: 'https://roomote.example.com/api/webhooks/ado',
                },
              },
              {
                id: 'subscription-work-item',
                publisherId: 'tfs',
                eventType: 'workitem.commented',
                consumerId: 'webHooks',
                consumerActionId: 'httpRequest',
                publisherInputs: {
                  projectId: 'project-1',
                },
                consumerInputs: {
                  url: 'https://roomote.example.com/api/webhooks/ado',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockImplementation(async () => new Response(null, { status: 204 }));

    await expect(
      removeAdoServiceHooksForRepositories({
        repositories: [
          {
            repositoryFullName: 'acme/Platform/backend',
            repositoryId: 'repo-1',
            projectId: 'project-1',
          },
        ],
        retainProjectIds: ['project-1'],
        webhookUrl: 'https://roomote.example.com/api/webhooks/ado',
        token: 'ado_test',
        organization: 'acme',
        baseUrl: 'https://dev.azure.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual([
      { repositoryFullName: 'acme/Platform/backend', status: 'removed' },
    ]);

    const deleteCalls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === 'DELETE',
    );
    expect(deleteCalls.map(([url]) => url)).toEqual([
      'https://dev.azure.com/acme/_apis/hooks/subscriptions/subscription-repo?api-version=7.1',
    ]);
  });

  it('removes project-scoped work item hooks when the project has no retained mapped repositories', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: 'subscription-repo',
                publisherId: 'tfs',
                eventType: 'git.pullrequest.created',
                consumerId: 'webHooks',
                consumerActionId: 'httpRequest',
                publisherInputs: {
                  projectId: 'project-1',
                  repository: 'repo-1',
                },
                consumerInputs: {
                  url: 'https://roomote.example.com/api/webhooks/ado',
                },
              },
              {
                id: 'subscription-work-item',
                publisherId: 'tfs',
                eventType: 'workitem.commented',
                consumerId: 'webHooks',
                consumerActionId: 'httpRequest',
                publisherInputs: {
                  projectId: 'project-1',
                },
                consumerInputs: {
                  url: 'https://roomote.example.com/api/webhooks/ado',
                },
              },
              {
                id: 'subscription-build',
                publisherId: 'tfs',
                eventType: 'build.complete',
                consumerId: 'webHooks',
                consumerActionId: 'httpRequest',
                publisherInputs: {
                  projectId: 'project-1',
                },
                consumerInputs: {
                  url: 'https://roomote.example.com/api/webhooks/ado',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockImplementation(async () => new Response(null, { status: 204 }));

    await expect(
      removeAdoServiceHooksForRepositories({
        repositories: [
          {
            repositoryFullName: 'acme/Platform/backend',
            repositoryId: 'repo-1',
            projectId: 'project-1',
          },
        ],
        retainProjectIds: [],
        webhookUrl: 'https://roomote.example.com/api/webhooks/ado',
        token: 'ado_test',
        organization: 'acme',
        baseUrl: 'https://dev.azure.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual([
      { repositoryFullName: 'acme/Platform/backend', status: 'removed' },
    ]);

    const deleteCalls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === 'DELETE',
    );
    expect(deleteCalls.map(([url]) => url)).toEqual([
      'https://dev.azure.com/acme/_apis/hooks/subscriptions/subscription-repo?api-version=7.1',
      'https://dev.azure.com/acme/_apis/hooks/subscriptions/subscription-work-item?api-version=7.1',
      'https://dev.azure.com/acme/_apis/hooks/subscriptions/subscription-build?api-version=7.1',
    ]);
  });

  it('creates or refreshes Azure DevOps pull request service hooks for repositories', async () => {
    const listBody = {
      value: [
        {
          id: 'subscription-1',
          publisherId: 'tfs',
          eventType: 'git.pullrequest.created',
          consumerId: 'webHooks',
          consumerActionId: 'httpRequest',
          publisherInputs: {
            projectId: 'project-1',
            repository: 'repo-1',
          },
          consumerInputs: {
            url: 'https://roomote.example.com/api/webhooks/ado',
          },
        },
      ],
    };
    const upsertBody = {
      id: 'subscription-response',
      publisherId: 'tfs',
      eventType: 'git.pullrequest.created',
      consumerId: 'webHooks',
      consumerActionId: 'httpRequest',
      publisherInputs: {
        projectId: 'project-1',
        repository: 'repo-1',
      },
      consumerInputs: {
        url: 'https://roomote.example.com/api/webhooks/ado',
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (
          method === 'GET' &&
          String(url).includes('/_apis/hooks/subscriptions')
        ) {
          return new Response(JSON.stringify(listBody), { status: 200 });
        }

        return new Response(JSON.stringify(upsertBody), { status: 200 });
      });

    await expect(
      ensureAdoServiceHooksForRepositories({
        repositories: [
          {
            repositoryFullName: 'acme/Platform/backend',
            repositoryId: 'repo-1',
            projectId: 'project-1',
          },
        ],
        webhookUrl: 'https://roomote.example.com/api/webhooks/ado',
        secretToken: 'webhook-secret',
        token: 'ado_test',
        organization: 'acme',
        baseUrl: 'https://dev.azure.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual([
      {
        repositoryFullName: 'acme/Platform/backend',
        status: 'created',
      },
    ]);

    const updateCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url ===
          'https://dev.azure.com/acme/_apis/hooks/subscriptions/subscription-1?api-version=7.1' &&
        init?.method === 'PUT',
    );
    expect(updateCall?.[1]?.body).toContain('"basicAuthUsername":"roomote"');
    expect(updateCall?.[1]?.body).toContain(
      '"basicAuthPassword":"webhook-secret"',
    );
    expect(updateCall?.[1]?.body).not.toContain('"basicAuthCredentials"');
    expect(updateCall?.[1]?.body).toContain(
      '"httpHeaders":"X-Roomote-Webhook-Secret:webhook-secret"',
    );

    const createCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        url ===
          'https://dev.azure.com/acme/_apis/hooks/subscriptions?api-version=7.1' &&
        init?.method === 'POST',
    );
    // 1 existing PR created hook is refreshed via PUT; remaining 3 PR hooks
    // plus workitem.commented and build.complete are created via POST.
    expect(createCalls).toHaveLength(5);
    const createBodies = createCalls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    ) as Array<{
      eventType: string;
      publisherInputs: Record<string, string>;
      consumerInputs: Record<string, string>;
      resourceVersion?: string;
    }>;
    expect(
      createBodies.some((body) =>
        body.consumerInputs.url?.endsWith(
          '/api/webhooks/ado?notificationType=PushNotification',
        ),
      ),
    ).toBe(true);
    expect(
      createBodies.some((body) =>
        body.consumerInputs.url?.endsWith(
          '/api/webhooks/ado?notificationType=StatusUpdateNotification',
        ),
      ),
    ).toBe(true);
    expect(
      createBodies.some((body) => body.eventType === 'git.pullrequest.merged'),
    ).toBe(false);
    expect(
      createBodies.some(
        (body) =>
          body.eventType === 'git.pullrequest.updated' &&
          body.publisherInputs.notificationType === 'PushNotification',
      ),
    ).toBe(true);
    expect(
      createBodies.some(
        (body) =>
          body.eventType === 'ms.vss-code.git-pullrequest-comment-event',
      ),
    ).toBe(true);
    expect(
      createBodies.some(
        (body) =>
          body.eventType === 'workitem.commented' &&
          body.publisherInputs.projectId === 'project-1' &&
          !body.publisherInputs.repository,
      ),
    ).toBe(true);
    expect(
      createBodies.some(
        (body) =>
          body.eventType === 'build.complete' &&
          body.publisherInputs.projectId === 'project-1' &&
          !body.publisherInputs.repository &&
          // 1.0 sends the legacy XAML build shape without result/sourceBranch/
          // repository; the handler needs the 2.0 Build resource.
          body.resourceVersion === '2.0',
      ),
    ).toBe(true);
  });
});

describe('getLatestAdoBuild and getAdoBuildFailureEvidence', () => {
  beforeEach(() => {
    process.env.ADO_TOKEN = 'ado_test';
    process.env.ADO_ORGANIZATION = 'acme';
    process.env.ADO_BASE_URL = 'https://dev.azure.com';
  });

  afterEach(() => {
    delete process.env.ADO_TOKEN;
    delete process.env.ADO_ORGANIZATION;
    delete process.env.ADO_BASE_URL;
  });

  it('reads the newest completed default-branch build without filtering by result', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          value: [
            {
              id: 88,
              result: 'succeeded',
              sourceBranch: 'refs/heads/main',
              sourceVersion: 'abc123',
              definition: { name: 'CI' },
              _links: {
                web: {
                  href: 'https://dev.azure.com/acme/Platform/_build/results?buildId=88',
                },
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const build = await getLatestAdoBuild({
      repositoryFullName: 'acme/Platform/backend',
      repositoryId: 'repo-guid-1',
      branch: 'main',
      fetchImpl: fetchMock,
    });

    expect(build?.id).toBe(88);
    expect(build?.result).toBe('succeeded');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/Platform/_apis/build/builds',
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'repositoryId=repo-guid-1',
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'statusFilter=completed',
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('resultFilter=');
  });

  it('throws on rejected credentials instead of reading them as no failed build', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html>sign in</html>', { status: 203 }));

    await expect(
      getLatestAdoBuild({
        repositoryFullName: 'acme/Platform/backend',
        repositoryId: 'repo-guid-1',
        branch: 'main',
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow('rejected the access token');
  });

  it('returns null for unknown projects or repositories', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 404 }));

    const build = await getLatestAdoBuild({
      repositoryFullName: 'acme/Platform/backend',
      repositoryId: 'repo-guid-1',
      branch: 'main',
      fetchImpl: fetchMock,
    });

    expect(build).toBeNull();
  });

  it('formats failed timeline tasks and log tails', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes('/timeline')) {
        return new Response(
          JSON.stringify({
            records: [
              {
                name: 'Test',
                type: 'Task',
                result: 'failed',
                log: { id: 7 },
                issues: [{ message: 'Assertion failed' }],
              },
              {
                name: 'ok',
                type: 'Task',
                result: 'succeeded',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (href.includes('/logs/7')) {
        return new Response('line1\nAssertionError: boom\n', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const evidence = await getAdoBuildFailureEvidence({
      repositoryFullName: 'acme/Platform/backend',
      buildId: 88,
      fetchImpl: fetchMock,
    });

    expect(evidence).toContain('task="Test"');
    expect(evidence).toContain('Assertion failed');
    expect(evidence).toContain('AssertionError: boom');
  });

  it('keeps failed task records over cascaded job/stage/phase wrappers', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes('/timeline')) {
        return new Response(
          JSON.stringify({
            records: [
              { name: 'Build stage', type: 'Stage', result: 'failed' },
              { name: 'Build phase', type: 'Phase', result: 'failed' },
              { name: 'Build job', type: 'Job', result: 'failed' },
              {
                name: 'Test',
                type: 'Task',
                result: 'failed',
                log: { id: 7 },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (href.includes('/logs/7')) {
        return new Response('AssertionError: boom\n', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const evidence = await getAdoBuildFailureEvidence({
      repositoryFullName: 'acme/Platform/backend',
      buildId: 88,
      fetchImpl: fetchMock,
    });

    expect(evidence).toContain('task="Test"');
    expect(evidence).not.toContain('Build stage');
    expect(evidence).not.toContain('Build phase');
    expect(evidence).not.toContain('Build job');
  });

  it('falls back to failed job wrappers when no failed task record exists', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes('/timeline')) {
        return new Response(
          JSON.stringify({
            records: [
              { name: 'Build stage', type: 'Stage', result: 'failed' },
              {
                name: 'Build job',
                type: 'Job',
                result: 'failed',
                issues: [{ message: 'Job aborted' }],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    });

    const evidence = await getAdoBuildFailureEvidence({
      repositoryFullName: 'acme/Platform/backend',
      buildId: 88,
      fetchImpl: fetchMock,
    });

    expect(evidence).toContain('task="Build job"');
    expect(evidence).toContain('Job aborted');
    expect(evidence).not.toContain('Build stage');
  });

  it('tolerates null log and issues fields on real timeline records', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes('/timeline')) {
        return new Response(
          JSON.stringify({
            records: [
              // Real ADO sends explicit nulls on wrapper/pending records.
              { name: 'Stage', type: 'Stage', result: 'failed', log: null },
              {
                name: 'Test',
                type: 'Task',
                result: 'failed',
                log: { id: 7 },
                issues: null,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (href.includes('/logs/7')) {
        return new Response('AssertionError: boom\n', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const evidence = await getAdoBuildFailureEvidence({
      repositoryFullName: 'acme/Platform/backend',
      buildId: 88,
      fetchImpl: fetchMock,
    });

    expect(evidence).toContain('task="Test"');
    expect(evidence).toContain('AssertionError: boom');
  });

  it('keeps a peer job-level failure alongside an unrelated task failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes('/timeline')) {
        return new Response(
          JSON.stringify({
            records: [
              { id: 'stage-1', name: 'CI', type: 'Stage', result: 'failed' },
              {
                id: 'job-a',
                parentId: 'stage-1',
                name: 'Unit tests',
                type: 'Job',
                result: 'failed',
              },
              {
                id: 'task-a',
                parentId: 'job-a',
                name: 'Jest',
                type: 'Task',
                result: 'failed',
                log: { id: 7 },
              },
              {
                id: 'job-b',
                parentId: 'stage-1',
                name: 'Agent job',
                type: 'Job',
                result: 'failed',
                issues: [{ message: 'Job cancelled by system' }],
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (href.includes('/logs/7')) {
        return new Response('AssertionError: boom\n', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const evidence = await getAdoBuildFailureEvidence({
      repositoryFullName: 'acme/Platform/backend',
      buildId: 88,
      fetchImpl: fetchMock,
    });

    expect(evidence).toContain('task="Jest"');
    expect(evidence).toContain('task="Agent job"');
    expect(evidence).toContain('Job cancelled by system');
    expect(evidence).not.toContain('Unit tests');
    expect(evidence).not.toContain('CI');
  });
});

describe('selectInnermostFailedAdoTimelineRecords', () => {
  it('drops cascade wrappers when parent links are present', () => {
    const selected = selectInnermostFailedAdoTimelineRecords([
      { id: 'stage', type: 'Stage', result: 'failed', name: 'Stage' },
      {
        id: 'job',
        parentId: 'stage',
        type: 'Job',
        result: 'failed',
        name: 'Job',
      },
      {
        id: 'task',
        parentId: 'job',
        type: 'Task',
        result: 'failed',
        name: 'Task',
      },
    ]);

    expect(selected.map((record) => record.id)).toEqual(['task']);
  });

  it('retains independent job failures when a sibling has a failed task', () => {
    const selected = selectInnermostFailedAdoTimelineRecords([
      { id: 'stage', type: 'Stage', result: 'failed', name: 'Stage' },
      {
        id: 'job-a',
        parentId: 'stage',
        type: 'Job',
        result: 'failed',
        name: 'Job A',
      },
      {
        id: 'task-a',
        parentId: 'job-a',
        type: 'Task',
        result: 'failed',
        name: 'Task A',
      },
      {
        id: 'job-b',
        parentId: 'stage',
        type: 'Job',
        result: 'failed',
        name: 'Job B',
      },
    ]);

    expect(selected.map((record) => record.id).sort()).toEqual([
      'job-b',
      'task-a',
    ]);
  });
});

describe('normalizeAdoLinkedAccountKey', () => {
  it('lowercases and trims so the link and webhook sides agree', () => {
    expect(
      normalizeAdoLinkedAccountKey('  Grace@Roomote.OnMicrosoft.com '),
    ).toBe('grace@roomote.onmicrosoft.com');
    expect(normalizeAdoLinkedAccountKey('grace@roomote.onmicrosoft.com')).toBe(
      'grace@roomote.onmicrosoft.com',
    );
  });

  it('returns null for empty or missing values', () => {
    expect(normalizeAdoLinkedAccountKey('')).toBeNull();
    expect(normalizeAdoLinkedAccountKey('   ')).toBeNull();
    expect(normalizeAdoLinkedAccountKey(null)).toBeNull();
    expect(normalizeAdoLinkedAccountKey(undefined)).toBeNull();
  });
});
