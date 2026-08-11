import { NextRequest } from 'next/server';

const { mockAuthorize, mockGetClient, mockCreateCode } = vi.hoisted(() => ({
  mockAuthorize: vi.fn(),
  mockGetClient: vi.fn(),
  mockCreateCode: vi.fn(),
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
}));

import { GET } from '../route';

const clientId = '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568';
const redirectUri = 'https://client.example/callback';

function authorizeRequest() {
  const url = new URL('https://roomote.example/api/mcp-remote-oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', 'client-state');
  url.searchParams.set('code_challenge', 'a'.repeat(43));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set(
    'resource',
    'https://api.example.com/api/mcp-routing/roomote',
  );
  url.searchParams.set('scope', 'mcp:roomote');
  return new NextRequest(url);
}

describe('GET /api/mcp-remote-oauth/authorize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClient.mockResolvedValue({
      clientId,
      redirectUris: [redirectUri],
    });
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

  it('issues a resource-bound code for the signed-in user', async () => {
    mockAuthorize.mockResolvedValue({ success: true, userId: 'user-1' });
    mockCreateCode.mockResolvedValue('authorization-code');

    const response = await GET(authorizeRequest());
    const location = new URL(response.headers.get('location')!);

    expect(location.toString()).toBe(
      'https://client.example/callback?code=authorization-code&state=client-state',
    );
    expect(mockCreateCode).toHaveBeenCalledWith({
      userId: 'user-1',
      clientId,
      redirectUri,
      codeChallenge: 'a'.repeat(43),
      resource: 'https://api.example.com/api/mcp-routing/roomote',
      scopes: ['mcp:roomote'],
    });
  });
});
