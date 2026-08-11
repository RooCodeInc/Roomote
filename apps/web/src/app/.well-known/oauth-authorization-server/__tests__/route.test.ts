const mockBootstrapWebRuntimeEnv = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: mockBootstrapWebRuntimeEnv,
}));

import { GET } from '../route';

describe('Roomote OAuth authorization server metadata', () => {
  it('advertises rotating refresh tokens and revocation', async () => {
    mockBootstrapWebRuntimeEnv.mockResolvedValue({
      R_PUBLIC_URL: 'https://roomote.example',
      R_APP_URL: 'http://localhost:3000',
    });

    const response = await GET();

    await expect(response.json()).resolves.toMatchObject({
      issuer: 'https://roomote.example',
      grant_types_supported: ['authorization_code', 'refresh_token'],
      revocation_endpoint:
        'https://roomote.example/api/mcp-remote-oauth/revoke',
    });
  });
});
