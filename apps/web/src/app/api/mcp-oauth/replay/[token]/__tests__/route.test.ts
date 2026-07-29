import { NextRequest } from 'next/server';

const {
  authorizeMock,
  bootstrapWebRuntimeEnvMock,
  getDefaultMcpConnectionRoleMock,
  getMcpIntegrationConnectionScopeMock,
  getMcpIntegrationMock,
  getMcpOauthReplayMock,
  insertReturningMock,
  onConflictDoUpdateMock,
  updateMcpOauthReplayMock,
} = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  bootstrapWebRuntimeEnvMock: vi.fn(),
  getDefaultMcpConnectionRoleMock: vi.fn(),
  getMcpIntegrationConnectionScopeMock: vi.fn(),
  getMcpIntegrationMock: vi.fn(),
  getMcpOauthReplayMock: vi.fn(),
  insertReturningMock: vi.fn(),
  onConflictDoUpdateMock: vi.fn(),
  updateMcpOauthReplayMock: vi.fn(),
}));

vi.mock('@/lib/server', () => ({ authorize: authorizeMock }));
vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: bootstrapWebRuntimeEnvMock,
}));
vi.mock('@roomote/db/server', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: onConflictDoUpdateMock.mockReturnValue({
          returning: insertReturningMock,
        }),
      })),
    })),
  },
  mcpConnections: {
    connectionRole: 'connectionRole',
    mcpId: 'mcpId',
    userId: 'userId',
  },
}));
vi.mock('@roomote/sdk/server', () => ({
  getMcpOauthReplay: getMcpOauthReplayMock,
  updateMcpOauthReplay: updateMcpOauthReplayMock,
}));
vi.mock('@roomote/types', () => ({
  getDefaultMcpConnectionRole: getDefaultMcpConnectionRoleMock,
  getMcpIntegration: getMcpIntegrationMock,
  getMcpIntegrationConnectionScope: getMcpIntegrationConnectionScopeMock,
}));

import { GET } from '../route';

const TOKEN = 'replay-token';

function buildRequest() {
  return new NextRequest(`http://localhost:3000/api/mcp-oauth/replay/${TOKEN}`);
}

describe('GET /api/mcp-oauth/replay/[token]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bootstrapWebRuntimeEnvMock.mockResolvedValue({
      R_APP_URL: 'http://localhost:3000',
      R_PUBLIC_URL: 'https://roomote.example',
    });
    authorizeMock.mockResolvedValue({
      success: true,
      userId: 'user-1',
    });
    getMcpOauthReplayMock.mockResolvedValue({
      mcpId: 'linear',
      connectionRole: 'default',
      redirectTo: '/settings/personal',
    });
    getMcpIntegrationMock.mockReturnValue({ id: 'linear' });
    getDefaultMcpConnectionRoleMock.mockReturnValue('default');
    getMcpIntegrationConnectionScopeMock.mockReturnValue('user');
    insertReturningMock.mockResolvedValue([{ id: 'connection-1' }]);
  });

  it('keeps the authenticated continuation on the public app origin', async () => {
    const response = await GET(buildRequest(), {
      params: Promise.resolve({ token: TOKEN }),
    });

    expect(response.headers.get('location')).toBe(
      'https://roomote.example/api/mcp-oauth/initiate/connection-1?redirectTo=%2Fsettings%2Fpersonal&replayToken=replay-token',
    );
    expect(onConflictDoUpdateMock).toHaveBeenCalledWith({
      target: ['userId', 'mcpId', 'connectionRole'],
      set: { updatedAt: expect.any(Date) },
    });
  });

  it('sends signed-out users to sign in on the public app origin', async () => {
    authorizeMock.mockResolvedValue({ success: false });

    const response = await GET(buildRequest(), {
      params: Promise.resolve({ token: TOKEN }),
    });

    expect(response.headers.get('location')).toBe(
      'https://roomote.example/sign-in?redirect_url=%2Fapi%2Fmcp-oauth%2Freplay%2Freplay-token',
    );
  });
});
