const {
  authorizeMock,
  bootstrapWebRuntimeEnvMock,
  buildOpenRouterAuthorizationUrlMock,
  generateCodeChallengeMock,
  generateCodeVerifierMock,
} = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  bootstrapWebRuntimeEnvMock: vi.fn(),
  buildOpenRouterAuthorizationUrlMock: vi.fn(),
  generateCodeChallengeMock: vi.fn(),
  generateCodeVerifierMock: vi.fn(),
}));

vi.mock('@/lib/server', () => ({
  authorize: authorizeMock,
}));

vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: bootstrapWebRuntimeEnvMock,
}));

vi.mock('@roomote/sdk/server', () => ({
  generateCodeVerifier: generateCodeVerifierMock,
  generateCodeChallenge: generateCodeChallengeMock,
}));

vi.mock('@/lib/server/openrouter-oauth', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/server/openrouter-oauth')
  >('@/lib/server/openrouter-oauth');
  return {
    ...actual,
    buildOpenRouterAuthorizationUrl: buildOpenRouterAuthorizationUrlMock,
  };
});

import { GET } from '../route';

function getSetCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };

  return headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
}

describe('GET /api/openrouter-oauth/initiate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeMock.mockResolvedValue({
      success: true,
      isAdmin: true,
    });
    bootstrapWebRuntimeEnvMock.mockResolvedValue({
      R_APP_URL: 'http://localhost:13000',
      R_PUBLIC_URL: 'https://customer.roomote.ai',
    });
    generateCodeVerifierMock.mockReturnValue('verifier-value');
    generateCodeChallengeMock.mockResolvedValue('challenge-value');
    buildOpenRouterAuthorizationUrlMock.mockReturnValue(
      'https://openrouter.ai/auth?callback_url=https%3A%2F%2Fcustomer.roomote.ai%2Fapi%2Fopenrouter-oauth%2Fcallback',
    );
  });

  it('builds callback_url and secure cookies from R_PUBLIC_URL when set', async () => {
    const response = await GET();

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://openrouter.ai/auth?callback_url=https%3A%2F%2Fcustomer.roomote.ai%2Fapi%2Fopenrouter-oauth%2Fcallback',
    );
    expect(buildOpenRouterAuthorizationUrlMock).toHaveBeenCalledWith({
      callbackUrl: 'https://customer.roomote.ai/api/openrouter-oauth/callback',
      codeChallenge: 'challenge-value',
    });

    const setCookie = getSetCookieHeaders(response).join('\n');
    expect(setCookie).toContain('openrouter-oauth-verifier=verifier-value');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/api/openrouter-oauth');
  });

  it('falls back to R_APP_URL when R_PUBLIC_URL is unset', async () => {
    bootstrapWebRuntimeEnvMock.mockResolvedValue({
      R_APP_URL: 'http://localhost:13000',
      R_PUBLIC_URL: undefined,
    });
    buildOpenRouterAuthorizationUrlMock.mockReturnValue(
      'https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A13000%2Fapi%2Fopenrouter-oauth%2Fcallback',
    );

    const response = await GET();

    expect(buildOpenRouterAuthorizationUrlMock).toHaveBeenCalledWith({
      callbackUrl: 'http://localhost:13000/api/openrouter-oauth/callback',
      codeChallenge: 'challenge-value',
    });

    const setCookie = getSetCookieHeaders(response).join('\n');
    expect(setCookie).toContain('openrouter-oauth-verifier=verifier-value');
    expect(setCookie).not.toMatch(/\bSecure\b/i);
    expect(response.headers.get('location')).toBe(
      'https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A13000%2Fapi%2Fopenrouter-oauth%2Fcallback',
    );
  });

  it('redirects unauthorized users to public setup with an error', async () => {
    authorizeMock.mockResolvedValue({
      success: true,
      isAdmin: false,
    });

    const response = await GET();

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://customer.roomote.ai/setup?step=env-vars&openrouter=error&reason=unauthorized',
    );
    expect(buildOpenRouterAuthorizationUrlMock).not.toHaveBeenCalled();
  });
});
