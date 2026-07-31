const envState = vi.hoisted(() => ({
  NODE_ENV: 'test',
  R_APP_URL: 'http://localhost:3000',
  R_PUBLIC_URL: 'https://roomote.example',
  R_MONDAY_AGENT_ENABLED: true,
}));
const mocks = vi.hoisted(() => ({
  findInstallation: vi.fn(),
  findInstallations: vi.fn(),
  getSecrets: vi.fn(),
  findConnection: vi.fn(),
  getValidAccessToken: vi.fn(),
  insertValues: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  deleteWhere: vi.fn(),
  getAccount: vi.fn(),
  connectExternalAgent: vi.fn(),
  disconnectExternalAgent: vi.fn(),
}));

vi.mock('@/lib/server/env', () => ({ Env: envState }));
vi.mock('@roomote/sdk/server', () => ({
  getValidAccessToken: mocks.getValidAccessToken,
}));
vi.mock('@roomote/monday', () => ({
  MondayClient: class {
    getAccount = mocks.getAccount;
    connectExternalAgent = mocks.connectExternalAgent;
    disconnectExternalAgent = mocks.disconnectExternalAgent;
  },
}));
vi.mock('@roomote/db/server', () => ({
  and: vi.fn(() => 'where'),
  eq: vi.fn(() => 'where'),
  mcpConnections: {
    userId: 'userId',
    mcpId: 'mcpId',
    connectionRole: 'connectionRole',
    enabled: 'enabled',
    authStatus: 'authStatus',
  },
  mondayAgentInstallations: {
    singletonKey: 'singletonKey',
    id: 'id',
  },
  findMondayAgentInstallation: mocks.findInstallation,
  findMondayAgentInstallations: mocks.findInstallations,
  getMondayAgentInstallationSecrets: mocks.getSecrets,
  db: {
    query: {
      mcpConnections: { findFirst: mocks.findConnection },
    },
    insert: vi.fn(() => ({ values: mocks.insertValues })),
    update: vi.fn(() => ({ set: mocks.updateSet })),
    delete: vi.fn(() => ({ where: mocks.deleteWhere })),
  },
}));

import {
  getMondayAgentInstallationCommand,
  installMondayAgentCommand,
  uninstallMondayAgentCommand,
} from '.';

const admin = { userId: 'admin-1', isAdmin: true } as never;
const member = { userId: 'member-1', isAdmin: false } as never;

describe('monday.com external-agent setup commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.R_MONDAY_AGENT_ENABLED = true;
    mocks.findInstallation.mockResolvedValue(null);
    mocks.findInstallations.mockResolvedValue([]);
    mocks.findConnection.mockResolvedValue({ id: 'connection-1' });
    mocks.getValidAccessToken.mockResolvedValue('owner-token');
    mocks.getAccount.mockResolvedValue({
      id: 'account-1',
      name: 'Acme',
      slug: 'acme',
    });
    mocks.connectExternalAgent.mockResolvedValue({
      agentId: 'agent-1',
      apiToken: 'agent-token',
      signingSecret: 'signing-secret',
      instructions: null,
    });
    mocks.disconnectExternalAgent.mockResolvedValue(undefined);
    mocks.insertValues.mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'installation-1' }]),
    });
    mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
    mocks.updateWhere.mockResolvedValue([]);
    mocks.deleteWhere.mockResolvedValue([]);
  });

  it('hides the beta surface from members and disabled deployments', async () => {
    await expect(getMondayAgentInstallationCommand(member)).resolves.toEqual({
      featureEnabled: false,
      installation: null,
    });

    envState.R_MONDAY_AGENT_ENABLED = false;
    await expect(getMondayAgentInstallationCommand(admin)).resolves.toEqual({
      featureEnabled: false,
      installation: null,
    });
    await expect(installMondayAgentCommand(admin)).rejects.toThrow(
      'not enabled',
    );
  });

  it('persists one-time credentials without returning them to the browser', async () => {
    await expect(installMondayAgentCommand(admin)).resolves.toEqual({
      success: true,
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerMcpConnectionId: 'connection-1',
        agentApiToken: 'agent-token',
        signingSecret: 'signing-secret',
        status: 'inactive',
      }),
    );
  });

  it('disconnects the provider agent when credential persistence fails', async () => {
    mocks.insertValues.mockReturnValue({
      returning: vi.fn().mockRejectedValue(new Error('database unavailable')),
    });

    await expect(installMondayAgentCommand(admin)).rejects.toThrow(
      'Failed to persist monday.com external agent credentials',
    );
    expect(mocks.disconnectExternalAgent).toHaveBeenCalledWith('agent-1');
  });

  it('preserves failed-cleanup credentials without overwriting the singleton', async () => {
    mocks.disconnectExternalAgent.mockRejectedValue(
      new Error('provider unavailable'),
    );
    mocks.insertValues
      .mockReturnValueOnce({
        returning: vi.fn().mockRejectedValue(new Error('singleton conflict')),
      })
      .mockReturnValueOnce({
        onConflictDoNothing: () => ({
          returning: vi.fn().mockResolvedValue([]),
        }),
      })
      .mockReturnValueOnce(Promise.resolve());

    await expect(installMondayAgentCommand(admin)).rejects.toThrow(
      'provider cleanup also failed',
    );
    expect(mocks.insertValues).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        singletonKey: null,
        agentId: 'agent-1',
        agentApiToken: 'agent-token',
        signingSecret: 'signing-secret',
        status: 'error',
      }),
    );
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.not.objectContaining({
        agentId: expect.anything(),
        agentApiToken: expect.anything(),
        signingSecret: expect.anything(),
      }),
    );
  });

  it('retries locally when the disconnected checkpoint and delete both fail', async () => {
    const installation = {
      id: 'installation-1',
      accountId: 'account-1',
      accountName: 'Acme',
      agentId: 'agent-1',
      ownerMcpConnectionId: 'connection-1',
      status: 'inactive',
      error: null,
    };
    mocks.findInstallations
      .mockResolvedValueOnce([installation])
      .mockResolvedValueOnce([{ ...installation, status: 'disconnected' }]);
    mocks.deleteWhere
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce([]);
    mocks.updateWhere
      .mockRejectedValueOnce(new Error('checkpoint unavailable'))
      .mockResolvedValueOnce([]);

    await expect(uninstallMondayAgentCommand(admin)).rejects.toThrow(
      'database unavailable',
    );
    expect(mocks.disconnectExternalAgent).toHaveBeenCalledTimes(1);
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'disconnected', error: null }),
    );
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'disconnected',
        error: expect.stringMatching(
          /checkpoint unavailable.*local deletion failed.*database unavailable/,
        ),
      }),
    );

    await expect(uninstallMondayAgentCommand(admin)).resolves.toEqual({
      success: true,
    });
    expect(mocks.disconnectExternalAgent).toHaveBeenCalledTimes(1);
    expect(mocks.getValidAccessToken).toHaveBeenCalledTimes(1);
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(2);
  });
});
