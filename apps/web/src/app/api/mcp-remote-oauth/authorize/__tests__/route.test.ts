import { NextRequest } from 'next/server';

const {
  mockAuthorize,
  mockGetClient,
  mockCreateCode,
  mockCreateConsentToken,
  mockConsumeConsentToken,
} = vi.hoisted(() => ({
  mockAuthorize: vi.fn(),
  mockGetClient: vi.fn(),
  mockCreateCode: vi.fn(),
  mockCreateConsentToken: vi.fn(),
  mockConsumeConsentToken: vi.fn(),
}));

vi.mock('@/lib/server', () => ({ authorize: mockAuthorize }));
vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: async () => ({
    R_APP_URL: 'https://roomote.example',
    TRPC_URL: 'https://api.example.com',
  }),
}));
vi.mock('@/lib/server/mcp-remote-oauth', () => ({
  getRemoteMcpOAuthClient: mockGetClient,
  createRemoteMcpAuthorizationCode: mockCreateCode,
  createRemoteMcpConsentToken: mockCreateConsentToken,
  consumeRemoteMcpConsentToken: mockConsumeConsentToken,
}));

import { GET, POST } from '../route';

const clientId = '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568';
const redirectUri = 'https://client.example/callback';

function authorizeRequest(options?: {
  approved?: boolean;
  consentToken?: string;
  redirectUri?: string;
  resource?: string | null;
}) {
  const url = new URL('https://roomote.example/api/mcp-remote-oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', options?.redirectUri ?? redirectUri);
  url.searchParams.set('state', 'client-state');
  url.searchParams.set('code_challenge', 'a'.repeat(43));
  url.searchParams.set('code_challenge_method', 'S256');
  if (options?.resource !== null) {
    url.searchParams.set(
      'resource',
      options?.resource ?? 'https://roomote.example/mcp',
    );
  }
  url.searchParams.set('scope', 'mcp:roomote');
  if (!options?.approved) return new NextRequest(url);

  return new NextRequest(url, {
    method: 'POST',
    body: new URLSearchParams({
      ...(options.consentToken ? { consent_token: options.consentToken } : {}),
    }),
  });
}

