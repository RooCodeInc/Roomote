import { describe, expect, it, vi } from 'vitest';

import {
  TeamsBotCredentialValidationError,
  validateTeamsBotCredentials,
} from '../teams-credential-validation';

function buildTokenErrorResponse(body: unknown, status = 401) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function expectValidationError(
  promise: Promise<void>,
): Promise<TeamsBotCredentialValidationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TeamsBotCredentialValidationError);
    return error as TeamsBotCredentialValidationError;
  }

  throw new Error('Expected validateTeamsBotCredentials to reject.');
}

describe('validateTeamsBotCredentials', () => {
  it('resolves when Microsoft issues a token for the credentials', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ access_token: 'token', expires_in: 3600 }),
    );

    await expect(
      validateTeamsBotCredentials({
        appId: 'app-id',
        appPassword: 'app-password',
        tenantId: 'tenant-id',
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token',
    );
    expect(String(init.body)).toContain('grant_type=client_credentials');
  });

  it('blames the client secret for AADSTS7000215', async () => {
    const error = await expectValidationError(
      validateTeamsBotCredentials({
        appId: 'app-id',
        appPassword: 'wrong-secret',
        fetch: (async () =>
          buildTokenErrorResponse({
            error: 'invalid_client',
            error_description:
              'AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID.\r\nTrace ID: abc\r\nCorrelation ID: def',
            error_codes: [7000215],
          })) as unknown as typeof fetch,
      }),
    );

    expect(error.code).toBe('invalid_app_password');
    expect(error.field).toBe('app_password');
    expect(error.detail).toBe(
      'AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID.',
    );
  });

  it('blames the app id for AADSTS700016', async () => {
    const error = await expectValidationError(
      validateTeamsBotCredentials({
        appId: '00000000-0000-0000-0000-000000000001',
        appPassword: 'app-password',
        tenantId: '00000000-0000-0000-0000-000000000002',
        fetch: (async () =>
          buildTokenErrorResponse({
            error: 'unauthorized_client',
            error_description:
              "AADSTS700016: Application with identifier '00000000-0000-0000-0000-000000000001' was not found in the directory 'contoso'.\r\nTrace ID: abc",
            error_codes: [700016],
          })) as unknown as typeof fetch,
      }),
    );

    expect(error.code).toBe('invalid_app_id');
    expect(error.field).toBe('app_id');
  });

  it('blames the tenant for AADSTS90002', async () => {
    const error = await expectValidationError(
      validateTeamsBotCredentials({
        appId: 'app-id',
        appPassword: 'app-password',
        tenantId: 'not-a-tenant',
        fetch: (async () =>
          buildTokenErrorResponse(
            {
              error: 'invalid_request',
              error_description:
                "AADSTS90002: Tenant 'not-a-tenant' not found.",
              error_codes: [90002],
            },
            400,
          )) as unknown as typeof fetch,
      }),
    );

    expect(error.code).toBe('invalid_tenant_id');
    expect(error.field).toBe('tenant_id');
  });

  it('reads AADSTS codes out of the description when error_codes is absent', async () => {
    const error = await expectValidationError(
      validateTeamsBotCredentials({
        appId: 'app-id',
        appPassword: 'expired-secret',
        fetch: (async () =>
          buildTokenErrorResponse({
            error: 'invalid_client',
            error_description:
              "AADSTS7000222: The provided client secret keys for app 'app-id' are expired.",
          })) as unknown as typeof fetch,
      }),
    );

    expect(error.code).toBe('expired_app_password');
    expect(error.field).toBe('app_password');
  });

  it('reports an unnamed rejection for unrecognized failures', async () => {
    const error = await expectValidationError(
      validateTeamsBotCredentials({
        appId: 'app-id',
        appPassword: 'app-password',
        fetch: (async () =>
          new Response('<html>gateway error</html>', {
            status: 502,
          })) as unknown as typeof fetch,
      }),
    );

    expect(error.code).toBe('rejected');
    expect(error.field).toBeNull();
    expect(error.message).toContain('HTTP 502');
  });

  it('separates an unreachable token endpoint from rejected credentials', async () => {
    const error = await expectValidationError(
      validateTeamsBotCredentials({
        appId: 'app-id',
        appPassword: 'app-password',
        fetch: (async () => {
          throw new TypeError('fetch failed');
        }) as unknown as typeof fetch,
      }),
    );

    expect(error.code).toBe('unreachable');
    expect(error.field).toBeNull();
  });

  it('rejects empty credentials without calling Microsoft', async () => {
    const fetchMock = vi.fn();

    const error = await expectValidationError(
      validateTeamsBotCredentials({
        appId: '  ',
        appPassword: 'app-password',
        fetch: fetchMock as unknown as typeof fetch,
      }),
    );

    expect(error.code).toBe('missing_credentials');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
