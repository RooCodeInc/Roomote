import { NextRequest } from 'next/server';

const mockRevokeRefreshSession = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/mcp-remote-oauth', () => ({
  revokeRemoteMcpRefreshSession: mockRevokeRefreshSession,
}));

import { POST } from '../route';

function revocationRequest(token = 'refresh-token') {
  return new NextRequest(
    'https://roomote.example/api/mcp-remote-oauth/revoke',
    {
      method: 'POST',
      body: new URLSearchParams({
        token,
        client_id: '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568',
      }),
    },
  );
}

describe('POST /api/mcp-remote-oauth/revoke', () => {
  beforeEach(() => vi.clearAllMocks());

  it('revokes a refresh session', async () => {
    const response = await POST(revocationRequest());

    expect(response.status).toBe(200);
    expect(mockRevokeRefreshSession).toHaveBeenCalledWith(
      'refresh-token',
      '2a871f7c-9fac-4b4a-a7d3-cd3f4a329568',
    );
  });

  it('returns success for an unknown token', async () => {
    mockRevokeRefreshSession.mockResolvedValue(undefined);

    const response = await POST(revocationRequest('unknown-token'));

    expect(response.status).toBe(200);
  });
});
