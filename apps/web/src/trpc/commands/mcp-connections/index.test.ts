import {
  db,
  deploymentMcpEnablements,
  eq,
  inArray,
  mcpConnections,
  userFactory,
} from '@roomote/db/server';
import {
  isMcpConnectionExaConfig,
  isMcpConnectionStripeConfig,
  isMcpConnectionVoiceConfig,
} from '@roomote/types';

const { captureEventMock } = vi.hoisted(() => ({
  captureEventMock: vi.fn(),
}));

const { getDeploymentStaticOauthReadinessMock } = vi.hoisted(() => ({
  getDeploymentStaticOauthReadinessMock: vi.fn(),
}));

const { resolveModelProviderEnvValueMock } = vi.hoisted(() => ({
  resolveModelProviderEnvValueMock: vi.fn(
    async () => undefined as string | undefined,
  ),
}));

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  resolveModelProviderEnvValue: resolveModelProviderEnvValueMock,
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
  listDeploymentMcpIntegrationToolsCommand,
  removeExaApiKeyCommand,
  saveAsanaConnectionCommand,
  saveExaConnectionCommand,
  saveStripeConnectionCommand,
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

const testMcpIds = [
  'asana',
  'exa',
  'linear',
  'monday',
  'sentry',
  'stripe',
  'voice',
];

async function cleanup() {
  await db
    .delete(mcpConnections)
    .where(inArray(mcpConnections.mcpId, testMcpIds));
  await db
    .delete(deploymentMcpEnablements)
    .where(inArray(deploymentMcpEnablements.mcpId, testMcpIds));
}

