const mockGetIosAppConnection = vi.hoisted(() => vi.fn());

vi.mock('@roomote/sdk/server', () => ({
  getIosAppConnection: mockGetIosAppConnection,
}));

import { GET } from '../route';

describe('apple-app-site-association', () => {
  it('lists the deployment app id for Session and task links', async () => {
    mockGetIosAppConnection.mockResolvedValue({
      teamId: 'ABCDE12345',
      keyId: 'KEY1234567',
      bundleId: 'com.example.roomote',
      enabled: true,
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    await expect(response.json()).resolves.toEqual({
      applinks: {
        details: [
          {
            appIDs: ['ABCDE12345.com.example.roomote'],
            components: [{ '/': '/sessions/*' }, { '/': '/task/*' }],
          },
        ],
      },
    });
  });

  it('is absent until the iOS app is configured', async () => {
    mockGetIosAppConnection.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(404);
  });
});
