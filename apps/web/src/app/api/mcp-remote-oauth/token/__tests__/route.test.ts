import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';

const { mockConsumeCode, mockCreateToken } = vi.hoisted(() => ({
  mockConsumeCode: vi.fn(),
  mockCreateToken: vi.fn(),
}));

vi.mock('@roomote/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/auth')>()),
  createMcpAccessToken: mockCreateToken,
}));

vi.mock('@/lib/server/mcp-remote-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/mcp-remote-oauth')>()),
  consumeRemoteMcpAuthorizationCode: mockConsumeCode,
}));

import { POST } from '../route';

const verifier =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const resource = 'https://api.example.com/api/mcp-routing/roomote';

function tokenRequest(overrides: Record<string, string> = {}) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: 'authorization-code',
    client_id: '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568',
    redirect_uri: 'https://client.example/callback',
    code_verifier: verifier,
    resource,
    ...overrides,
  });
  return new NextRequest('https://roomote.example/api/mcp-remote-oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

describe('POST /api/mcp-remote-oauth/token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConsumeCode.mockResolvedValue({
      userId: 'user-1',
      clientId: '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568',
      redirectUri: 'https://client.example/callback',
      codeChallenge: challenge,
      resource,
      scopes: ['mcp:roomote'],
    });
    mockCreateToken.mockResolvedValue('access-token');
  });

  it('exchanges a bound PKCE code for a short-lived MCP token', async () => {
    const response = await POST(tokenRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      access_token: 'access-token',
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
    expect(mockConsumeCode).not.toHaveBeenCalled();
  });

  it('requires the token request to repeat the bound resource', async () => {
    const response = await POST(tokenRequest({ resource: '' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_request',
    });
    expect(mockConsumeCode).not.toHaveBeenCalled();
  });
});
