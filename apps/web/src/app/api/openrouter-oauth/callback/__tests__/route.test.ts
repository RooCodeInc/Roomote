import { NextRequest } from 'next/server';

const {
  authorizeMock,
  bootstrapWebRuntimeEnvMock,
  exchangeOpenRouterCodeForApiKeyMock,
  saveSetupNewModelConfigCommandMock,
} = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  bootstrapWebRuntimeEnvMock: vi.fn(),
  exchangeOpenRouterCodeForApiKeyMock: vi.fn(),
  saveSetupNewModelConfigCommandMock: vi.fn(),
}));

vi.mock('@/lib/server', () => ({
  authorize: authorizeMock,
}));

vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: bootstrapWebRuntimeEnvMock,
}));

vi.mock('@/lib/server/openrouter-oauth', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/server/openrouter-oauth')
  >('@/lib/server/openrouter-oauth');
  return {
    ...actual,
    exchangeOpenRouterCodeForApiKey: exchangeOpenRouterCodeForApiKeyMock,
  };
});

vi.mock('@/trpc/commands/setup-new', () => ({
  saveSetupNewModelConfigCommand: saveSetupNewModelConfigCommandMock,
}));

import { GET } from '../route';

function getSetCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };

  return headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
}

function buildRequest(query: string, cookie?: string) {
  return new NextRequest(
    `https://customer.roomote.ai/api/openrouter-oauth/callback${query}`,
    cookie
      ? {
          headers: {
            cookie,
          },
        }
      : undefined,
  );
}

describe('GET /api/openrouter-oauth/callback', () => {
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
    exchangeOpenRouterCodeForApiKeyMock.mockResolvedValue('sk-or-v1-test-key');
    saveSetupNewModelConfigCommandMock.mockResolvedValue(undefined);
  });

  it('redirects to R_PUBLIC_URL setup after a successful exchange', async () => {
    const response = await GET(
      buildRequest('?code=auth-code', 'openrouter-oauth-verifier=verifier-1'),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://customer.roomote.ai/setup?step=env-vars&openrouter=connected',
    );
    expect(exchangeOpenRouterCodeForApiKeyMock).toHaveBeenCalledWith({
      code: 'auth-code',
      codeVerifier: 'verifier-1',
    });
    expect(saveSetupNewModelConfigCommandMock).toHaveBeenCalledWith(
      {
        success: true,
        isAdmin: true,
      },
      {
        provider: 'openrouter',
        apiKey: 'sk-or-v1-test-key',
      },
    );

    const setCookie = getSetCookieHeaders(response).join('\n');
    expect(setCookie).toContain('openrouter-oauth-verifier=');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/api/openrouter-oauth');
  });

  it('redirects to R_APP_URL setup when R_PUBLIC_URL is unset', async () => {
    bootstrapWebRuntimeEnvMock.mockResolvedValue({
      R_APP_URL: 'http://localhost:13000',
      R_PUBLIC_URL: undefined,
    });

    const response = await GET(
      buildRequest('?code=auth-code', 'openrouter-oauth-verifier=verifier-1'),
    );

    expect(response.headers.get('location')).toBe(
      'http://localhost:13000/setup?step=env-vars&openrouter=connected',
    );

    const setCookie = getSetCookieHeaders(response).join('\n');
    expect(setCookie).not.toMatch(/\bSecure\b/i);
  });

  it('redirects to the public setup host on oauth errors', async () => {
    const response = await GET(
      buildRequest(
        '?error=access_denied&error_description=denied',
        'openrouter-oauth-verifier=verifier-1',
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://customer.roomote.ai/setup?step=env-vars&openrouter=error&reason=access_denied',
    );
    expect(exchangeOpenRouterCodeForApiKeyMock).not.toHaveBeenCalled();
  });
});
