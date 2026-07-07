import {
  discoverOAuthEndpoints,
  discoverOAuthProtectedResourceMetadata,
  exchangeCodeForTokens,
  getPreferredTokenEndpointAuthMethod,
  refreshOAuthToken,
} from './oauth';

function createJsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
    ...init,
  });
}

function createTokenResponse() {
  return createJsonResponse({ access_token: 'access-token' });
}

describe('discoverOAuthEndpoints', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('discovers endpoints directly from same-origin auth metadata', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        issuer: 'https://mcp.sentry.dev',
        authorization_endpoint: 'https://mcp.sentry.dev/oauth/authorize',
        token_endpoint: 'https://mcp.sentry.dev/oauth/token',
        response_types_supported: ['code'],
      }),
    );

    const metadata = await discoverOAuthEndpoints('https://mcp.sentry.dev/mcp');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://mcp.sentry.dev/.well-known/oauth-authorization-server',
    );
    expect(metadata.authorization_endpoint).toBe(
      'https://mcp.sentry.dev/oauth/authorize',
    );
  });

  it('falls back to protected-resource metadata when direct auth discovery fails', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response('', { status: 404, statusText: 'Not Found' }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          authorization_servers: ['https://api.supabase.com'],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          issuer: 'https://api.supabase.com',
          authorization_endpoint: 'https://api.supabase.com/v1/oauth/authorize',
          token_endpoint: 'https://api.supabase.com/v1/oauth/token',
          registration_endpoint:
            'https://api.supabase.com/platform/oauth/apps/register',
          response_types_supported: ['code'],
        }),
      );

    const metadata = await discoverOAuthEndpoints(
      'https://mcp.supabase.com/mcp?read_only=true&features=database',
    );

    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://mcp.supabase.com/.well-known/oauth-authorization-server',
      'https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp?read_only=true&features=database',
      'https://api.supabase.com/.well-known/oauth-authorization-server',
    ]);
    expect(metadata.token_endpoint).toBe(
      'https://api.supabase.com/v1/oauth/token',
    );
  });

  it('uses resource_metadata advertised by the protected resource when needed', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response('', { status: 404, statusText: 'Not Found' }),
      )
      .mockResolvedValueOnce(
        new Response('', { status: 404, statusText: 'Not Found' }),
      )
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          statusText: 'Unauthorized',
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://resource.example.com/custom-metadata"',
          },
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          authorization_servers: ['https://issuer.example.com/oauth'],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          issuer: 'https://issuer.example.com/oauth',
          authorization_endpoint: 'https://issuer.example.com/oauth/authorize',
          token_endpoint: 'https://issuer.example.com/oauth/token',
          response_types_supported: ['code'],
        }),
      );

    const metadata = await discoverOAuthEndpoints(
      'https://resource.example.com/mcp',
    );

    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://resource.example.com/.well-known/oauth-authorization-server',
      'https://resource.example.com/.well-known/oauth-protected-resource/mcp',
      'https://resource.example.com/mcp',
      'https://resource.example.com/custom-metadata',
      'https://issuer.example.com/.well-known/oauth-authorization-server/oauth',
    ]);
    expect(metadata.authorization_endpoint).toBe(
      'https://issuer.example.com/oauth/authorize',
    );
  });
});

describe('discoverOAuthProtectedResourceMetadata', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns same-origin protected-resource metadata when available', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        resource: 'https://mcp.posthog.com/mcp',
        scopes_supported: ['openid', 'profile', 'dashboard:read'],
      }),
    );

    const metadata = await discoverOAuthProtectedResourceMetadata(
      'https://mcp.posthog.com/mcp',
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://mcp.posthog.com/.well-known/oauth-protected-resource/mcp',
    );
    expect(metadata?.scopes_supported).toEqual([
      'openid',
      'profile',
      'dashboard:read',
    ]);
  });

  it('falls back to the advertised resource_metadata hint when needed', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response('', { status: 404, statusText: 'Not Found' }),
      )
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          statusText: 'Unauthorized',
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://resource.example.com/custom-metadata"',
          },
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          resource: 'https://resource.example.com/mcp',
          scopes_supported: ['openid', 'email', 'insight:read'],
        }),
      );

    const metadata = await discoverOAuthProtectedResourceMetadata(
      'https://resource.example.com/mcp',
    );

    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://resource.example.com/.well-known/oauth-protected-resource/mcp',
      'https://resource.example.com/mcp',
      'https://resource.example.com/custom-metadata',
    ]);
    expect(metadata?.scopes_supported).toEqual([
      'openid',
      'email',
      'insight:read',
    ]);
  });
});

