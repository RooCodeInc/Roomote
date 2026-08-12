import { NextRequest } from 'next/server';

const { mockRegistrationAllowed, mockRegisterClient } = vi.hoisted(() => ({
  mockRegistrationAllowed: vi.fn(),
  mockRegisterClient: vi.fn(),
}));

vi.mock('@/lib/server/mcp-remote-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/mcp-remote-oauth')>()),
  isRemoteMcpRegistrationAllowed: mockRegistrationAllowed,
  registerRemoteMcpOAuthClient: mockRegisterClient,
}));

import { POST } from '../route';

function registrationRequest(
  redirectUri: string,
  grantTypes: string[] = ['authorization_code'],
) {
  return new NextRequest(
    'https://roomote.example/api/mcp-remote-oauth/register',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test client',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: grantTypes,
      }),
    },
  );
}

describe('POST /api/mcp-remote-oauth/register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistrationAllowed.mockResolvedValue(true);
  });

  it('registers an HTTPS callback for a public client', async () => {
    mockRegisterClient.mockResolvedValue({
      clientId: '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568',
      clientName: 'Test client',
      redirectUris: ['https://client.example/callback'],
      grantTypes: ['authorization_code'],
    });

    const response = await POST(
      registrationRequest('https://client.example/callback'),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      client_id: '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568',
      token_endpoint_auth_method: 'none',
    });
    expect(mockRegistrationAllowed).toHaveBeenCalledWith(
      JSON.stringify({
        clientName: 'Test client',
        redirectUris: ['https://client.example/callback'],
        grantTypes: ['authorization_code'],
      }),
    );
  });

  it('accepts clients that advertise refresh-token fallback support', async () => {
    mockRegisterClient.mockResolvedValue({
      clientId: '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568',
      clientName: 'Test client',
      redirectUris: ['http://localhost:54545/callback'],
      grantTypes: ['authorization_code', 'refresh_token'],
    });

    const response = await POST(
      registrationRequest('http://localhost:54545/callback', [
        'authorization_code',
        'refresh_token',
      ]),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      grant_types: ['authorization_code', 'refresh_token'],
    });
  });

  it('registers Cursor with its desktop, web, and loopback callbacks', async () => {
    const redirectUris = [
      'cursor://anysphere.cursor-mcp/oauth/callback',
      'https://www.cursor.com/agents/mcp/oauth/callback',
      'http://localhost:8787/callback',
    ];
    mockRegisterClient.mockResolvedValue({
      clientId: '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568',
      clientName: 'Cursor',
      redirectUris,
      grantTypes: ['authorization_code', 'refresh_token'],
    });

    const response = await POST(
      new NextRequest('https://roomote.example/api/mcp-remote-oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Cursor',
          redirect_uris: redirectUris,
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          logo_uri: 'https://cursor.example/logo.svg',
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      client_name: 'Cursor',
      redirect_uris: redirectUris,
    });
    expect(mockRegisterClient).toHaveBeenCalledWith({
      clientName: 'Cursor',
      redirectUris,
      grantTypes: ['authorization_code', 'refresh_token'],
    });
  });

  it('rejects a non-loopback HTTP callback', async () => {
    const response = await POST(
      registrationRequest('http://client.example/callback'),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_client_metadata',
    });
    expect(mockRegisterClient).not.toHaveBeenCalled();
    expect(mockRegistrationAllowed).not.toHaveBeenCalled();
  });

  it('rate limits anonymous client registration before writing Redis', async () => {
    mockRegistrationAllowed.mockResolvedValue(false);

    const response = await POST(
      registrationRequest('https://client.example/callback'),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3600');
    await expect(response.json()).resolves.toEqual({
      error: 'temporarily_unavailable',
    });
    expect(mockRegisterClient).not.toHaveBeenCalled();
  });

  it('returns a temporary error when the registered-client cap is full', async () => {
    mockRegisterClient.mockRejectedValue(new Error('capacity reached'));

    const response = await POST(
      registrationRequest('https://client.example/callback'),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'temporarily_unavailable',
    });
  });

  it('rejects oversized redirect URI values before storing a client', async () => {
    const response = await POST(
      registrationRequest(`https://client.example/${'a'.repeat(2_100)}`),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_client_metadata',
    });
    expect(mockRegisterClient).not.toHaveBeenCalled();
  });
});
