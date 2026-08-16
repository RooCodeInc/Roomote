const mocks = vi.hoisted(() => ({
  enabledRows: [] as Array<{ mcpId: string }>,
  createAuthToken: vi.fn(),
  listMcpTools: vi.fn(),
  callMcpTool: vi.fn(),
  select: vi.fn(),
  findGithubInstallation: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({
  createAuthToken: mocks.createAuthToken,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: mocks.select,
    query: {
      githubInstallations: { findFirst: mocks.findGithubInstallation },
    },
  },
  deploymentMcpEnablements: { mcpId: 'mcpId', enabled: 'enabled' },
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
        { userId: 'user-1', apiBaseUrl: 'https://api.example.com' },
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
  });

  it('calls an allowlisted tool through a fixed authenticated proxy URL', async () => {
    mocks.callMcpTool.mockResolvedValue({ results: ['Roadmap'] });

    await callFastAgentIntegration(
      { userId: 'user-1', apiBaseUrl: 'https://api.example.com' },
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
      toolCallId: 'fast:notion:search',
    });
  });
});
