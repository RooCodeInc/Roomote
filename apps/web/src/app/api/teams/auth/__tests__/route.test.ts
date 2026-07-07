import { NextRequest } from 'next/server';

const {
  authorizeMock,
  bootstrapWebRuntimeEnvMock,
  fetchMock,
  handleAuthRequestMock,
} = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  bootstrapWebRuntimeEnvMock: vi.fn(),
  fetchMock: vi.fn(),
  handleAuthRequestMock: vi.fn(),
}));

vi.mock('@/lib/server', () => ({
  authorize: authorizeMock,
  getCallbackHost: (request: Request) => new URL(request.url).origin,
}));

vi.mock('@/lib/server/auth', () => ({
  handleAuthRequest: handleAuthRequestMock,
}));

vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: bootstrapWebRuntimeEnvMock,
}));

import { GET } from '../route';

describe('GET /api/teams/auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bootstrapWebRuntimeEnvMock.mockResolvedValue({
      TRPC_URL: 'https://api.example.com',
    });
    authorizeMock.mockResolvedValue({
      success: true,
      userId: 'user-1',
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, status: 'started' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    handleAuthRequestMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          url: 'https://login.microsoftonline.com/oauth',
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'better-auth.state=abc; Path=/; HttpOnly',
          },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  it('starts Microsoft sign-in when the Teams auth link is opened without a session', async () => {
    authorizeMock.mockResolvedValueOnce({
      success: false,
      error: 'Unauthorized',
    });

    const response = await GET(
      new NextRequest('http://localhost:13000/api/teams/auth?state=token-1'),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://login.microsoftonline.com/oauth',
    );
    expect(response.headers.get('set-cookie')).toContain(
      'better-auth.state=abc',
    );

    const authRequest = handleAuthRequestMock.mock.calls[0]?.[0] as Request;
    await expect(authRequest.clone().json()).resolves.toMatchObject({
      providerId: 'microsoft-entra-id',
      callbackURL: '/api/teams/auth?state=token-1',
      errorCallbackURL: '/api/teams/auth?state=token-1',
    });
    expect(authRequest.url).toBe(
      'http://localhost:13000/api/auth/sign-in/oauth2',
    );
    // Better Auth rejects POSTs without an Origin (MISSING_OR_NULL_ORIGIN).
    expect(authRequest.headers.get('origin')).toBe('http://localhost:13000');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resumes the pending Teams request when the account is already linked', async () => {
    const response = await GET(
      new NextRequest('http://localhost:13000/api/teams/auth?state=token-2'),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:13000/');
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.example.com/api/webhooks/teams/auth/resume'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ state: 'token-2' }),
      }),
    );
    expect(handleAuthRequestMock).not.toHaveBeenCalled();
  });

  it('starts Microsoft account linking when the signed-in user has not linked Teams yet', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          error: 'account_link_required',
        }),
        {
          status: 409,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const response = await GET(
      new NextRequest('http://localhost:13000/api/teams/auth?state=token-3', {
        headers: { cookie: 'session=abc' },
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://login.microsoftonline.com/oauth',
    );

    const authRequest = handleAuthRequestMock.mock.calls[0]?.[0] as Request;
    expect(authRequest.url).toBe('http://localhost:13000/api/auth/oauth2/link');
    expect(authRequest.headers.get('cookie')).toBe('session=abc');
    expect(authRequest.headers.get('origin')).toBe('http://localhost:13000');
    await expect(authRequest.clone().json()).resolves.toMatchObject({
      providerId: 'microsoft-entra-id',
      callbackURL: '/api/teams/auth?state=token-3&linked=1',
      errorCallbackURL: '/api/teams/auth?state=token-3&linked=1',
    });
  });
});
