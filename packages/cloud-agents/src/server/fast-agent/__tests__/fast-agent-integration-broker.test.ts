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
  callGitHubWrite: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({
  createAuthToken: mocks.createAuthToken,
  createGitHubToken: vi.fn(),
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

vi.mock('../../mcp-policy', () => ({
  isRouterMcpServerEnabled: vi.fn(() => true),
}));

vi.mock('../../mcp-tool-client', () => ({
  listMcpTools: mocks.listMcpTools,
  callMcpTool: mocks.callMcpTool,
}));

vi.mock('@roomote/github', () => ({ getOctokit: vi.fn() }));
vi.mock('../fast-agent-github-writes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fast-agent-github-writes')>()),
  callFastGitHubWrite: mocks.callGitHubWrite,
}));

import {
  callFastAgentIntegration,
  clearFastAgentIntegrationToolCache,
  listFastAgentIntegrations as listFastAgentIntegrationsWithResolver,
} from '../fast-agent-integration-broker';
import {
  CALL_INTEGRATION_TOOL_TOOL,
  matchIntegrationTools,
} from '@roomote/types';
import { z } from 'zod';

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

  it('discovers and forwards required Sentry organization scope without injecting a default', async () => {
    mocks.configuredServers = {
      sentry: { url: 'https://api.example.com/api/mcp/sentry', headers: {} },
    };
    const inputSchema = {
      type: 'object',
      properties: {
        organizationSlug: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['organizationSlug', 'query'],
    };
    mocks.listMcpTools.mockResolvedValue([
      { name: 'search_issues', inputSchema },
    ]);
    mocks.callMcpTool.mockImplementation(async ({ args }) => {
      z.object({
        organizationSlug: z.string().min(1),
        query: z.string(),
      }).parse(args);
      return { issues: [] };
    });
    const available = await listFastAgentIntegrations(auditContext);
    const {
      tools: [tool],
    } = matchIntegrationTools(
      available.flatMap((integration) =>
        integration.tools.map((entry) => ({
          ...entry,
          integrationId: integration.id,
        })),
      ),
      { integrationId: 'sentry', toolName: 'search_issues' },
    );
    expect(tool?.inputSchema).toEqual(inputSchema);
    const args = { organizationSlug: 'example-org', query: 'lastSeen:-24h' };
    const request = z.object(CALL_INTEGRATION_TOOL_TOOL.inputSchema).parse({
      integrationId: tool!.integrationId,
      toolName: tool!.name,
      args,
    });
    await expect(
      callFastAgentIntegration(auditContext, available, {
        ...request,
        args: request.args!,
      }),
    ).resolves.toEqual({ issues: [] });
    expect(mocks.callMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.example.com/api/mcp/sentry',
        headers: { Authorization: 'Bearer control-plane-token' },
        args,
      }),
    );
    await expect(
      callFastAgentIntegration(auditContext, available, {
        ...request,
        args: { query: args.query },
      }),
    ).rejects.toThrow();
    expect(mocks.callMcpTool).toHaveBeenLastCalledWith(
      expect.objectContaining({ args: { query: args.query } }),
    );
    await expect(
      callFastAgentIntegration(auditContext, [], { ...request, args }),
    ).rejects.toThrow('not available');
    expect(mocks.callMcpTool).toHaveBeenCalledTimes(2);
  });

  it('preserves proxy reads and adds bounded local GitHub writes', async () => {
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
      'update_pull_request',
      'add_issue_comment',
    ]);
    expect(mocks.listMcpTools).toHaveBeenCalledWith({
      url: 'https://api.example.com/api/mcp-routing/github',
      headers: { Authorization: 'Bearer control-plane-token' },
      signal: expect.any(AbortSignal),
    });
  });

  it('dispatches discovered PR close locally as the requesting actor and audits it', async () => {
    mocks.findGithubInstallation.mockResolvedValue({ id: 42 });
    const available = await listFastAgentIntegrations(auditContext);
    const args = {
      owner: 'example',
      repo: 'repo',
      pullNumber: 17,
      state: 'closed',
    };
    mocks.callGitHubWrite.mockResolvedValue({ number: 17, state: 'closed' });
    await expect(
      callFastAgentIntegration(auditContext, available, {
        integrationId: 'github',
        toolName: 'update_pull_request',
        args,
      }),
    ).resolves.toEqual({ number: 17, state: 'closed' });
    expect(mocks.callGitHubWrite).toHaveBeenCalledWith({
      userId: 'user-1',
      toolName: 'update_pull_request',
      args,
      signal: expect.any(AbortSignal),
    });
    expect(mocks.beginIntegrationCall).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', arguments: args }),
    );
    expect(mocks.completeIntegrationCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'succeeded' }),
    );
    expect(mocks.callMcpTool).not.toHaveBeenCalled();
  });

  it('does not expose or invoke disabled writes or unlisted destructive tools', async () => {
    mocks.findGithubInstallation.mockResolvedValue({ id: 42 });
    mocks.configuredServers = {
      github: {
        url: 'https://api.example.com/api/mcp-routing/github',
        headers: {},
        disabledTools: ['update_pull_request'],
      },
    };
    const available = await listFastAgentIntegrations(auditContext);
    expect(available[0]?.tools.map((tool) => tool.name)).not.toContain(
      'update_pull_request',
    );
    for (const toolName of [
      'update_pull_request',
      'merge_pull_request',
      'delete_file',
      'actions_run_trigger',
    ]) {
      await expect(
        callFastAgentIntegration(auditContext, available, {
          integrationId: 'github',
          toolName,
          args: {},
        }),
      ).rejects.toThrow('not available');
    }
    expect(mocks.callGitHubWrite).not.toHaveBeenCalled();
    expect(mocks.callMcpTool).not.toHaveBeenCalled();
  });

  it('records denied GitHub writes as failed, never successful', async () => {
    mocks.findGithubInstallation.mockResolvedValue({ id: 42 });
    const available = await listFastAgentIntegrations(auditContext);
    mocks.callGitHubWrite.mockRejectedValue(
      new Error('GitHub API returned HTTP 403'),
    );
    await expect(
      callFastAgentIntegration(auditContext, available, {
        integrationId: 'github',
        toolName: 'add_issue_comment',
        args: {},
      }),
    ).rejects.toThrow('HTTP 403');
    expect(mocks.completeIntegrationCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(mocks.callMcpTool).not.toHaveBeenCalled();
  });

  it('never dispatches a local GitHub write without its durable audit record', async () => {
    mocks.findGithubInstallation.mockResolvedValue({ id: 42 });
    const available = await listFastAgentIntegrations(auditContext);
    mocks.beginIntegrationCall.mockRejectedValueOnce(
      new Error('Audit unavailable'),
    );
    await expect(
      callFastAgentIntegration(auditContext, available, {
        integrationId: 'github',
        toolName: 'update_pull_request',
        args: {
          owner: 'example',
          repo: 'repo',
          pullNumber: 17,
          state: 'closed',
        },
      }),
    ).rejects.toThrow('Audit unavailable');
    expect(mocks.callGitHubWrite).not.toHaveBeenCalled();
    expect(mocks.callMcpTool).not.toHaveBeenCalled();
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
      {
        name: 'manage_tasks',
        description: 'Manage Sessions and tasks, including launch.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['search', 'get_summary', 'launch', 'cancel'],
            },
            taskId: { type: 'string' },
            prompt: { type: 'string' },
            environmentId: { type: 'string' },
            branch: { type: 'string' },
            notifyOnSettle: { type: 'boolean' },
          },
        },
      },
    ]);

    const integrations = await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://app.example.test/_roomote-api',
    });

    expect(integrations).toEqual([
      expect.objectContaining({
        id: 'roomote',
        tools: [
          {
            name: 'manage_tasks',
            description:
              'Manage Roomote Sessions and inspect or control existing tasks. Use launch_task to start coding work from a Fast Session.',
            inputSchema: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['search', 'get_summary', 'cancel'],
                  description:
                    'The Session or existing-task action to perform.',
                },
                taskId: { type: 'string' },
              },
            },
          },
        ],
      }),
    ]);
    expect(mocks.listMcpTools).toHaveBeenCalledWith({
      url: 'https://app.example.test/_roomote-api/mcp',
      headers: { Authorization: 'Bearer control-plane-token' },
      signal: expect.any(AbortSignal),
    });
  });

  it('omits manage_tasks when its schema cannot safely remove task launch', async () => {
    mocks.configuredServers = {
      roomote: {
        url: 'https://app.example.test/mcp',
        headers: {},
      },
    };
    mocks.listMcpTools.mockResolvedValue([
      { name: 'manage_tasks', inputSchema: { type: 'object' } },
      { name: 'manage_custom_automations', inputSchema: { type: 'object' } },
    ]);

    const integrations = await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://app.example.test/_roomote-api',
    });

    expect(integrations[0]?.tools).toEqual([
      { name: 'manage_custom_automations', inputSchema: { type: 'object' } },
    ]);
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
      {
        name: 'manage_tasks',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['search', 'launch'] },
          },
        },
      },
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

  it('keeps serving a catalog left idle for a long time instead of blocking on rediscovery', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-19T00:00:00.000Z') });
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
    expect(mocks.listMcpTools).toHaveBeenCalledTimes(1);

    // Well past the refresh interval. Another user's cache miss runs the
    // eviction pass that used to drop entries this old.
    await vi.advanceTimersByTimeAsync(45 * 60_000);
    await listFastAgentIntegrations({
      userId: 'user-2',
      apiBaseUrl: 'https://api.example.com',
    });
    expect(mocks.listMcpTools).toHaveBeenCalledTimes(2);

    mocks.listMcpTools.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
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
    expect(mocks.listMcpTools).toHaveBeenCalledTimes(3);
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

  it('rejects legacy manage_tasks launches before they can create an untracked Fast child', async () => {
    await expect(
      callFastAgentIntegration(
        auditContext,
        [
          {
            id: 'roomote',
            name: 'Roomote',
            description: 'Deployment management',
            tools: [{ name: 'manage_tasks' }],
          },
        ],
        {
          integrationId: 'roomote',
          toolName: 'manage_tasks',
          args: {
            action: 'launch',
            prompt: 'Fix checkout',
            environmentId: 'environment-1',
          },
        },
      ),
    ).rejects.toThrow(
      'Fast Sessions must use launch_task so the child stays attached and reports settlement to its parent Session.',
    );
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
