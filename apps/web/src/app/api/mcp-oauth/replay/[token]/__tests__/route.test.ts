import { NextRequest } from 'next/server';

const {
  authorizeMock,
  bootstrapWebRuntimeEnvMock,
  getDefaultMcpConnectionRoleMock,
  getMcpIntegrationConnectionScopeMock,
  getMcpIntegrationMock,
  getMcpOauthReplayMock,
  mcpConnectionsFindFirstMock,
  resolveCustomMcpAuthTargetMock,
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
  mcpConnectionsFindFirstMock: vi.fn(),
  resolveCustomMcpAuthTargetMock: vi.fn(),
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
    query: {
      mcpConnections: { findFirst: mcpConnectionsFindFirstMock },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: onConflictDoUpdateMock.mockReturnValue({
          returning: insertReturningMock,
        }),
      })),
    })),
  },
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: string, value: unknown) => ({ column, value })),
  isNull: vi.fn((column: string) => ({ column, isNull: true })),
  mcpConnections: {
    connectionRole: 'connectionRole',
    mcpId: 'mcpId',
    userId: 'userId',
  },
}));
vi.mock('@roomote/sdk/server', () => ({
  getMcpOauthReplay: getMcpOauthReplayMock,
  resolveCustomMcpAuthTarget: resolveCustomMcpAuthTargetMock,
  updateMcpOauthReplay: updateMcpOauthReplayMock,
}));
vi.mock('@roomote/types', () => ({
  getDefaultMcpConnectionRole: getDefaultMcpConnectionRoleMock,
  getMcpIntegration: getMcpIntegrationMock,
  getMcpIntegrationConnectionScope: getMcpIntegrationConnectionScopeMock,
  isCustomMcpConnectionId: (id: string) => id.startsWith('custom:'),
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
      isAdmin: true,
    });
    getMcpOauthReplayMock.mockResolvedValue({
      mcpId: 'linear',
      connectionRole: 'default',
      redirectTo: '/settings/personal',
    });
    getMcpIntegrationMock.mockReturnValue({ id: 'linear' });
    getDefaultMcpConnectionRoleMock.mockReturnValue('default');
    getMcpIntegrationConnectionScopeMock.mockReturnValue('user');
    resolveCustomMcpAuthTargetMock.mockResolvedValue(null);
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

  it('reuses the deployment connection for a custom MCP replay', async () => {
    getMcpOauthReplayMock.mockResolvedValue({
      mcpId: 'custom:server-1',
      connectionId: 'connection-custom-1',
      connectionRole: 'default',
      redirectTo: '/sessions/session-1',
      userId: 'user-1',
    });
    resolveCustomMcpAuthTargetMock.mockResolvedValue({
      serverId: 'server-1',
      name: 'accounting',
      url: 'https://mcp.example.com/mcp',
    });
    mcpConnectionsFindFirstMock.mockResolvedValue({
      id: 'connection-custom-1',
      mcpId: 'custom:server-1',
      userId: null,
    });

    const response = await GET(buildRequest(), {
      params: Promise.resolve({ token: TOKEN }),
    });

    expect(response.headers.get('location')).toBe(
      'https://roomote.example/api/mcp-oauth/initiate/connection-custom-1?redirectTo=%2Fsessions%2Fsession-1&replayToken=replay-token',
    );
    expect(insertReturningMock).not.toHaveBeenCalled();
    expect(updateMcpOauthReplayMock).not.toHaveBeenCalled();
  });

  it('does not let a non-admin use a custom MCP replay', async () => {
    authorizeMock.mockResolvedValue({
      success: true,
      userId: 'user-1',
      isAdmin: false,
    });
    getMcpOauthReplayMock.mockResolvedValue({
      mcpId: 'custom:server-1',
      connectionId: 'connection-custom-1',
      connectionRole: 'default',
      userId: 'user-1',
    });
    resolveCustomMcpAuthTargetMock.mockResolvedValue({
      serverId: 'server-1',
      name: 'accounting',
      url: 'https://mcp.example.com/mcp',
    });

    const response = await GET(buildRequest(), {
      params: Promise.resolve({ token: TOKEN }),
    });

    expect(response.headers.get('location')).toBe(
      'https://roomote.example/error?message=Unknown%20MCP%20integration',
    );
    expect(mcpConnectionsFindFirstMock).not.toHaveBeenCalled();
  });

  it('explains when a custom authorization link belongs to another admin', async () => {
    authorizeMock.mockResolvedValue({
      success: true,
      userId: 'user-2',
      isAdmin: true,
    });
    getMcpOauthReplayMock.mockResolvedValue({
      mcpId: 'custom:server-1',
      connectionId: 'connection-custom-1',
      connectionRole: 'default',
      userId: 'user-1',
    });

    const response = await GET(buildRequest(), {
      params: Promise.resolve({ token: TOKEN }),
    });

    expect(response.headers.get('location')).toBe(
      'https://roomote.example/error?message=This%20authorization%20link%20belongs%20to%20another%20administrator',
    );
    expect(resolveCustomMcpAuthTargetMock).not.toHaveBeenCalled();
  });
});