describe('MCP connection lifecycle telemetry', () => {
  beforeAll(async () => {
    await userFactory.create({ id: adminAuth.userId });
    await userFactory.create({ id: memberAuth.userId });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    getDeploymentStaticOauthReadinessMock.mockResolvedValue('ready');
    resolveModelProviderEnvValueMock.mockResolvedValue(undefined);
    await cleanup();
  });

  afterAll(cleanup);

  it('validates and encrypts a deployment-wide Exa API key before connecting', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [{ name: 'web_search_exa', description: 'Search the web' }],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await saveExaConnectionCommand(adminAuth, { apiKey: 'exa-secret' });

    const [connection] = await db
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.mcpId, 'exa'));
    expect(connection?.authStatus).toBe('authenticated');
    expect(isMcpConnectionExaConfig(connection?.authConfig)).toBe(true);
    expect(JSON.stringify(connection?.authConfig)).not.toContain('exa-secret');

    const requestHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(requestHeaders['x-api-key']).toBe('exa-secret');
    expect(requestHeaders.authorization).toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,web_search_advanced_exa,agent_run',
    );
    const enablements = await db
      .select()
      .from(deploymentMcpEnablements)
      .where(eq(deploymentMcpEnablements.mcpId, 'exa'));
    expect(enablements).toHaveLength(0);
  });

  it('encrypts a Stripe restricted key and starts with writes disabled', async () => {
    await saveStripeConnectionCommand(adminAuth, {
      apiKey: 'rk_test_restricted',
    });

    const [connection] = await db
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.mcpId, 'stripe'));
    expect(connection?.authStatus).toBe('authenticated');
    expect(isMcpConnectionStripeConfig(connection?.authConfig)).toBe(true);
    expect(JSON.stringify(connection?.authConfig)).not.toContain(
      'rk_test_restricted',
    );

    const [enablement] = await db
      .select()
      .from(deploymentMcpEnablements)
      .where(eq(deploymentMcpEnablements.mcpId, 'stripe'));
    expect(enablement).toMatchObject({
      enabled: true,
      disabledTools: ['stripe_api_write'],
    });
  });

  it('does not persist an Exa connection when upstream validation fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid API key' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(
      saveExaConnectionCommand(adminAuth, { apiKey: 'invalid-key' }),
    ).rejects.toThrow(
      'Unable to validate the Exa API key with Exa. Check the key and try again.',
    );

    const connections = await db
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.mcpId, 'exa'));
    expect(connections).toHaveLength(0);
  });

  it('keeps Exa off by default and allows explicit keyless enablement', async () => {
    expect(
      (await getEffectiveMcpIntegrationsCommand(adminAuth)).find(
        (integration) => integration.id === 'exa',
      ),
    ).toMatchObject({
      enabled: false,
      authStatus: null,
      status: 'not_enabled',
    });

    await expect(
      setDeploymentMcpEnabledCommand(adminAuth, {
        mcpId: 'exa',
        enabled: true,
      }),
    ).resolves.toMatchObject({ mcpId: 'exa', enabled: true });

    expect(
      (await getEffectiveMcpIntegrationsCommand(adminAuth)).find(
        (integration) => integration.id === 'exa',
      ),
    ).toMatchObject({
      enabled: true,
      authStatus: null,
      status: 'connected',
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [
              { name: 'web_search_exa' },
              { name: 'web_fetch_exa' },
              { name: 'web_search_advanced_exa' },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      listDeploymentMcpIntegrationToolsCommand(adminAuth, { mcpId: 'exa' }),
    ).resolves.toMatchObject({
      tools: [
        { name: 'web_search_exa' },
        { name: 'web_fetch_exa' },
        { name: 'web_search_advanced_exa' },
      ],
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      'x-api-key',
    );
  });

  it('preserves an optional Exa key across disable and removes it without re-enabling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: { tools: [{ name: 'agent_run' }] },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    await setDeploymentMcpEnabledCommand(adminAuth, {
      mcpId: 'exa',
      enabled: true,
    });
    await saveExaConnectionCommand(adminAuth, { apiKey: 'exa-secret' });
    await setDeploymentMcpEnabledCommand(adminAuth, {
      mcpId: 'exa',
      enabled: false,
    });
    await saveExaConnectionCommand(adminAuth, { apiKey: 'updated-exa-secret' });

    expect(
      await db.query.mcpConnections.findFirst({
        where: eq(mcpConnections.mcpId, 'exa'),
      }),
    ).toBeDefined();
    expect(
      await db.query.deploymentMcpEnablements.findFirst({
        where: eq(deploymentMcpEnablements.mcpId, 'exa'),
      }),
    ).toMatchObject({ enabled: false });
    await removeExaApiKeyCommand(adminAuth);
    expect(
      await db.query.mcpConnections.findFirst({
        where: eq(mcpConnections.mcpId, 'exa'),
      }),
    ).toBeUndefined();
    expect(
      await db.query.deploymentMcpEnablements.findFirst({
        where: eq(deploymentMcpEnablements.mcpId, 'exa'),
      }),
    ).toMatchObject({ enabled: false });

    await setDeploymentMcpEnabledCommand(adminAuth, {
      mcpId: 'exa',
      enabled: true,
    });
    expect(
      (await getEffectiveMcpIntegrationsCommand(adminAuth)).find(
        (integration) => integration.id === 'exa',
      ),
    ).toMatchObject({ enabled: true, authStatus: null, status: 'connected' });
  });

  it('lets an environment-keyed Voice be switched off and on without a stored connection', async () => {
    // Without an environment key, Voice behaves like any other
    // deployment-scoped integration: enabling needs a stored connection.
    await expect(
      setDeploymentMcpEnabledCommand(adminAuth, {
        mcpId: 'voice',
        enabled: true,
      }),
    ).rejects.toThrow('must be connected before it can be enabled');

    resolveModelProviderEnvValueMock.mockResolvedValue('sk-env-voice');

    // The environment key stands in for the connection.
    await expect(
      setDeploymentMcpEnabledCommand(adminAuth, {
        mcpId: 'voice',
        enabled: true,
      }),
    ).resolves.toMatchObject({ mcpId: 'voice', enabled: true });

    // A key the admin had saved earlier survives disabling: the deployment
    // falls back to it if the environment key is ever removed.
    await db.insert(mcpConnections).values({
      userId: null,
      mcpId: 'voice',
      connectionRole: 'default',
      authConfig: { type: 'voice', encryptedApiKey: 'stored-encrypted-key' },
      enabled: true,
      authStatus: 'authenticated',
    });
    await expect(
      setDeploymentMcpEnabledCommand(adminAuth, {
        mcpId: 'voice',
        enabled: false,
      }),
    ).resolves.toMatchObject({ mcpId: 'voice', enabled: false });
    await expect(
      db.query.mcpConnections.findFirst({
        where: (table, { eq: whereEq }) => whereEq(table.mcpId, 'voice'),
      }),
    ).resolves.toMatchObject({ mcpId: 'voice' });
    await expect(
      db.query.deploymentMcpEnablements.findFirst({
        where: (table, { eq: whereEq }) => whereEq(table.mcpId, 'voice'),
      }),
    ).resolves.toMatchObject({ enabled: false });

    // The card reads the switch from the connection query.
    await expect(getVoiceConnectionCommand(adminAuth)).resolves.toMatchObject({
      source: 'environment',
      enabled: false,
    });
  });

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