describe('GET /api/mcp-remote-oauth/authorize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClient.mockResolvedValue({
      clientId,
      clientName: 'Claude Code',
      redirectUris: [redirectUri],
    });
    mockCreateConsentToken.mockResolvedValue('consent-token');
    mockConsumeConsentToken.mockResolvedValue(true);
  });

  it('continues through browser sign-in before issuing a code', async () => {
    mockAuthorize.mockResolvedValue({ success: false });

    const response = await GET(authorizeRequest());
    const location = new URL(response.headers.get('location')!);

    expect(location.origin).toBe('https://roomote.example');
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('redirect_url')).toContain(
      '/api/mcp-remote-oauth/authorize?',
    );
    expect(mockCreateCode).not.toHaveBeenCalled();
  });

  it('requires explicit approval before issuing a code', async () => {
    mockAuthorize.mockResolvedValue({ success: true, userId: 'user-1' });

    const response = await GET(authorizeRequest());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('Authorize Claude Code?');
    expect(html).toContain('Allow access');
    expect(html).toContain('/logos/roomote-wordmark.svg');
    expect(html).toContain(
      'This gives Claude Code access to Roomote using your account.',
    );
    expect(html).toContain('Claude Code will be able to:');
    expect(html).toContain('name="consent_token" value="consent-token"');
    expect(response.headers.get('content-security-policy')).toContain(
      "form-action 'self' https://client.example",
    );
    expect(response.headers.get('content-security-policy')).toContain(
      "img-src 'self'",
    );
    expect(mockCreateConsentToken).toHaveBeenCalledWith({
      userId: 'user-1',
      requestTarget: expect.stringContaining(
        '/api/mcp-remote-oauth/authorize?',
      ),
    });
    expect(mockCreateCode).not.toHaveBeenCalled();
  });

  it('issues a resource-bound code after approval', async () => {
    mockAuthorize.mockResolvedValue({ success: true, userId: 'user-1' });
    mockCreateCode.mockResolvedValue('authorization-code');

    const response = await POST(
      authorizeRequest({ approved: true, consentToken: 'consent-token' }),
    );
    const location = new URL(response.headers.get('location')!);

    expect(response.status).toBe(303);
    expect(location.toString()).toBe(
      'https://client.example/callback?code=authorization-code&state=client-state',
    );
    expect(mockCreateCode).toHaveBeenCalledWith({
      userId: 'user-1',
      clientId,
      redirectUri,
      codeChallenge: 'a'.repeat(43),
      resource: 'https://roomote.example/mcp',
      scopes: ['mcp:roomote'],
    });
    expect(mockConsumeConsentToken).toHaveBeenCalledWith('consent-token', {
      userId: 'user-1',
      requestTarget: expect.stringContaining(
        '/api/mcp-remote-oauth/authorize?',
      ),
    });
  });

  it('returns Codex Desktop clients through their requested app callback', async () => {
    const codexRedirectUri = 'codex://connector/oauth_callback';
    mockAuthorize.mockResolvedValue({ success: true, userId: 'user-1' });
    mockGetClient.mockResolvedValue({
      clientId,
      clientName: 'Codex',
      redirectUris: [codexRedirectUri],
    });
    mockCreateCode.mockResolvedValue('authorization-code');

    const consentResponse = await GET(
      authorizeRequest({ redirectUri: codexRedirectUri }),
    );
    const html = await consentResponse.text();

    expect(html).toContain(
      'Roomote will send the authorization result to <code>codex://connector/oauth_callback</code>.',
    );
    expect(consentResponse.headers.get('content-security-policy')).toContain(
      "form-action 'self' codex:",
    );

    const response = await POST(
      authorizeRequest({
        approved: true,
        consentToken: 'consent-token',
        redirectUri: codexRedirectUri,
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'codex://connector/oauth_callback?code=authorization-code&state=client-state',
    );
    expect(mockCreateCode).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri: codexRedirectUri }),
    );
  });

  it('returns Cursor through its requested app callback', async () => {
    const cursorRedirectUri = 'cursor://anysphere.cursor-mcp/oauth/callback';
    mockAuthorize.mockResolvedValue({ success: true, userId: 'user-1' });
    mockGetClient.mockResolvedValue({
      clientId,
      clientName: 'Cursor',
      redirectUris: [cursorRedirectUri],
    });
    mockCreateCode.mockResolvedValue('authorization-code');

    const consentResponse = await GET(
      authorizeRequest({ redirectUri: cursorRedirectUri }),
    );
    const html = await consentResponse.text();

    expect(html).toContain(
      'Roomote will send the authorization result to <code>cursor://anysphere.cursor-mcp/oauth/callback</code>.',
    );
    expect(consentResponse.headers.get('content-security-policy')).toContain(
      "form-action 'self' cursor:",
    );

    const response = await POST(
      authorizeRequest({
        approved: true,
        consentToken: 'consent-token',
        redirectUri: cursorRedirectUri,
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'cursor://anysphere.cursor-mcp/oauth/callback?code=authorization-code&state=client-state',
    );
    expect(mockCreateCode).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri: cursorRedirectUri }),
    );
  });

  it('returns Claude Code through its requested loopback callback', async () => {
    const claudeRedirectUri = 'http://localhost:54545/callback';
    mockAuthorize.mockResolvedValue({ success: true, userId: 'user-1' });
    mockGetClient.mockResolvedValue({
      clientId,
      clientName: 'Claude Code',
      redirectUris: [claudeRedirectUri],
    });
    mockCreateCode.mockResolvedValue('authorization-code');

    const consentResponse = await GET(
      authorizeRequest({ redirectUri: claudeRedirectUri }),
    );
    const html = await consentResponse.text();

    expect(html).toContain(
      'Roomote will send the authorization result to <code>http://localhost:54545/callback</code>.',
    );
    expect(consentResponse.headers.get('content-security-policy')).toContain(
      "form-action 'self' http://localhost:54545",
    );

    const response = await POST(
      authorizeRequest({
        approved: true,
        consentToken: 'consent-token',
        redirectUri: claudeRedirectUri,
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'http://localhost:54545/callback?code=authorization-code&state=client-state',
    );
    expect(mockCreateCode).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri: claudeRedirectUri }),
    );
  });

  it('rejects a callback that does not exactly match the registered URI', async () => {
    mockGetClient.mockResolvedValue({
      clientId,
      clientName: 'Example App',
      redirectUris: ['example-app:/oauth/callback'],
    });

    const response = await GET(
      authorizeRequest({ redirectUri: 'example-app:/oauth/other' }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_request',
    });
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockCreateConsentToken).not.toHaveBeenCalled();
    expect(mockCreateCode).not.toHaveBeenCalled();
  });

  it('defaults an omitted resource to the Roomote MCP endpoint', async () => {
    mockAuthorize.mockResolvedValue({ success: true, userId: 'user-1' });
    mockCreateCode.mockResolvedValue('authorization-code');

    const response = await POST(
      authorizeRequest({
        approved: true,
        consentToken: 'consent-token',
        resource: null,
      }),
    );

    expect(response.status).toBe(303);
    expect(mockCreateCode).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'https://roomote.example/mcp' }),
    );
  });

  it('rejects approval POSTs without the one-time consent token', async () => {
    mockAuthorize.mockResolvedValue({ success: true, userId: 'user-1' });

    const response = await POST(authorizeRequest({ approved: true }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_request',
    });
    expect(mockCreateCode).not.toHaveBeenCalled();
  });
});
