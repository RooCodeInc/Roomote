const {
  authorizeMock,
  bootstrapWebRuntimeEnvMock,
  createGitLabOAuthAuthorizationUrlMock,
  resolveDeploymentEnvVarMock,
  resolveGitLabBaseUrlMock,
} = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  bootstrapWebRuntimeEnvMock: vi.fn(),
  createGitLabOAuthAuthorizationUrlMock: vi.fn(),
  resolveDeploymentEnvVarMock: vi.fn(),
  resolveGitLabBaseUrlMock: vi.fn(),
}));

vi.mock('@/lib/server', () => ({
  authorize: authorizeMock,
}));

vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: bootstrapWebRuntimeEnvMock,
}));

vi.mock('@roomote/db/server', () => ({
  resolveDeploymentEnvVar: resolveDeploymentEnvVarMock,
}));

vi.mock('@roomote/gitlab', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/gitlab')>('@roomote/gitlab');
  return {
    ...actual,
    createGitLabOAuthAuthorizationUrl: createGitLabOAuthAuthorizationUrlMock,
    resolveGitLabBaseUrl: resolveGitLabBaseUrlMock,
  };
});

import { GET } from '../route';

function getSetCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };

  return headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
}

describe('GET /api/source-control/gitlab/oauth/authorize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeMock.mockResolvedValue({
      success: true,
      isAdmin: true,
    });
    bootstrapWebRuntimeEnvMock.mockResolvedValue({
      R_APP_URL: 'http://localhost:3000',
      R_PUBLIC_URL: 'https://customer.roomote.ai',
    });
    resolveDeploymentEnvVarMock.mockResolvedValue('gitlab-client-id');
    resolveGitLabBaseUrlMock.mockResolvedValue('https://gitlab.com');
    createGitLabOAuthAuthorizationUrlMock.mockReturnValue({
      url: 'https://gitlab.com/oauth/authorize?state=state-1',
      state: 'state-1',
    });
  });

  it('builds redirect_uri and secure cookies from R_PUBLIC_URL when set', async () => {
    const response = await GET();

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://gitlab.com/oauth/authorize?state=state-1',
    );
    expect(createGitLabOAuthAuthorizationUrlMock).toHaveBeenCalledWith({
      baseUrl: 'https://gitlab.com',
      clientId: 'gitlab-client-id',
      redirectUri:
        'https://customer.roomote.ai/api/source-control/gitlab/oauth/callback',
    });

    const setCookie = getSetCookieHeaders(response).join('\n');
    expect(setCookie).toContain('roomote-gitlab-oauth-state=state-1');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/api/source-control/gitlab/oauth');
  });

  it('falls back to R_APP_URL when R_PUBLIC_URL is unset', async () => {
    bootstrapWebRuntimeEnvMock.mockResolvedValue({
      R_APP_URL: 'http://localhost:3000',
      R_PUBLIC_URL: undefined,
    });

    const response = await GET();

    expect(createGitLabOAuthAuthorizationUrlMock).toHaveBeenCalledWith({
      baseUrl: 'https://gitlab.com',
      clientId: 'gitlab-client-id',
      redirectUri:
        'http://localhost:3000/api/source-control/gitlab/oauth/callback',
    });

    const setCookie = getSetCookieHeaders(response).join('\n');
    expect(setCookie).toContain('roomote-gitlab-oauth-state=state-1');
    expect(setCookie).not.toMatch(/\bSecure\b/i);
  });

  it('returns 401 when the user is not an admin', async () => {
    authorizeMock.mockResolvedValue({
      success: true,
      isAdmin: false,
    });

    const response = await GET();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
    expect(createGitLabOAuthAuthorizationUrlMock).not.toHaveBeenCalled();
  });
});
