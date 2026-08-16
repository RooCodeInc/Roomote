const mocks = vi.hoisted(() => ({
  enabledRows: [] as Array<{ mcpId: string; disabledTools?: string[] | null }>,
  createAuthToken: vi.fn(),
  listMcpTools: vi.fn(),
  callMcpTool: vi.fn(),
  beginIntegrationCall: vi.fn(),
  completeIntegrationCall: vi.fn(),
  select: vi.fn(),
  findGithubInstallation: vi.fn(),
  brainEnv: { R_GBRAIN_URL: undefined as string | undefined },
  isBrainConfigured: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({
  createAuthToken: mocks.createAuthToken,
}));

vi.mock('@roomote/env', () => ({
  Env: mocks.brainEnv,
  isBrainConfigured: mocks.isBrainConfigured,
}));

vi.mock('@roomote/db/server', () => ({
  beginSlackFastIntegrationCall: mocks.beginIntegrationCall,
  completeSlackFastIntegrationCall: mocks.completeIntegrationCall,
  db: {
    select: mocks.select,
    query: {
      githubInstallations: { findFirst: mocks.findGithubInstallation },
    },
  },
  deploymentMcpEnablements: {
    mcpId: 'mcpId',
    enabled: 'enabled',
    disabledTools: 'disabledTools',
  },
  eq: vi.fn(() => 'enabled-filter'),
  githubInstallations: { suspendedAt: 'suspendedAt' },
  isNull: vi.fn(() => 'not-suspended-filter'),
}));

vi.mock('../../router/mcp-policy', () => ({
  isRouterMcpServerEnabled: vi.fn(() => true),
}));

vi.mock('../../mcp-tool-client', () => ({
  listMcpTools: mocks.listMcpTools,
  callMcpTool: mocks.callMcpTool,
}));

import {
  callFastAgentIntegration,
  clearFastAgentIntegrationToolCache,
  listFastAgentIntegrations,
} from '../fast-agent-integration-broker';

const auditContext = {
  userId: 'user-1',
  apiBaseUrl: 'https://api.example.com',
  sessionId: 'session-1',
  slackTeamId: 'team-1',
  slackChannel: 'channel-1',
  slackThreadTs: '100.1',
  slackMessageTs: '100.2',
};

describe('fast-agent integration broker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFastAgentIntegrationToolCache();
    mocks.enabledRows = [];
    mocks.select.mockImplementation(() => ({
      from: () => ({
        where: () => Promise.resolve(mocks.enabledRows),
      }),
    }));
    mocks.createAuthToken.mockResolvedValue('control-plane-token');
    mocks.findGithubInstallation.mockResolvedValue(undefined);
    mocks.brainEnv.R_GBRAIN_URL = undefined;
    mocks.isBrainConfigured.mockReturnValue(false);
    mocks.beginIntegrationCall.mockResolvedValue({
      id: 'audit-1',
      startedAt: new Date('2026-08-16T00:00:00.000Z'),
    });
    mocks.completeIntegrationCall.mockResolvedValue(undefined);
    mocks.listMcpTools.mockResolvedValue([
      { name: 'search', inputSchema: { type: 'object' } },
    ]);
  });

  it('exposes the deployment GitHub App through its read-only router MCP', async () => {
    mocks.findGithubInstallation.mockResolvedValue({ id: 42 });

    const integrations = await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://api.example.com',
    });

    expect(integrations.map((integration) => integration.id)).toEqual([
      'github',
    ]);
    expect(mocks.listMcpTools).toHaveBeenCalledWith({
      url: 'https://api.example.com/api/mcp-routing/github',
      headers: { Authorization: 'Bearer control-plane-token' },
    });
  });

  it('exposes the read-only Brain proxy when the Brain is configured', async () => {
    mocks.brainEnv.R_GBRAIN_URL = 'http://gbrain:8931';
    mocks.isBrainConfigured.mockReturnValue(true);

    const integrations = await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://api.example.com',
    });

    expect(integrations).toEqual([
      expect.objectContaining({
        id: 'gbrain',
        name: 'Brain',
        instructions: expect.stringContaining(
          'Treat Brain recall as a sequential preflight',
        ),
        tools: [{ name: 'search', inputSchema: { type: 'object' } }],
      }),
    ]);
    expect(mocks.listMcpTools).toHaveBeenCalledWith({
      url: 'https://api.example.com/api/mcp/gbrain',
      headers: { Authorization: 'Bearer control-plane-token' },
    });
  });

  it('does not probe or expose Brain when it is not fully configured', async () => {
    mocks.brainEnv.R_GBRAIN_URL = 'http://gbrain:8931';
    mocks.isBrainConfigured.mockReturnValue(false);

    await expect(
      listFastAgentIntegrations({
        userId: 'user-1',
        apiBaseUrl: 'https://api.example.com',
      }),
    ).resolves.toEqual([]);

    expect(mocks.listMcpTools).not.toHaveBeenCalled();
  });

  it('does not expose a wired Brain whose proxy is not usable yet', async () => {
    mocks.brainEnv.R_GBRAIN_URL = 'http://gbrain:8931';
    mocks.isBrainConfigured.mockReturnValue(true);
    mocks.listMcpTools.mockRejectedValue(
      new Error('The Brain inference provider is not configured'),
    );

    await expect(
      listFastAgentIntegrations({
        userId: 'user-1',
        apiBaseUrl: 'https://api.example.com',
      }),
    ).resolves.toEqual([]);
  });

  it('excludes user-scoped, credential-only, and unknown integrations', async () => {
    mocks.enabledRows = [
      { mcpId: 'notion' },
      { mcpId: 'elevenlabs' },
      { mcpId: 'neon' },
      { mcpId: 'custom-local-server' },
    ];

    const integrations = await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://api.example.com',
    });

    expect(integrations.map((integration) => integration.id)).toEqual([
      'notion',
    ]);
  });

  it('reuses discovered tools across fast turns', async () => {
    mocks.enabledRows = [{ mcpId: 'notion' }];

    await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://api.example.com',
    });
    await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://api.example.com',
    });

    expect(mocks.listMcpTools).toHaveBeenCalledOnce();
  });

  it('excludes tools disabled by the deployment', async () => {
    mocks.enabledRows = [{ mcpId: 'notion', disabledTools: ['search'] }];

    const integrations = await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://api.example.com',
    });

    expect(integrations).toEqual([]);
  });

  it('does not cache failed tool discovery', async () => {
    mocks.enabledRows = [{ mcpId: 'notion' }];
    mocks.listMcpTools
      .mockRejectedValueOnce(new Error('temporary MCP failure'))
      .mockResolvedValueOnce([{ name: 'search' }]);

    await expect(
      listFastAgentIntegrations({
        userId: 'user-1',
        apiBaseUrl: 'https://api.example.com',
      }),
    ).resolves.toEqual([]);
    await expect(
      listFastAgentIntegrations({
        userId: 'user-1',
        apiBaseUrl: 'https://api.example.com',
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'notion', tools: [{ name: 'search' }] }),
    ]);

    expect(mocks.listMcpTools).toHaveBeenCalledTimes(2);
  });

  it('rejects tools outside the discovered allowlist without making a call', async () => {
    await expect(
      callFastAgentIntegration(
        auditContext,
        [
          {
            id: 'notion',
            name: 'Notion',
            description: 'Knowledge',
            tools: [{ name: 'search' }],
          },
        ],
        { integrationId: 'notion', toolName: 'read_file', args: {} },
      ),
    ).rejects.toThrow('tool is not available to fast mode');
    expect(mocks.callMcpTool).not.toHaveBeenCalled();
    expect(mocks.beginIntegrationCall).not.toHaveBeenCalled();
  });

  it('calls an allowlisted tool through a fixed authenticated proxy URL', async () => {
    mocks.callMcpTool.mockResolvedValue({ results: ['Roadmap'] });

    await callFastAgentIntegration(
      auditContext,
      [
        {
          id: 'notion',
          name: 'Notion',
          description: 'Knowledge',
          tools: [{ name: 'search' }],
        },
      ],
      {
        integrationId: 'notion',
        toolName: 'search',
        args: { query: 'roadmap' },
      },
    );

    expect(mocks.callMcpTool).toHaveBeenCalledWith({
      url: 'https://api.example.com/api/mcp/notion',
      headers: { Authorization: 'Bearer control-plane-token' },
      toolName: 'search',
      args: { query: 'roadmap' },
      toolCallId: 'fast:audit-1:notion:search',
    });
    expect(mocks.beginIntegrationCall).toHaveBeenCalledWith({
      slackQuickAnswerId: 'session-1',
      userId: 'user-1',
      slackTeamId: 'team-1',
      slackChannel: 'channel-1',
      slackThreadTs: '100.1',
      slackMessageTs: '100.2',
      integrationId: 'notion',
      toolName: 'search',
      arguments: { query: 'roadmap' },
    });
    expect(mocks.completeIntegrationCall).toHaveBeenCalledWith({
      id: 'audit-1',
      status: 'succeeded',
      resultPreview: '{"results":["Roadmap"]}',
      startedAt: new Date('2026-08-16T00:00:00.000Z'),
    });
  });

  it('does not execute a tool when its durable audit cannot be created', async () => {
    mocks.beginIntegrationCall.mockRejectedValue(new Error('database offline'));

    await expect(
      callFastAgentIntegration(
        auditContext,
        [
          {
            id: 'notion',
            name: 'Notion',
            description: 'Knowledge',
            tools: [{ name: 'search' }],
          },
        ],
        { integrationId: 'notion', toolName: 'search', args: {} },
      ),
    ).rejects.toThrow('database offline');

    expect(mocks.callMcpTool).not.toHaveBeenCalled();
  });

  it('records a failed tool call and preserves its original error', async () => {
    mocks.callMcpTool.mockRejectedValue(new Error('integration unavailable'));

    await expect(
      callFastAgentIntegration(
        auditContext,
        [
          {
            id: 'notion',
            name: 'Notion',
            description: 'Knowledge',
            tools: [{ name: 'search' }],
          },
        ],
        { integrationId: 'notion', toolName: 'search', args: {} },
      ),
    ).rejects.toThrow('integration unavailable');

    expect(mocks.completeIntegrationCall).toHaveBeenCalledWith({
      id: 'audit-1',
      status: 'failed',
      error: 'integration unavailable',
      startedAt: new Date('2026-08-16T00:00:00.000Z'),
    });
  });
});