describe('getPreferredTokenEndpointAuthMethod', () => {
  it('prefers client_secret_post when the server supports it', () => {
    expect(
      getPreferredTokenEndpointAuthMethod({
        issuer: 'https://provider.example.com',
        authorization_endpoint: 'https://provider.example.com/authorize',
        token_endpoint: 'https://provider.example.com/token',
        response_types_supported: ['code'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      }),
    ).toBe('client_secret_post');
  });

  it('uses none when the server only advertises public clients', () => {
    expect(
      getPreferredTokenEndpointAuthMethod({
        issuer: 'https://provider.example.com',
        authorization_endpoint: 'https://provider.example.com/authorize',
        token_endpoint: 'https://provider.example.com/token',
        response_types_supported: ['code'],
        token_endpoint_auth_methods_supported: ['none'],
      }),
    ).toBe('none');
  });

  it('uses client_secret_basic when the server supports it but not client_secret_post', () => {
    expect(
      getPreferredTokenEndpointAuthMethod({
        issuer: 'https://provider.example.com',
        authorization_endpoint: 'https://provider.example.com/authorize',
        token_endpoint: 'https://provider.example.com/token',
        response_types_supported: ['code'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      }),
    ).toBe('client_secret_basic');
  });

  it('falls back to client_secret_post when the server omits supported methods', () => {
    expect(
      getPreferredTokenEndpointAuthMethod({
        issuer: 'https://provider.example.com',
        authorization_endpoint: 'https://provider.example.com/authorize',
        token_endpoint: 'https://provider.example.com/token',
        response_types_supported: ['code'],
      }),
    ).toBe('client_secret_post');
  });
});

describe('exchangeCodeForTokens', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue(createTokenResponse());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends client_id and client_secret in the body for client_secret_post clients', async () => {
    await exchangeCodeForTokens(
      'https://provider.example.com/token',
      'auth-code',
      'code-verifier',
      {
        client_id: 'client-id',
        client_secret: 'client-secret',
        token_endpoint_auth_method: 'client_secret_post',
      },
      'https://app.example.com/api/mcp-oauth/callback',
    );

    const [, init] = mockFetch.mock.calls[0] ?? [];
    const params = new URLSearchParams(String(init?.body));

    expect(params.get('client_id')).toBe('client-id');
    expect(params.get('client_secret')).toBe('client-secret');
  });

  it('omits client_secret from the body for public clients', async () => {
    await exchangeCodeForTokens(
      'https://provider.example.com/token',
      'auth-code',
      'code-verifier',
      {
        client_id: 'client-id',
        token_endpoint_auth_method: 'none',
      },
      'https://app.example.com/api/mcp-oauth/callback',
    );

    const [, init] = mockFetch.mock.calls[0] ?? [];
    const params = new URLSearchParams(String(init?.body));

    expect(params.get('client_id')).toBe('client-id');
    expect(params.has('client_secret')).toBe(false);
  });
});

describe('refreshOAuthToken', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue(createTokenResponse());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps refresh-token requests public when token_endpoint_auth_method is none', async () => {
    await refreshOAuthToken(
      'https://provider.example.com/token',
      {
        client_id: 'client-id',
        token_endpoint_auth_method: 'none',
      },
      'refresh-token',
    );

    const [, init] = mockFetch.mock.calls[0] ?? [];
    const params = new URLSearchParams(String(init?.body));

    expect(params.get('client_id')).toBe('client-id');
    expect(params.has('client_secret')).toBe(false);
  });
});
