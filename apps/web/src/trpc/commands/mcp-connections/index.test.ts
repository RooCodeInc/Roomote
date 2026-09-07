import {
  db,
  deploymentMcpEnablements,
  mcpConnections,
  userFactory,
} from '@roomote/db/server';

const { captureEventMock } = vi.hoisted(() => ({
  captureEventMock: vi.fn(),
}));

const { getDeploymentStaticOauthReadinessMock } = vi.hoisted(() => ({
  getDeploymentStaticOauthReadinessMock: vi.fn(),
}));

vi.mock('@roomote/telemetry/server', () => ({
  captureEvent: captureEventMock,
}));

vi.mock('@/lib/server/deployment-static-oauth', () => ({
  getDeploymentStaticOauthReadiness: getDeploymentStaticOauthReadinessMock,
}));

import type { UserAuthSuccess } from '@/types';

import {
  connectMcpCommand,
  saveAsanaConnectionCommand,
  setDeploymentMcpEnabledCommand,
} from './index';

const adminAuth = {
  success: true,
  userType: 'user',
  userId: 'mcp-connections-admin',
  isAdmin: true,
} as UserAuthSuccess;

async function cleanup() {
  await db.delete(mcpConnections);
  await db.delete(deploymentMcpEnablements);
}

describe('MCP connection lifecycle telemetry', () => {
  beforeAll(async () => {
    await userFactory.create({ id: adminAuth.userId });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    getDeploymentStaticOauthReadinessMock.mockResolvedValue('ready');
    await cleanup();
  });

  afterAll(cleanup);

  it('captures deployment enablement changes without connection PII', async () => {
    await setDeploymentMcpEnabledCommand(adminAuth, {
      mcpId: 'monday',
      enabled: true,
    });
    await setDeploymentMcpEnabledCommand(adminAuth, {
      mcpId: 'monday',
      enabled: false,
    });

    expect(captureEventMock).toHaveBeenNthCalledWith(1, 'integration_enabled', {
      userId: adminAuth.userId,
      properties: { integration_id: 'monday' },
    });
    expect(captureEventMock).toHaveBeenNthCalledWith(
      2,
      'integration_disabled',
      {
        userId: adminAuth.userId,
        properties: { integration_id: 'monday' },
      },
    );
  });

  it('captures a credential-backed connection only when first connected', async () => {
    await saveAsanaConnectionCommand(adminAuth, { accessToken: 'asana-token' });

    expect(captureEventMock).toHaveBeenCalledWith('integration_connected', {
      userId: adminAuth.userId,
      properties: { integration_id: 'asana' },
    });
    expect(captureEventMock).toHaveBeenCalledWith('integration_enabled', {
      userId: adminAuth.userId,
      properties: { integration_id: 'asana' },
    });

    captureEventMock.mockClear();
    await saveAsanaConnectionCommand(adminAuth, { accessToken: '' });

    expect(captureEventMock).not.toHaveBeenCalled();
  });

  it('keeps Linear identity metadata while restarting authorization', async () => {
    const previousAuthConfig = {
      type: 'oauth_client' as const,
      registered_redirect_uri: 'https://roomote.example/api/mcp-oauth/callback',
      client_id: 'linear-client',
      linearOrganizationId: 'linear-org-1',
      linearOrganizationName: 'Linear Org',
      linearOrganizationUrlKey: 'linear-org',
      appUserId: 'linear-app-user-1',
    };

    const [existing] = await db
      .insert(mcpConnections)
      .values({
        userId: null,
        mcpId: 'linear',
        connectionRole: 'linear_org_install',
        authConfig: previousAuthConfig,
        enabled: true,
        authStatus: 'authenticated',
        accessToken: 'old-access-token',
        refreshToken: 'old-refresh-token',
      })
      .returning({ id: mcpConnections.id });

    expect(existing).toBeDefined();
    if (!existing) {
      throw new Error('Expected the Linear connection fixture to be created');
    }

    await expect(
      connectMcpCommand(adminAuth, {
        mcpId: 'linear',
        role: 'linear_org_install',
      }),
    ).resolves.toBe(`/api/mcp-oauth/initiate/${existing.id}`);

    const reconnected = await db.query.mcpConnections.findFirst({
      where: (table, { eq: whereEq }) => whereEq(table.id, existing.id),
    });

    expect(reconnected).toMatchObject({
      authConfig: previousAuthConfig,
      enabled: false,
      authStatus: 'pending',
    });
    expect(reconnected?.refreshToken).toBeTruthy();
  });
});
