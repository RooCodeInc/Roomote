import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';

const {
  mockGetCode,
  mockConsumeCode,
  mockPromoteClient,
  mockCreateRefreshSession,
  mockGetRefreshSession,
  mockRotateRefreshToken,
  mockGetClient,
  mockCreateToken,
  mockBootstrapWebRuntimeEnv,
} = vi.hoisted(() => ({
  mockGetCode: vi.fn(),
  mockConsumeCode: vi.fn(),
  mockPromoteClient: vi.fn(),
  mockCreateRefreshSession: vi.fn(),
  mockGetRefreshSession: vi.fn(),
  mockRotateRefreshToken: vi.fn(),
  mockGetClient: vi.fn(),
  mockCreateToken: vi.fn(),
  mockBootstrapWebRuntimeEnv: vi.fn(),
}));

vi.mock('@roomote/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/auth')>()),
  createMcpAccessToken: mockCreateToken,
}));

vi.mock('@/lib/server/mcp-remote-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/mcp-remote-oauth')>()),
  getRemoteMcpAuthorizationCode: mockGetCode,
  consumeRemoteMcpAuthorizationCode: mockConsumeCode,
  promoteRemoteMcpOAuthClient: mockPromoteClient,
  createRemoteMcpRefreshSession: mockCreateRefreshSession,
  getRemoteMcpRefreshSession: mockGetRefreshSession,
  rotateRemoteMcpRefreshToken: mockRotateRefreshToken,
  getRemoteMcpOAuthClient: mockGetClient,
}));

vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: mockBootstrapWebRuntimeEnv,
}));

import { POST } from '../route';

const verifier =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const resource = 'https://api.example.com/mcp';

function tokenRequest(
  overrides: Record<string, string> = {},
  options?: { omitResource?: boolean },
) {
  const values: Record<string, string> = {
    grant_type: 'authorization_code',
    code: 'authorization-code',
    client_id: '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568',
    redirect_uri: 'https://client.example/callback',
    code_verifier: verifier,
    resource,
    ...overrides,
  };
  if (options?.omitResource) delete values.resource;
  const body = new URLSearchParams(values);
  return new NextRequest('https://roomote.example/api/mcp-remote-oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

function refreshRequest(
  overrides: Record<string, string> = {},
  options?: { omitResource?: boolean },
) {
  const values: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: 'session.refresh-token',
    client_id: '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568',
    resource,
    ...overrides,
  };
  if (options?.omitResource) delete values.resource;
  const body = new URLSearchParams(values);
  return new NextRequest('https://roomote.example/api/mcp-remote-oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

describe('POST /api/mcp-remote-oauth/token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCode.mockResolvedValue({
      userId: 'user-1',
      clientId: '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568',
      redirectUri: 'https://client.example/callback',
      codeChallenge: challenge,
      resource,
      scopes: ['mcp:roomote'],
    });
    mockConsumeCode.mockResolvedValue(true);
    mockPromoteClient.mockResolvedValue(true);
    mockCreateRefreshSession.mockResolvedValue('initial-refresh-token');
    mockGetRefreshSession.mockResolvedValue({
      sessionId: 'session',
      userId: 'user-1',
      clientId: '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568',
      resource,
      scopes: ['mcp:roomote'],
      currentTokenHash: 'token-hash',
      expiresAt: Math.floor(Date.now() / 1000) + 3_600,
    });
    mockRotateRefreshToken.mockResolvedValue({
      status: 'ok',
      refreshToken: 'rotated-refresh-token',
    });
    mockGetClient.mockResolvedValue({
      clientId: '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568',
      redirectUris: ['https://client.example/callback'],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    mockCreateToken.mockResolvedValue('access-token');
    mockBootstrapWebRuntimeEnv.mockResolvedValue({});
  });

  it('exchanges a bound PKCE code for a short-lived MCP token', async () => {
    const response = await POST(tokenRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      access_token: 'access-token',
      refresh_token: 'initial-refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'mcp:roomote',
    });
    expect(mockCreateToken).toHaveBeenCalledWith({
      userId: 'user-1',
      resource,
      scopes: ['mcp:roomote'],
      timeoutMs: 3_600_000,
    });
    expect(mockBootstrapWebRuntimeEnv).toHaveBeenCalledOnce();
    expect(mockConsumeCode).toHaveBeenCalledWith(
      'authorization-code',
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(mockPromoteClient).toHaveBeenCalledWith(
      '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568',
      'user-1',
    );
    expect(mockCreateRefreshSession).toHaveBeenCalledWith({
      userId: 'user-1',
      clientId: '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568',
      resource,
      scopes: ['mcp:roomote'],
    });
  });

  it('uses the authorization resource when the token request omits it', async () => {
    const response = await POST(tokenRequest({}, { omitResource: true }));

    expect(response.status).toBe(200);
    expect(mockCreateToken).toHaveBeenCalledWith(
      expect.objectContaining({ resource }),
    );
  });

  it('rotates a refresh token and issues a new access token', async () => {
    const response = await POST(refreshRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      access_token: 'access-token',
      refresh_token: 'rotated-refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'mcp:roomote',
    });
    expect(mockRotateRefreshToken).toHaveBeenCalledWith(
      'session.refresh-token',
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('uses the session resource when a refresh request omits it', async () => {
    const response = await POST(refreshRequest({}, { omitResource: true }));

    expect(response.status).toBe(200);
    expect(mockCreateToken).toHaveBeenCalledWith(
      expect.objectContaining({ resource }),
    );
  });

  it('does not issue a refresh token to an authorization-code-only client', async () => {
    mockGetClient.mockResolvedValue({
      clientId: '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568',
      redirectUris: ['https://client.example/callback'],
      grantTypes: ['authorization_code'],
    });

    const response = await POST(tokenRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      access_token: 'access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'mcp:roomote',
    });
    expect(mockCreateRefreshSession).not.toHaveBeenCalled();
  });

  it('does not burn a refresh token when the resource binding is wrong', async () => {
    const response = await POST(
      refreshRequest({ resource: 'https://other.example/mcp' }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_grant' });
    expect(mockRotateRefreshToken).not.toHaveBeenCalled();
    expect(mockCreateToken).not.toHaveBeenCalled();
  });

  it('rejects a refresh token whose rotation detects reuse', async () => {
    mockRotateRefreshToken.mockResolvedValue({ status: 'reuse' });

    const response = await POST(refreshRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_grant' });
  });

  it('rejects a verifier that does not match the authorization code', async () => {
    const response = await POST(
      tokenRequest({
        code_verifier:
          'zyxwvutsrqponmlkjihgfedcbaABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~',
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_grant' });
    expect(mockConsumeCode).not.toHaveBeenCalled();
    expect(mockCreateToken).not.toHaveBeenCalled();
  });

  it('rejects an exchange when its pending client registration expired', async () => {
    mockPromoteClient.mockResolvedValue(false);

    const response = await POST(tokenRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_grant' });
    expect(mockConsumeCode).not.toHaveBeenCalled();
    expect(mockCreateToken).not.toHaveBeenCalled();
  });

  it('returns an OAuth error for a malformed request body', async () => {
    const response = await POST(
      new NextRequest('https://roomote.example/api/mcp-remote-oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_request',
    });
    expect(mockGetCode).not.toHaveBeenCalled();
  });

  it('requires the token request to repeat the bound resource', async () => {
    const response = await POST(tokenRequest({ resource: '' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_request',
    });
    expect(mockGetCode).not.toHaveBeenCalled();
  });
});
