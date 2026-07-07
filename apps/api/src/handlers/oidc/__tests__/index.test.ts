import { Hono } from 'hono';

import { oidcRouter } from '../index';

const {
  mockGetSandboxOidcDiscoveryDocument,
  mockGetSandboxOidcJwks,
  mockIsSandboxOidcConfigured,
} = vi.hoisted(() => ({
  mockGetSandboxOidcDiscoveryDocument: vi.fn(),
  mockGetSandboxOidcJwks: vi.fn(),
  mockIsSandboxOidcConfigured: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({
  SANDBOX_OIDC_METADATA_CACHE_CONTROL: 'public, max-age=300, must-revalidate',
  getSandboxOidcDiscoveryDocument: (...args: unknown[]) =>
    mockGetSandboxOidcDiscoveryDocument(...args),
  getSandboxOidcJwks: (...args: unknown[]) => mockGetSandboxOidcJwks(...args),
  isSandboxOidcConfigured: (...args: unknown[]) =>
    mockIsSandboxOidcConfigured(...args),
}));

describe('oidcRouter', () => {
  function createApp() {
    const app = new Hono();
    app.route('/', oidcRouter);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSandboxOidcConfigured.mockReturnValue(true);
    mockGetSandboxOidcDiscoveryDocument.mockReturnValue({
      issuer: 'https://api.roomote.test',
    });
    mockGetSandboxOidcJwks.mockReturnValue({
      keys: [{ kid: 'current-key' }],
    });
  });

  it('sets bounded cache headers on the discovery document', async () => {
    const response = await createApp().request(
      new Request('http://localhost/.well-known/openid-configuration'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=300, must-revalidate',
    );
    await expect(response.json()).resolves.toEqual({
      issuer: 'https://api.roomote.test',
    });
  });

  it('sets bounded cache headers on the JWKS response', async () => {
    const response = await createApp().request(
      new Request('http://localhost/api/oidc/jwks'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=300, must-revalidate',
    );
    await expect(response.json()).resolves.toEqual({
      keys: [{ kid: 'current-key' }],
    });
  });
});
