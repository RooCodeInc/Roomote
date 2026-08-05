import { NextRequest } from 'next/server';

const {
  authorizeMock,
  bootstrapWebRuntimeEnvMock,
  exchangeGitLabOAuthCodeMock,
  getSetupBootstrapStateMock,
  resolveDeploymentEnvVarMock,
  resolveGitLabBaseUrlMock,
  syncRepositoriesMock,
} = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  bootstrapWebRuntimeEnvMock: vi.fn(),
  exchangeGitLabOAuthCodeMock: vi.fn(),
  getSetupBootstrapStateMock: vi.fn(),
  resolveDeploymentEnvVarMock: vi.fn(),
  resolveGitLabBaseUrlMock: vi.fn(),
  syncRepositoriesMock: vi.fn(),
}));

vi.mock('@/lib/server', () => ({
  authorize: authorizeMock,
}));

vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: bootstrapWebRuntimeEnvMock,
}));

vi.mock('@/lib/server/setup-bootstrap-state', () => ({
  getSetupBootstrapState: getSetupBootstrapStateMock,
}));

vi.mock('@/trpc/commands/source-control', () => ({
  syncRepositoriesCommand: syncRepositoriesMock,
}));

vi.mock('@roomote/db/server', () => ({
  resolveDeploymentEnvVar: resolveDeploymentEnvVarMock,
}));

vi.mock('@roomote/gitlab', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/gitlab')>('@roomote/gitlab');
  return {
    ...actual,
    exchangeGitLabOAuthCode: exchangeGitLabOAuthCodeMock,
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

function buildRequest(query: string, cookie?: string) {
  return new NextRequest(
    `https://customer.roomote.ai/api/source-control/gitlab/oauth/callback${query}`,
    cookie
      ? {
          headers: {
            cookie,
          },
        }
      : undefined,
  );
}

describe('GET /api/source-control/gitlab/oauth/callback', () => {
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
    resolveGitLabBaseUrlMock.mockResolvedValue('https://gitlab.com');
    resolveDeploymentEnvVarMock.mockImplementation(async (name: string) => {
      if (name === 'GITLAB_CLIENT_ID') return 'gitlab-client-id';
      if (name === 'GITLAB_CLIENT_SECRET') return 'gitlab-client-secret';
      return null;
    });
    exchangeGitLabOAuthCodeMock.mockResolvedValue(undefined);
    getSetupBootstrapStateMock.mockResolvedValue({ setupOpen: true });
    syncRepositoriesMock.mockResolvedValue({ success: true, repositories: [] });
  });

  it('exchanges the code with redirect_uri built from R_PUBLIC_URL', async () => {
    const response = await GET(
      buildRequest(
        '?code=auth-code&state=state-1',
        'roomote-gitlab-oauth-state=state-1',
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://customer.roomote.ai/setup?step=source-control-connect&gitlab=connected&sync=1',
    );
    expect(exchangeGitLabOAuthCodeMock).toHaveBeenCalledWith({
      baseUrl: 'https://gitlab.com',
      clientId: 'gitlab-client-id',
      clientSecret: 'gitlab-client-secret',
      code: 'auth-code',
      redirectUri:
        'https://customer.roomote.ai/api/source-control/gitlab/oauth/callback',
    });

    const setCookie = getSetCookieHeaders(response).join('\n');
    expect(setCookie).toContain('roomote-gitlab-oauth-state=');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/api/source-control/gitlab/oauth');
  });

  it('redirects to R_APP_URL setup when R_PUBLIC_URL is unset', async () => {
    bootstrapWebRuntimeEnvMock.mockResolvedValue({
      R_APP_URL: 'http://localhost:3000',
      R_PUBLIC_URL: undefined,
    });

    const response = await GET(
      buildRequest(
        '?code=auth-code&state=state-1',
        'roomote-gitlab-oauth-state=state-1',
      ),
    );

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/setup?step=source-control-connect&gitlab=connected&sync=1',
    );
    expect(exchangeGitLabOAuthCodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri:
          'http://localhost:3000/api/source-control/gitlab/oauth/callback',
      }),
    );

    const setCookie = getSetCookieHeaders(response).join('\n');
    expect(setCookie).not.toMatch(/\bSecure\b/i);
  });

  it('returns a setup error when OAuth state does not match', async () => {
    const response = await GET(
      buildRequest(
        '?code=auth-code&state=wrong-state',
        'roomote-gitlab-oauth-state=state-1',
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://customer.roomote.ai/setup?step=source-control-connect&gitlab=error',
    );
    expect(exchangeGitLabOAuthCodeMock).not.toHaveBeenCalled();
  });

  it('returns to settings and syncs when setup is already complete', async () => {
    getSetupBootstrapStateMock.mockResolvedValue({ setupOpen: false });

    const response = await GET(
      buildRequest(
        '?code=auth-code&state=state-1',
        'roomote-gitlab-oauth-state=state-1; roomote-gitlab-oauth-return-to=%2Fsetup%3Fstep%3Dsource-control-connect',
      ),
    );

    expect(response.headers.get('location')).toBe(
      'https://customer.roomote.ai/settings/source-control?gitlab=connected',
    );
    expect(syncRepositoriesMock).toHaveBeenCalledWith(
      { success: true, isAdmin: true },
      { provider: 'gitlab' },
    );
  });

  it('reports a repository sync failure instead of a connected result', async () => {
    getSetupBootstrapStateMock.mockResolvedValue({ setupOpen: false });
    syncRepositoriesMock.mockResolvedValue({
      success: false,
      error: 'GitLab rejected the deployment credential.',
    });

    const response = await GET(
      buildRequest(
        '?code=auth-code&state=state-1',
        'roomote-gitlab-oauth-state=state-1; roomote-gitlab-oauth-return-to=%2Fsettings%2Fsource-control',
      ),
    );

    expect(response.headers.get('location')).toBe(
      'https://customer.roomote.ai/settings/source-control?gitlab=error',
    );
  });
});
