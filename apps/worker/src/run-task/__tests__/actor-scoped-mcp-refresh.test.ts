const { mockGetMcpServerConfigs } = vi.hoisted(() => ({
  mockGetMcpServerConfigs: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    mcpConnections: {
      getMcpServerConfigs: mockGetMcpServerConfigs,
    },
  },
}));

import { createActorScopedMcpRefresher } from '../actor-scoped-mcp-refresh';

describe('createActorScopedMcpRefresher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMcpServerConfigs.mockResolvedValue({ servers: {} });
  });

  it('requests a reconnect when the actor-scoped MCP config changes', async () => {
    const requestReconnect = vi.fn().mockResolvedValue(undefined);
    const integrations = {
      userMcpServers: {
        notion: {
          url: 'https://api.example.test/api/mcp/notion',
        },
      },
    };

    mockGetMcpServerConfigs.mockResolvedValueOnce({
      servers: {
        supabase: {
          url: 'https://api.example.test/api/mcp/supabase',
          headers: {
            Authorization: 'Bearer cloud-token',
          },
        },
      },
    });

    const refreshActorScopedMcp = createActorScopedMcpRefresher({
      cloudJob: {
        id: 42,
        actingUserId: 'owner-user',
      },
      integrations,
      requestReconnect,
      logger: {
        cloudJobId: 42,
        filePath: '/tmp/test.log',
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      },
    });

    await refreshActorScopedMcp('actor-user');

    expect(integrations.userMcpServers).toEqual({
      supabase: {
        url: 'https://api.example.test/api/mcp/supabase',
        headers: {
          Authorization: 'Bearer cloud-token',
        },
      },
    });
    expect(requestReconnect).toHaveBeenCalledWith({
      reason: 'actor-scoped MCP refresh for actor-user',
      afterCurrentTurn: false,
    });
  });

  it('skips reconnect when the actor changes but the config stays the same', async () => {
    const requestReconnect = vi.fn().mockResolvedValue(undefined);
    const integrations = {
      userMcpServers: {
        notion: {
          url: 'https://api.example.test/api/mcp/notion',
          headers: {
            'X-MCP-Client': 'Roomote',
          },
        },
      },
    };

    mockGetMcpServerConfigs.mockResolvedValueOnce({
      servers: {
        notion: {
          url: 'https://api.example.test/api/mcp/notion',
          headers: {
            'X-MCP-Client': 'Roomote',
          },
        },
      },
    });

    const refreshActorScopedMcp = createActorScopedMcpRefresher({
      cloudJob: {
        id: 42,
        actingUserId: 'owner-user',
      },
      integrations,
      requestReconnect,
      logger: {
        cloudJobId: 42,
        filePath: '/tmp/test.log',
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      },
    });

    await refreshActorScopedMcp('actor-user');

    expect(requestReconnect).not.toHaveBeenCalled();
  });

  it('requests a reconnect when the same actor links a new MCP', async () => {
    const requestReconnect = vi.fn().mockResolvedValue(undefined);
    const integrations = {
      userMcpServers: {
        notion: {
          url: 'https://api.example.test/api/mcp/notion',
        },
      },
    };

    mockGetMcpServerConfigs.mockResolvedValueOnce({
      servers: {
        supabase: {
          url: 'https://api.example.test/api/mcp/supabase',
        },
      },
    });

    const refreshActorScopedMcp = createActorScopedMcpRefresher({
      cloudJob: {
        id: 42,
        actingUserId: 'owner-user',
      },
      integrations,
      requestReconnect,
      logger: {
        cloudJobId: 42,
        filePath: '/tmp/test.log',
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      },
    });

    await refreshActorScopedMcp('owner-user');

    expect(integrations.userMcpServers).toEqual({
      supabase: {
        url: 'https://api.example.test/api/mcp/supabase',
      },
    });
    expect(requestReconnect).toHaveBeenCalledWith({
      reason: 'actor-scoped MCP refresh for owner-user',
      afterCurrentTurn: false,
    });
  });

  it('skips reconnect when the same actor snapshot stays the same', async () => {
    const requestReconnect = vi.fn().mockResolvedValue(undefined);
    const integrations = {
      userMcpServers: {
        notion: {
          url: 'https://api.example.test/api/mcp/notion',
          headers: {
            'X-MCP-Client': 'Roomote',
          },
        },
      },
    };

    mockGetMcpServerConfigs.mockResolvedValueOnce({
      servers: {
        notion: {
          url: 'https://api.example.test/api/mcp/notion',
          headers: {
            'X-MCP-Client': 'Roomote',
          },
        },
      },
    });

    const refreshActorScopedMcp = createActorScopedMcpRefresher({
      cloudJob: {
        id: 42,
        actingUserId: 'owner-user',
      },
      integrations,
      requestReconnect,
      logger: {
        cloudJobId: 42,
        filePath: '/tmp/test.log',
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      },
    });

    await refreshActorScopedMcp('owner-user');

    expect(requestReconnect).not.toHaveBeenCalled();
  });

  it('retries the same actor after a transient refresh failure', async () => {
    const requestReconnect = vi.fn().mockResolvedValue(undefined);
    const integrations = {
      userMcpServers: {
        notion: {
          url: 'https://api.example.test/api/mcp/notion',
        },
      },
    };

    mockGetMcpServerConfigs
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({
        servers: {
          supabase: {
            url: 'https://api.example.test/api/mcp/supabase',
          },
        },
      });

    const refreshActorScopedMcp = createActorScopedMcpRefresher({
      cloudJob: {
        id: 42,
        actingUserId: 'owner-user',
      },
      integrations,
      requestReconnect,
      logger: {
        cloudJobId: 42,
        filePath: '/tmp/test.log',
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      },
    });

    await refreshActorScopedMcp('actor-user');
    await refreshActorScopedMcp('actor-user');

    expect(requestReconnect).toHaveBeenCalledTimes(1);
    expect(requestReconnect).toHaveBeenCalledWith({
      reason: 'actor-scoped MCP refresh for actor-user',
      afterCurrentTurn: false,
    });
    expect(integrations.userMcpServers).toEqual({
      supabase: {
        url: 'https://api.example.test/api/mcp/supabase',
      },
    });
  });

  it('defers reconnect until the current turn boundary when requested', async () => {
    const requestReconnect = vi.fn().mockResolvedValue(undefined);
    const integrations = {
      userMcpServers: {
        notion: {
          url: 'https://api.example.test/api/mcp/notion',
        },
      },
    };

    mockGetMcpServerConfigs.mockResolvedValueOnce({
      servers: {
        supabase: {
          url: 'https://api.example.test/api/mcp/supabase',
        },
      },
    });

    const refreshActorScopedMcp = createActorScopedMcpRefresher({
      cloudJob: {
        id: 42,
        actingUserId: 'owner-user',
      },
      integrations,
      requestReconnect,
      logger: {
        cloudJobId: 42,
        filePath: '/tmp/test.log',
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      },
    });

    await refreshActorScopedMcp('actor-user', {
      deferReconnectUntilTurnBoundary: true,
    });

    expect(requestReconnect).toHaveBeenCalledWith({
      reason: 'actor-scoped MCP refresh for actor-user',
      afterCurrentTurn: true,
    });
  });

  it('updates the mounted snapshot without reconnecting when the caller restarts later', async () => {
    const requestReconnect = vi.fn().mockResolvedValue(undefined);
    const integrations = {
      userMcpServers: {
        notion: {
          url: 'https://api.example.test/api/mcp/notion',
        },
      },
    };

    mockGetMcpServerConfigs.mockResolvedValueOnce({
      servers: {
        supabase: {
          url: 'https://api.example.test/api/mcp/supabase',
        },
      },
    });

    const refreshActorScopedMcp = createActorScopedMcpRefresher({
      cloudJob: {
        id: 42,
        actingUserId: 'owner-user',
      },
      integrations,
      requestReconnect,
      logger: {
        cloudJobId: 42,
        filePath: '/tmp/test.log',
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      },
    });

    const result = await refreshActorScopedMcp('actor-user', {
      skipReconnect: true,
    });

    expect(result).toMatchObject({
      didChange: true,
      didReconnect: false,
      reason: 'actor-scoped MCP refresh for actor-user',
    });
    expect(integrations.userMcpServers).toEqual({
      supabase: {
        url: 'https://api.example.test/api/mcp/supabase',
      },
    });
    expect(requestReconnect).not.toHaveBeenCalled();
  });
});
