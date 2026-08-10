import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAuthAccountsFindFirst,
  mockAuthAccountsUpdate,
  mockTransactionExecute,
  mockResolveDeploymentEnvVar,
} = vi.hoisted(() => ({
  mockAuthAccountsFindFirst: vi.fn(),
  mockAuthAccountsUpdate: vi.fn(),
  mockTransactionExecute: vi.fn(),
  mockResolveDeploymentEnvVar: vi.fn(async (name: string) => {
    const value = process.env[name]?.trim();
    return value || null;
  }),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      authAccounts: {
        findFirst: (...args: unknown[]) => mockAuthAccountsFindFirst(...args),
      },
    },
    update: (...args: unknown[]) => mockAuthAccountsUpdate(...args),
    transaction: async (callback: (tx: unknown) => unknown) =>
      callback({
        execute: (...args: unknown[]) => mockTransactionExecute(...args),
        query: {
          authAccounts: {
            findFirst: (...args: unknown[]) =>
              mockAuthAccountsFindFirst(...args),
          },
        },
        update: (...args: unknown[]) => mockAuthAccountsUpdate(...args),
      }),
  },
  authAccounts: {
    id: 'authAccounts.id',
    accountId: 'authAccounts.accountId',
    providerId: 'authAccounts.providerId',
  },
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
  resolveDeploymentEnvVar: mockResolveDeploymentEnvVar,
  sql: vi.fn(),
}));

import {
  AdoApiError,
  clearAdoEntraTokenCache,
  describeAdoApiError,
  resolveAdoToken,
  resolveAdoTokenWithMetadata,
  validateAdoDelegatedCredentials,
  validateAdoEntraCredentials,
  validateAdoToken,
} from '../credentials';

const ENTRA_PERMISSION_GUIDANCE =
  'Check API permissions and organization membership.';

function mockEntraThenAdo(adoResponse: () => Response) {
  return vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (new URL(String(url)).hostname === 'login.microsoftonline.com') {
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

describe('Azure DevOps credentials', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    clearAdoEntraTokenCache();
    process.env.ADO_TOKEN = 'ado_deployment_token';
    process.env.ADO_ORGANIZATION = 'acme';
    delete process.env.ADO_BASE_URL;
    delete process.env.ADO_CLIENT_ID;
    delete process.env.ADO_CLIENT_SECRET;
    delete process.env.ADO_TENANT_ID;
    delete process.env.ADO_AUTH_MODE;
    delete process.env.ADO_LINKED_ACCOUNT_ID;
    mockAuthAccountsFindFirst.mockResolvedValue(null);
    mockAuthAccountsUpdate.mockReturnValue({
      set: vi
        .fn()
        .mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
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

    const first = await resolveAdoTokenWithMetadata();
    const second = await resolveAdoToken();

    expect(first?.token).toBe('header.payload.signature');
    expect(first?.expiresAt).toBeInstanceOf(Date);
    expect(second).toBe(first?.token);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns no expiry metadata for static PAT credentials', async () => {
    await expect(resolveAdoTokenWithMetadata()).resolves.toEqual({
      token: 'ado_deployment_token',
      expiresAt: null,
    });
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
    expect(mockTransactionExecute).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('validates Azure DevOps tokens against the repository listing the sync uses', async () => {
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
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from(':ado_test').toString('base64')}`,
        }),
      }),
    );
  });

  it('rejects definitively invalid Azure DevOps tokens during validation', async () => {
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
    const fetchMock = mockEntraThenAdo(
      () =>
        new Response(
          JSON.stringify({
            message:
              'TF401444: Please sign-in at least once as 11111111-2222-3333-4444-555555555555\\\\11111111-2222-3333-4444-555555555555\\\\66666666-7777-8888-9999-000000000000 in a web browser to enable access.',
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
    expect(result.status === 'invalid' && result.error).not.toContain(
      '11111111-2222-3333-4444-555555555555',
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

  it('classifies Microsoft Entra token endpoint failures', async () => {
    const invalid = await validateAdoEntraCredentials({
      clientId: 'client-id',
      clientSecret: 'wrong-secret',
      tenantId: 'tenant-id',
      organization: 'acme',
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('{}', { status: 401 })),
    });
    expect(invalid.status).toBe('invalid');

    const outage = await validateAdoEntraCredentials({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tenantId: 'tenant-id',
      organization: 'acme',
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('{}', { status: 503 })),
    });
    expect(outage.status).toBe('unknown');

    const ambiguousBadRequest = await validateAdoEntraCredentials({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tenantId: 'tenant-id',
      organization: 'acme',
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ error: 'temporarily_unavailable' }, { status: 400 }),
        ),
    });
    expect(ambiguousBadRequest.status).toBe('unknown');

    const network = await validateAdoEntraCredentials({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tenantId: 'tenant-id',
      organization: 'acme',
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new TypeError('fetch failed')),
    });
    expect(network.status).toBe('unknown');
  });

  it('classifies delegated connection failures', async () => {
    mockAuthAccountsFindFirst.mockResolvedValue({
      id: 'account-1',
      accountId: 'ado-user@example.com',
      accessToken: 'expired.token.value',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
    });

    const refused = await validateAdoDelegatedCredentials({
      linkedAccountId: 'ado-user@example.com',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tenantId: 'tenant-id',
      organization: 'acme',
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ error: 'invalid_grant' }, { status: 400 }),
        ),
    });
    expect(refused).toEqual({
      status: 'invalid',
      error: 'Azure DevOps delegated token refresh failed: 400 ',
    });

    mockAuthAccountsFindFirst.mockResolvedValue(null);
    await expect(
      validateAdoDelegatedCredentials({
        linkedAccountId: 'ado-user@example.com',
        organization: 'acme',
      }),
    ).resolves.toEqual({
      status: 'invalid',
      error:
        'No Azure DevOps account is connected. Connect with Microsoft again, then save.',
    });
  });

  it('validates the delegated account with its stored access token', async () => {
    mockAuthAccountsFindFirst.mockResolvedValue({
      id: 'account-1',
      accountId: 'ado-user@example.com',
      accessToken: 'header.payload.signature',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    });
    const result = await validateAdoDelegatedCredentials({
      linkedAccountId: 'ado-user@example.com',
      organization: 'acme',
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('{}', { status: 401 })),
    });

    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.error).toContain(
      ENTRA_PERMISSION_GUIDANCE,
    );
  });

  it('describes rejected credentials without rewriting unrelated failures', async () => {
    delete process.env.ADO_TOKEN;
    process.env.ADO_AUTH_MODE = 'entra';

    await expect(
      describeAdoApiError(new AdoApiError(401, 'Unauthorized')),
    ).resolves.toContain(ENTRA_PERMISSION_GUIDANCE);
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
    await expect(
      validateAdoToken({
        token: 'ado_test',
        organization: 'acme',
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockRejectedValue(new Error('network unreachable')),
      }),
    ).resolves.toEqual({
      status: 'unknown',
      error:
        'Could not verify the Azure DevOps credential: network unreachable',
    });
  });
});
