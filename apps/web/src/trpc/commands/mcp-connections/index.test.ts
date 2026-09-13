import {
  db,
  deploymentMcpEnablements,
  mcpConnections,
  userFactory,
} from '@roomote/db/server';
import { isMcpConnectionVoiceConfig } from '@roomote/types';

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
  getVoiceConnectionCommand,
  getEffectiveMcpIntegrationsCommand,
  saveAsanaConnectionCommand,
  saveVoiceConnectionCommand,
  setDeploymentMcpEnabledCommand,
} from './index';

const adminAuth = {
  success: true,
  userType: 'user',
  userId: 'mcp-connections-admin',
  isAdmin: true,
} as UserAuthSuccess;
const memberAuth = {
  ...adminAuth,
  userId: 'mcp-connections-member',
  isAdmin: false,
} as UserAuthSuccess;

async function cleanup() {
  await db.delete(mcpConnections);
  await db.delete(deploymentMcpEnablements);
}

describe('MCP connection lifecycle telemetry', () => {
  beforeAll(async () => {
    await userFactory.create({ id: adminAuth.userId });
    await userFactory.create({ id: memberAuth.userId });
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

  it('persists the selected Voice voice while preserving an existing key', async () => {
    await saveVoiceConnectionCommand(adminAuth, {
      apiKey: 'sk-voice',
      voiceId: 'cedar',
    });

    const firstConnection = await db.query.mcpConnections.findFirst({
      where: (table, { eq: whereEq }) => whereEq(table.mcpId, 'voice'),
    });
    expect(isMcpConnectionVoiceConfig(firstConnection?.authConfig)).toBe(true);
    if (!isMcpConnectionVoiceConfig(firstConnection?.authConfig)) {
      throw new Error('Expected a Voice connection');
    }
    const encryptedApiKey = firstConnection.authConfig.encryptedApiKey;
    expect(firstConnection.authConfig.voiceId).toBe('cedar');
    expect(encryptedApiKey).not.toContain('sk-voice');

    await saveVoiceConnectionCommand(adminAuth, {
      apiKey: '',
      voiceId: 'coral',
    });

    const updatedConnection = await db.query.mcpConnections.findFirst({
      where: (table, { eq: whereEq }) => whereEq(table.mcpId, 'voice'),
    });
    expect(updatedConnection?.authConfig).toMatchObject({
      type: 'voice',
      encryptedApiKey,
      voiceId: 'coral',
    });
  });

  it('returns the default voice for a legacy Voice connection without a selection', async () => {
    await db.insert(mcpConnections).values({
      userId: null,
      mcpId: 'voice',
      connectionRole: 'default',
      authConfig: { type: 'voice', encryptedApiKey: 'legacy-encrypted-key' },
      enabled: true,
      authStatus: 'authenticated',
    });

    await expect(getVoiceConnectionCommand(adminAuth)).resolves.toMatchObject({
      source: 'connection',
      voiceId: 'marin',
    });
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

  it('projects effective status from correctly scoped connections', async () => {
    await db.insert(deploymentMcpEnablements).values([
      { mcpId: 'sentry', enabled: true, enabledByUserId: adminAuth.userId },
      { mcpId: 'monday', enabled: true, enabledByUserId: adminAuth.userId },
    ]);
    await db.insert(mcpConnections).values([
      {
        userId: null,
        mcpId: 'sentry',
        enabled: true,
        authStatus: 'authenticated',
      },
      {
        userId: memberAuth.userId,
        mcpId: 'monday',
        enabled: true,
        authStatus: 'authenticated',
      },
    ]);

    const integrations = await getEffectiveMcpIntegrationsCommand(adminAuth);

    expect(integrations.find(({ id }) => id === 'sentry')).toMatchObject({
      connectionScope: 'deployment',
      enabled: true,
      authStatus: 'authenticated',
      status: 'connected',
      capabilities: { agentTools: true, toolManagement: true },
    });
    expect(integrations.find(({ id }) => id === 'monday')).toMatchObject({
      connectionScope: 'user',
      enabled: true,
      authStatus: null,
      status: 'needs_connection',
    });
    expect(integrations.find(({ id }) => id === 'rippling')).toMatchObject({
      capabilities: { agentTools: false, toolManagement: false },
    });
  });
});
