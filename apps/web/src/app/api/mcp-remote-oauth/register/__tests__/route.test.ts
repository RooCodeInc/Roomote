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

function registrationRequest(redirectUri: string) {
  return new NextRequest(
    'https://roomote.example/api/mcp-remote-oauth/register',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test client',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
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
    });

    const response = await POST(
      registrationRequest('https://client.example/callback'),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      client_id: '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568',
      token_endpoint_auth_method: 'none',
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
});
