const {
  envState,
  deletedConnectionsState,
  resolveDeploymentEnvVarMock,
  upsertDeploymentEnvironmentVariablesMock,
} = vi.hoisted(() => ({
  envState: {} as Record<string, string | undefined>,
  deletedConnectionsState: [] as Array<{ id: string }>,
  resolveDeploymentEnvVarMock: vi.fn(),
  upsertDeploymentEnvironmentVariablesMock: vi.fn(),
}));

vi.mock('@/lib/server/env', () => ({ Env: envState }));
vi.mock('@/lib/server/get-public-app-url', () => ({
  getPublicAppUrl: () => 'https://roomote.example',
}));
vi.mock('../environment-variables', () => ({
  upsertDeploymentEnvironmentVariables:
    upsertDeploymentEnvironmentVariablesMock,
}));
vi.mock('@roomote/db/server', () => ({
  db: {
    transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        delete: () => ({
          where: () => ({
            returning: async () => deletedConnectionsState,
          }),
        }),
        insert: () => ({
          values: () => ({
            onConflictDoUpdate: async () => undefined,
          }),
        }),
      }),
  },
  resolveDeploymentEnvVar: resolveDeploymentEnvVarMock,
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
  mcpConnections: {
    id: 'id',
    mcpId: 'mcpId',
    connectionRole: 'connectionRole',
    userId: 'userId',
  },
  deploymentMcpEnablements: { mcpId: 'mcpId' },
}));
vi.mock('@roomote/sdk/server', () => ({
  findLinearDeploymentMcpConnection: vi.fn(),
  getLinearDeploymentMetadata: vi.fn(),
  LINEAR_ORG_CONNECTION_ROLE: 'linear_org_install',
}));

import {
  getLinearOauthSetupCommand,
  saveLinearOauthSetupCommand,
} from './index';

const ADMIN = {
  userId: 'admin-1',
  isAdmin: true,
} as Parameters<typeof getLinearOauthSetupCommand>[0];

describe('Linear OAuth setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(envState)) {
      delete envState[key];
    }
    deletedConnectionsState.splice(0);
    resolveDeploymentEnvVarMock.mockResolvedValue(null);
  });

  it('builds a private Linear app manifest for this deployment', async () => {
    const setup = await getLinearOauthSetupCommand(ADMIN);
    const setupUrl = new URL(setup.manifestUrl);
    const manifest = JSON.parse(setupUrl.searchParams.get('manifest')!);

    expect(setup.callbackUrl).toBe(
      'https://roomote.example/api/mcp-oauth/callback',
    );
    expect(setup.webhookUrl).toBe(
      'https://roomote.example/api/webhooks/linear',
    );
    expect(manifest).toMatchObject({
      schemaVersion: '1.0.0',
      distribution: 'private',
      display: { description: 'Cloud coding agents for all' },
      oauth: {
        client_name: 'roomote-example',
        redirect_uris: [setup.callbackUrl],
      },
      webhook: {
        enabled: true,
        url: setup.webhookUrl,
        resourceTypes: ['AgentSessionEvent'],
      },
    });
  });

  it('requires an administrator to view or save app setup', async () => {
    const nonAdmin = { ...ADMIN, isAdmin: false };

    await expect(getLinearOauthSetupCommand(nonAdmin)).rejects.toThrow(
      'Unauthorized',
    );
    await expect(
      saveLinearOauthSetupCommand(nonAdmin, {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        webhookSecret: 'webhook-secret',
      }),
    ).rejects.toThrow('Unauthorized');
  });

  it('saves all three credentials in the encrypted deployment store', async () => {
    await saveLinearOauthSetupCommand(ADMIN, {
      clientId: ' client-id ',
      clientSecret: ' client-secret ',
      webhookSecret: ' webhook-secret ',
    });

    expect(upsertDeploymentEnvironmentVariablesMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        userId: 'admin-1',
        values: [
          { name: 'R_LINEAR_CLIENT_ID', value: 'client-id' },
          { name: 'R_LINEAR_CLIENT_SECRET', value: 'client-secret' },
          { name: 'R_LINEAR_WEBHOOK_SECRET', value: 'webhook-secret' },
        ],
      },
    );
  });

  it('requires an existing workspace to reconnect when its OAuth client changes', async () => {
    deletedConnectionsState.push({ id: 'legacy-linear-connection' });

    const result = await saveLinearOauthSetupCommand(ADMIN, {
      clientId: 'new-client-id',
      clientSecret: 'new-client-secret',
      webhookSecret: 'new-webhook-secret',
    });

    expect(result.requiresReconnect).toBe(true);
  });

  it('keeps the workspace connected when only the webhook secret changes', async () => {
    deletedConnectionsState.push({ id: 'current-linear-connection' });
    resolveDeploymentEnvVarMock.mockResolvedValue('already-configured');

    const result = await saveLinearOauthSetupCommand(ADMIN, {
      clientId: '',
      clientSecret: '',
      webhookSecret: 'rotated-webhook-secret',
    });

    expect(result.requiresReconnect).toBe(false);
  });

  it('keeps saved values when an administrator leaves their fields blank', async () => {
    resolveDeploymentEnvVarMock.mockResolvedValue('already-configured');

    await saveLinearOauthSetupCommand(ADMIN, {
      clientId: '',
      clientSecret: '',
      webhookSecret: '',
    });

    expect(upsertDeploymentEnvironmentVariablesMock).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 'admin-1', values: [] },
    );
  });

  it('does not copy runtime-managed credentials into the database', async () => {
    envState.R_LINEAR_CLIENT_ID = 'runtime-client';
    envState.R_LINEAR_CLIENT_SECRET = 'runtime-secret';
    envState.R_LINEAR_WEBHOOK_SECRET = 'runtime-webhook-secret';
    resolveDeploymentEnvVarMock.mockImplementation(
      async (name: string, _db: unknown, runtimeEnv: Record<string, string>) =>
        runtimeEnv[name] ?? null,
    );

    await saveLinearOauthSetupCommand(ADMIN, {
      clientId: 'ignored-client',
      clientSecret: 'ignored-secret',
      webhookSecret: 'ignored-webhook-secret',
    });

    expect(upsertDeploymentEnvironmentVariablesMock).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 'admin-1', values: [] },
    );
  });

  it('requires every value that is not already configured', async () => {
    await expect(
      saveLinearOauthSetupCommand(ADMIN, {
        clientId: 'client-id',
        clientSecret: '',
        webhookSecret: '',
      }),
    ).rejects.toThrow('client secret, webhook secret');

    expect(upsertDeploymentEnvironmentVariablesMock).not.toHaveBeenCalled();
  });
});
