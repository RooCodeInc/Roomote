const mocks = vi.hoisted(() => ({
  configuredServers: {} as Record<
    string,
    { url: string; headers: Record<string, string>; disabledTools?: string[] }
  >,
  createAuthToken: vi.fn(),
  listMcpTools: vi.fn(),
  callMcpTool: vi.fn(),
  beginIntegrationCall: vi.fn(),
  completeIntegrationCall: vi.fn(),
  findGithubInstallation: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({
  createAuthToken: mocks.createAuthToken,
  ROOMOTE_MCP_PATH: '/mcp',
}));

vi.mock('@roomote/db/server', () => ({
  beginSlackFastIntegrationCall: mocks.beginIntegrationCall,
  completeSlackFastIntegrationCall: mocks.completeIntegrationCall,
  db: {
    query: {
      githubInstallations: { findFirst: mocks.findGithubInstallation },
    },
  },
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
  listFastAgentIntegrations as listFastAgentIntegrationsWithResolver,
} from '../fast-agent-integration-broker';

const auditContext = {
  userId: 'user-1',
  apiBaseUrl: 'https://api.example.com',
  sessionId: 'session-1',
  conversation: {
    surface: 'slack' as const,
    workspaceId: 'team-1',
    conversationId: '100.1',
    replyTarget: { channelId: 'channel-1', threadId: '100.1' },
  },
  messageId: '100.2',
};

function listFastAgentIntegrations(context: {
  userId: string;
  apiBaseUrl?: string;
}) {
  return listFastAgentIntegrationsWithResolver(
    context,
    async () => mocks.configuredServers,
  );
}

describe('fast-agent integration broker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFastAgentIntegrationToolCache();
    mocks.configuredServers = {};
    mocks.createAuthToken.mockResolvedValue('control-plane-token');
    mocks.findGithubInstallation.mockResolvedValue(undefined);
    mocks.beginIntegrationCall.mockResolvedValue({
      id: 'audit-1',
      startedAt: new Date('2026-08-16T00:00:00.000Z'),
    });
    mocks.completeIntegrationCall.mockResolvedValue(undefined);
    mocks.listMcpTools.mockResolvedValue([
      { name: 'search', inputSchema: { type: 'object' } },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes the deployment GitHub App through its read-only router MCP', async () => {
    mocks.findGithubInstallation.mockResolvedValue({ id: 42 });
    mocks.listMcpTools.mockResolvedValue([
      { name: 'actions_get', inputSchema: { type: 'object' } },
      { name: 'actions_list', inputSchema: { type: 'object' } },
      { name: 'get_job_logs', inputSchema: { type: 'object' } },
    ]);

    const integrations = await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://api.example.com',
    });

    expect(integrations.map((integration) => integration.id)).toEqual([
      'github',
    ]);
    expect(integrations[0]?.tools.map((tool) => tool.name)).toEqual([
      'actions_get',
      'actions_list',
      'get_job_logs',
    ]);
    expect(mocks.listMcpTools).toHaveBeenCalledWith({
      url: 'https://api.example.com/api/mcp-routing/github',
      headers: { Authorization: 'Bearer control-plane-token' },
      signal: expect.any(AbortSignal),
    });
  });

  it('exposes the read-only Brain proxy when the Brain is configured', async () => {
    mocks.configuredServers = {
      gbrain: {
        url: 'https://api.example.com/api/mcp/gbrain',
        headers: {},
      },
    };

    const integrations = await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://api.example.com',
    });

    expect(integrations).toEqual([
      expect.objectContaining({
        id: 'gbrain',
        name: 'Brain',
        instructions: expect.stringContaining(
          'make one normal Brain tool call before any other context or work tool call',
        ),
        tools: [{ name: 'search', inputSchema: { type: 'object' } }],
      }),
    ]);
    expect(integrations[0]?.instructions).toContain(
      'Treat Brain recall as a sequential preflight',
    );
    expect(integrations[0]?.instructions).toContain('save_memory');
    expect(integrations[0]?.instructions).not.toContain('save_task_memory');
    expect(mocks.listMcpTools).toHaveBeenCalledWith({
      url: 'https://api.example.com/api/mcp/gbrain',
      headers: { Authorization: 'Bearer control-plane-token' },
      signal: expect.any(AbortSignal),
    });
  });

  it('does not probe or expose Brain when it is not fully configured', async () => {
    await expect(
      listFastAgentIntegrations({
        userId: 'user-1',
        apiBaseUrl: 'https://api.example.com',
      }),
    ).resolves.toEqual([]);

    expect(mocks.listMcpTools).not.toHaveBeenCalled();
  });

  it('does not expose a wired Brain whose proxy is not usable yet', async () => {
    mocks.configuredServers = {
      gbrain: {
        url: 'https://api.example.com/api/mcp/gbrain',
        headers: {},
      },
    };
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

  it('exposes every actor-resolved remote MCP server', async () => {
    mocks.configuredServers = {
      notion: {
        url: 'https://api.example.com/api/mcp/notion',
        headers: {},
      },
      'user-server': {
        url: 'https://mcp.example.test/user',
        headers: { Authorization: 'Bearer upstream-user-token' },
      },
      'custom-server': {
        url: 'https://api.example.com/api/mcp/custom/server-1',
        headers: { 'X-MCP-Client': 'Roomote' },
      },
      roomote: {
        url: 'https://api.example.com/mcp',
        headers: {},
      },
    };

    const integrations = await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://api.example.com',
    });

    expect(integrations.map((integration) => integration.id)).toEqual([
      'notion',
      'user-server',
      'custom-server',
      'roomote',
    ]);
  });

  it('does not infer memory guidance from a custom server name', async () => {
    mocks.configuredServers = {
      'team-memory': {
        url: 'https://memory.example.test/mcp',
        headers: {},
      },
    };

    const integrations = await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://api.example.com',
    });

    expect(integrations).toEqual([
      expect.objectContaining({
        id: 'team-memory',
        instructions: undefined,
      }),
    ]);
  });

  it('assigns the initial recall to only the first available memory server', async () => {
    mocks.configuredServers = {
      gbrain: {
        url: 'https://api.example.com/api/mcp/gbrain',
        headers: {},
      },
      supermemory: {
        url: 'https://api.example.com/api/mcp/supermemory',
        headers: {},
      },
    };

    const integrations = await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://api.example.com',
    });

    expect(integrations[0]?.instructions).toContain(
      'first normal context or work tool call',
    );
    expect(integrations[0]?.instructions).toContain(
      'Treat Brain recall as a sequential preflight',
    );
    expect(integrations[1]?.instructions).toContain(
      'Another installed memory server owns the required initial recall',
    );
    expect(integrations[1]?.instructions).not.toContain(
      'Treat Brain recall as a sequential preflight',
    );
  });

  it('discovers member Roomote tools for Fast with actor authorization', async () => {
    mocks.configuredServers = {
      roomote: {
        url: 'https://app.example.test/mcp',
        headers: {},
      },
    };
    mocks.listMcpTools.mockResolvedValue([
      { name: 'manage_tasks', inputSchema: { type: 'object' } },
    ]);

    const integrations = await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://app.example.test/_roomote-api',
    });

    expect(integrations).toEqual([
      expect.objectContaining({
        id: 'roomote',
        tools: [{ name: 'manage_tasks', inputSchema: { type: 'object' } }],
      }),
    ]);
    expect(mocks.listMcpTools).toHaveBeenCalledWith({
      url: 'https://app.example.test/_roomote-api/mcp',
      headers: { Authorization: 'Bearer control-plane-token' },
      signal: expect.any(AbortSignal),
    });
  });

  it('keeps deployment-disabled Roomote channel tools out of Fast inventory', async () => {
    mocks.configuredServers = {
      roomote: {
        url: 'https://app.example.test/mcp',
        headers: {},
        disabledTools: ['post_to_channel'],
      },
    };
    mocks.listMcpTools.mockResolvedValue([
      { name: 'manage_tasks' },
      { name: 'list_chat_channels' },
      { name: 'post_to_channel' },
      { name: 'send_chat_reaction_emoji' },
    ]);

    const integrations = await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://app.example.test/_roomote-api',
    });

    expect(integrations[0]?.tools.map(({ name }) => name)).toEqual([
      'manage_tasks',
      'list_chat_channels',
      'send_chat_reaction_emoji',
    ]);
  });

  it('injects the current user token into deployment proxies behind a reverse-proxy base path', async () => {
    mocks.configuredServers = {
      roomote: {
        url: 'https://app.example.test/mcp',
        headers: { 'X-MCP-Client': 'Roomote' },
      },
    };

    await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://app.example.test/_roomote-api',
    });

    expect(mocks.listMcpTools).toHaveBeenCalledWith({
      url: 'https://app.example.test/_roomote-api/mcp',
      headers: {
        'X-MCP-Client': 'Roomote',
        Authorization: 'Bearer control-plane-token',
      },
      signal: expect.any(AbortSignal),
    });
  });

  it('preserves actor-resolved credentials for direct upstream MCP servers', async () => {
    mocks.configuredServers = {
      'user-server': {
        url: 'https://mcp.example.test/user',
        headers: { Authorization: 'Bearer upstream-user-token' },
      },
    };

    await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://api.example.com',
    });

    expect(mocks.listMcpTools).toHaveBeenCalledWith({
      url: 'https://mcp.example.test/user',
      headers: { Authorization: 'Bearer upstream-user-token' },
      signal: expect.any(AbortSignal),
    });
  });

  it('reuses discovered tools across fast turns', async () => {
    mocks.configuredServers = {
      notion: {
        url: 'https://api.example.com/api/mcp/notion',
        headers: {},
      },
    };

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

  it('does not share cached tool catalogs across acting users', async () => {
    mocks.configuredServers = {
      notion: {
        url: 'https://api.example.com/api/mcp/notion',
        headers: {},
      },
    };

    await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://api.example.com',
    });
    await listFastAgentIntegrations({
      userId: 'user-2',
      apiBaseUrl: 'https://api.example.com',
    });

    expect(mocks.listMcpTools).toHaveBeenCalledTimes(2);
  });

  it('serves stale tools immediately while a bounded refresh hangs', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-19T00:00:00.000Z') });
    mocks.configuredServers = {
      notion: {
        url: 'https://api.example.com/api/mcp/notion',
        headers: {},
      },
    };

    await expect(
      listFastAgentIntegrations({
        userId: 'user-1',
        apiBaseUrl: 'https://api.example.com',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'notion',
        tools: [expect.objectContaining({ name: 'search' })],
      }),
    ]);

    mocks.listMcpTools.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    await expect(
      listFastAgentIntegrations({
        userId: 'user-1',
        apiBaseUrl: 'https://api.example.com',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'notion',
        tools: [expect.objectContaining({ name: 'search' })],
      }),
    ]);
    expect(mocks.listMcpTools).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(
      listFastAgentIntegrations({
        userId: 'user-1',
        apiBaseUrl: 'https://api.example.com',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'notion',
        tools: [expect.objectContaining({ name: 'search' })],
      }),
    ]);
    expect(mocks.listMcpTools).toHaveBeenCalledTimes(2);
  });

  it('excludes tools disabled by the deployment', async () => {
    mocks.configuredServers = {
      notion: {
        url: 'https://api.example.com/api/mcp/notion',
        headers: {},
        disabledTools: ['search'],
      },
    };

    const integrations = await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://api.example.com',
    });

    expect(integrations).toEqual([]);
  });

  it('does not cache failed tool discovery', async () => {
    mocks.configuredServers = {
      notion: {
        url: 'https://api.example.com/api/mcp/notion',
        headers: {},
      },
    };
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

  it('times out hung tool discovery without poisoning the cache', async () => {
    vi.useFakeTimers();
    mocks.configuredServers = {
      notion: {
        url: 'https://api.example.com/api/mcp/notion',
        headers: {},
      },
    };
    mocks.listMcpTools
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce([{ name: 'search' }]);

    const timedOut = listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://api.example.com',
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(timedOut).resolves.toEqual([]);
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
      signal: expect.any(AbortSignal),
    });
    expect(mocks.beginIntegrationCall).toHaveBeenCalledWith({
      fastAgentConversationId: 'session-1',
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

  it('times out a hung integration call and records the failure', async () => {
    vi.useFakeTimers();
    mocks.callMcpTool.mockImplementation(() => new Promise(() => undefined));

    const call = callFastAgentIntegration(
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
    const timedOut = expect(call).rejects.toThrow(
      'Fast notion/search integration call timed out after 60000ms.',
    );
    await vi.advanceTimersByTimeAsync(60_000);

    await timedOut;
    expect(mocks.completeIntegrationCall).toHaveBeenCalledWith({
      id: 'audit-1',
      status: 'failed',
      error: 'Fast notion/search integration call timed out after 60000ms.',
      startedAt: new Date('2026-08-16T00:00:00.000Z'),
    });
  });
});
