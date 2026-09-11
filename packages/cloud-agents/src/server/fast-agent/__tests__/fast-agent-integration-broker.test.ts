const mocks = vi.hoisted(() => ({
  configuredServers: {} as Record<
    string,
    {
      url: string;
      headers: Record<string, string>;
      disabledTools?: string[];
      cacheRevision?: string;
    }
  >,
  createAuthToken: vi.fn(),
  createSessionBrokerToken: vi.fn(),
  listMcpTools: vi.fn(),
  callMcpTool: vi.fn(),
  beginIntegrationCall: vi.fn(),
  completeIntegrationCall: vi.fn(),
  findGithubInstallation: vi.fn(),
  isRouterMcpServerEnabled: vi.fn(),
  findGitlabRepository: vi.fn(),
  findGitlabConnection: vi.fn(),
  resolveGitLabInstanceHost: vi.fn(),
  env: {
    R_CURATED_INTEGRATIONS_DISABLED: false,
  },
  getBitbucketOAuthConnection: vi.fn(),
  resolveBitbucketInstanceHost: vi.fn(),
  findMember: vi.fn(),
  findRepository: vi.fn(),
}));

vi.mock('@roomote/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/env')>()),
  Env: mocks.env,
}));

vi.mock('@roomote/bitbucket', () => ({
  getBitbucketOAuthConnection: mocks.getBitbucketOAuthConnection,
  resolveBitbucketInstanceHost: mocks.resolveBitbucketInstanceHost,
}));

vi.mock('@roomote/auth', () => ({
  createAuthToken: mocks.createAuthToken,
  createSessionBrokerToken: mocks.createSessionBrokerToken,
  ROOMOTE_MCP_PATH: '/mcp',
}));

vi.mock('@roomote/gitlab', () => ({
  resolveGitLabInstanceHost: mocks.resolveGitLabInstanceHost,
}));

vi.mock('@roomote/db/server', () => ({
  beginSlackFastIntegrationCall: mocks.beginIntegrationCall,
  completeSlackFastIntegrationCall: mocks.completeIntegrationCall,
  db: {
    query: {
      githubInstallations: { findFirst: mocks.findGithubInstallation },
      repositories: {
        findFirst: (options: { where: [string, unknown][] }) => {
          const provider = options.where.find(
            ([column]) => column === 'provider',
          )?.[1];
          if (provider === 'gitlab') return mocks.findGitlabRepository(options);
          if (provider === 'bitbucket') return mocks.findRepository(options);
          throw new Error(`Unexpected repository provider: ${provider}`);
        },
      },
      deploymentSecrets: { findFirst: mocks.findGitlabConnection },
      users: { findFirst: mocks.findMember },
    },
  },
  githubInstallations: { suspendedAt: 'suspendedAt' },
  deploymentSecrets: { name: 'name' },
  users: { id: 'user-id', deletedAt: 'deletedAt' },
  repositories: {
    sourceControlProvider: 'provider',
    host: 'host',
    isActive: 'active',
  },
  and: vi.fn((...conditions) => conditions),
  eq: vi.fn((column, value) => [column, value]),
  isNull: vi.fn(() => 'not-suspended-filter'),
}));

vi.mock('../../mcp-policy', () => ({
  isRouterMcpServerEnabled: mocks.isRouterMcpServerEnabled,
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
import {
  CALL_INTEGRATION_TOOL_TOOL,
  matchIntegrationTools,
} from '@roomote/types';
import { z } from 'zod';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { startMcpToolTestServer } from '../../__tests__/mcp-tool-client-fixture';

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
    mocks.createSessionBrokerToken.mockResolvedValue('session-broker-token');
    mocks.findGithubInstallation.mockResolvedValue(undefined);
    mocks.isRouterMcpServerEnabled.mockReturnValue(false);
    mocks.env.R_CURATED_INTEGRATIONS_DISABLED = false;
    mocks.resolveGitLabInstanceHost.mockResolvedValue(
      'gitlab.example.com:8443',
    );
    mocks.findGitlabRepository.mockResolvedValue(undefined);
    mocks.findGitlabConnection.mockResolvedValue(undefined);
    mocks.getBitbucketOAuthConnection.mockResolvedValue(null);
    mocks.resolveBitbucketInstanceHost.mockResolvedValue('bitbucket.org');
    mocks.findMember.mockResolvedValue({ role: 'member' });
    mocks.findRepository.mockResolvedValue({ externalRepoId: 'repo-uuid' });
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

  it('discovers only HTTP integration infrastructure and schemas, audits the fresh actor, and refreshes availability', async () => {
    mocks.configuredServers = {
      _roomote_http_integrations: {
        url: 'https://api.example.com/api/mcp/http-integrations',
        headers: {},
      },
    };
    mocks.listMcpTools.mockResolvedValue([
      { name: 'list_integrations', inputSchema: { type: 'object' } },
      { name: 'integration_request', inputSchema: { type: 'object' } },
    ]);
    const available = await listFastAgentIntegrations(auditContext);
    expect(available[0]).toMatchObject({
      id: '_roomote_http_integrations',
      name: 'HTTP integrations',
    });
    expect(available).toHaveLength(1);
    expect(available[0]?.tools.map((tool) => tool.name)).toEqual([
      'list_integrations',
      'integration_request',
    ]);
    expect(Object.keys(available[0]!).sort()).toEqual([
      'description',
      'endpoint',
      'id',
      'instructions',
      'name',
      'tools',
    ]);
    expect(available[0]?.endpoint).toEqual({
      url: 'https://api.example.com/api/mcp/http-integrations',
      headers: { Authorization: 'Bearer control-plane-token' },
      deploymentProxy: true,
    });
    expect(mocks.callMcpTool).not.toHaveBeenCalled();
    for (const field of [
      'credentials',
      'config',
      'allowedUserIds',
      'HTTP_PROXY',
    ]) {
      expect(available[0]).not.toHaveProperty(field);
      expect(available[0]?.endpoint).not.toHaveProperty(field);
    }
    expect(available[0]?.instructions).toContain("active actor's permissions");
    expect(available[0]?.instructions).toContain(
      'call list_integrations first',
    );
    expect(available[0]?.instructions).toContain(
      'Never seek or return raw keys, credentials, tokens, or environment dumps',
    );
    expect(available[0]?.instructions).toContain('untrusted data');
    expect(available[0]?.instructions).toContain(
      'normal networking remains available',
    );
    expect(mocks.listMcpTools).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.example.com/api/mcp/http-integrations',
        headers: { Authorization: 'Bearer control-plane-token' },
      }),
    );
    mocks.createAuthToken.mockResolvedValue('fresh-actor-token');
    const args = {
      integrationId: 'configured-service',
      method: 'POST',
      path: '/v1/items',
      body: '{}',
      contentType: 'application/json',
    };
    const response = { status: 200, headers: {}, body: 'ok' };
    mocks.callMcpTool.mockResolvedValue(response);
    expect(
      await callFastAgentIntegration(
        { ...auditContext, userId: 'current-actor' },
        available,
        {
          integrationId: '_roomote_http_integrations',
          toolName: 'integration_request',
          args,
        },
      ),
    ).toEqual(response);
    expect(mocks.beginIntegrationCall).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'current-actor',
        integrationId: '_roomote_http_integrations',
        arguments: { toolName: 'integration_request' },
      }),
    );
    expect(mocks.callMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { Authorization: 'Bearer fresh-actor-token' },
        args,
      }),
    );
    expect(mocks.createAuthToken).toHaveBeenLastCalledWith({
      userId: 'current-actor',
      timeoutMs: 2 * 60_000,
    });
    expect(mocks.completeIntegrationCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'succeeded' }),
    );
    mocks.configuredServers = {};
    const refreshed = await listFastAgentIntegrations(auditContext);
    expect(refreshed).toEqual([]);
    await expect(
      callFastAgentIntegration(auditContext, refreshed, {
        integrationId: '_roomote_http_integrations',
        toolName: 'list_integrations',
        args: {},
      }),
    ).rejects.toThrow('not available');
  });

  it.each([true, false])(
    'mints Session authority only at a human HTTP broker call: humanTurn=%s',
    async (humanTurn) => {
      mocks.configuredServers = {
        _roomote_http_integrations: {
          url: 'https://api.example.com/api/mcp/http-integrations',
          headers: {},
        },
      };
      mocks.listMcpTools.mockResolvedValue([
        { name: 'integration_request', inputSchema: { type: 'object' } },
      ]);
      const available = await listFastAgentIntegrations(auditContext);
      expect(mocks.createSessionBrokerToken).not.toHaveBeenCalled();
      expect(mocks.listMcpTools).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: { Authorization: 'Bearer control-plane-token' },
        }),
      );
      const args = {
        integrationId: 'session:e9d35700-56b8-4bf0-b088-c1cb498905d9',
        method: 'GET',
        path: '/private?query=sensitive-request-canary',
        userId: 'forged-actor',
        fastConversationId: 'forged-conversation',
        sessionId: 'forged-session',
        humanTurn: true,
      };
      const response = { status: 200, body: 'sensitive-response-canary' };
      mocks.callMcpTool.mockResolvedValue(response);
      await expect(
        callFastAgentIntegration(
          {
            ...auditContext,
            userId: 'trusted-actor',
            sessionId: 'persisted-conversation',
            humanTurn,
          },
          available,
          {
            integrationId: '_roomote_http_integrations',
            toolName: 'integration_request',
            args,
          },
        ),
      ).resolves.toEqual(response);
      if (humanTurn) {
        expect(mocks.createSessionBrokerToken).toHaveBeenCalledExactlyOnceWith({
          userId: 'trusted-actor',
          fastConversationId: 'persisted-conversation',
        });
      } else {
        expect(mocks.createSessionBrokerToken).not.toHaveBeenCalled();
      }
      expect(mocks.callMcpTool).toHaveBeenCalledWith(
        expect.objectContaining({
          args,
          headers: {
            Authorization: `Bearer ${humanTurn ? 'session-broker-token' : 'control-plane-token'}`,
          },
        }),
      );
      expect(mocks.beginIntegrationCall).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'trusted-actor',
          fastAgentConversationId: 'persisted-conversation',
          arguments: { toolName: 'integration_request' },
        }),
      );
      expect(mocks.completeIntegrationCall).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'succeeded',
          resultPreview: '[Broker result omitted]',
        }),
      );
      expect(
        JSON.stringify([
          mocks.beginIntegrationCall.mock.calls,
          mocks.completeIntegrationCall.mock.calls,
        ]),
      ).not.toContain('canary');
    },
  );

  it.each([
    { id: '_roomote_http_integrations', deploymentProxy: false },
    { id: 'custom-http-integrations', deploymentProxy: true },
  ])(
    'does not mint Session authority for $id with deploymentProxy=$deploymentProxy',
    async ({ id, deploymentProxy }) => {
      mocks.callMcpTool.mockResolvedValue({ ok: true });
      await callFastAgentIntegration(
        { ...auditContext, humanTurn: true },
        [
          {
            id,
            name: id,
            description: 'Not the trusted Session broker',
            endpoint: {
              url: 'https://other.example.com/mcp',
              headers: { Authorization: 'Bearer upstream-token' },
              deploymentProxy,
            },
            tools: [{ name: 'integration_request' }],
          },
        ],
        { integrationId: id, toolName: 'integration_request', args: {} },
      );
      expect(mocks.createSessionBrokerToken).not.toHaveBeenCalled();
      expect(mocks.callMcpTool).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {
            Authorization: `Bearer ${deploymentProxy ? 'control-plane-token' : 'upstream-token'}`,
          },
        }),
      );
    },
  );

  it.each(['token', 'transport'])(
    'preserves failed Session broker audit status after %s failure',
    async (failure) => {
      const error = new Error('Broker request unavailable');
      if (failure === 'token')
        mocks.createSessionBrokerToken.mockRejectedValueOnce(error);
      else mocks.callMcpTool.mockRejectedValueOnce(error);
      await expect(
        callFastAgentIntegration(
          { ...auditContext, humanTurn: true },
          [
            {
              id: '_roomote_http_integrations',
              name: 'HTTP integrations',
              description: 'Broker',
              endpoint: {
                url: 'https://api.example.com/api/mcp/http-integrations',
                headers: {},
                deploymentProxy: true,
              },
              tools: [{ name: 'integration_request' }],
            },
          ],
          {
            integrationId: '_roomote_http_integrations',
            toolName: 'integration_request',
            args: { path: '/sensitive-request-canary' },
          },
        ),
      ).rejects.toBe(error);
      expect(mocks.completeIntegrationCall).toHaveBeenCalledExactlyOnceWith({
        id: 'audit-1',
        status: 'failed',
        error: 'Broker request unavailable',
        startedAt: new Date('2026-08-16T00:00:00.000Z'),
      });
      expect(
        JSON.stringify(mocks.beginIntegrationCall.mock.calls),
      ).not.toContain('sensitive-request-canary');
      if (failure === 'token') expect(mocks.callMcpTool).not.toHaveBeenCalled();
    },
  );

  it('keeps a custom http-integrations server distinct from broker guidance', async () => {
    mocks.configuredServers = {
      'http-integrations': {
        url: 'https://api.example.com/api/mcp/custom/server-1',
        headers: { 'X-MCP-Client': 'Roomote' },
      },
    };

    const available = await listFastAgentIntegrations(auditContext);

    expect(available).toEqual([
      expect.objectContaining({
        id: 'http-integrations',
        name: 'http-integrations',
        instructions: undefined,
        endpoint: {
          url: 'https://api.example.com/api/mcp/custom/server-1',
          headers: {
            'X-MCP-Client': 'Roomote',
            Authorization: 'Bearer control-plane-token',
          },
          deploymentProxy: true,
        },
      }),
    ]);
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

  it('requires an installation before discovering native GitHub tools for public reads', async () => {
    mocks.isRouterMcpServerEnabled.mockReturnValue(true);
    expect(await listFastAgentIntegrations(auditContext)).toEqual([]);
    expect(mocks.listMcpTools).not.toHaveBeenCalled();
    mocks.findGithubInstallation.mockResolvedValue({ id: 42 });
    const tools = [
      'get_file_contents',
      'issue_read',
      'pull_request_read',
      'list_pull_requests',
      'search_pull_requests',
      'search_code',
    ].map((name) => ({ name, inputSchema: { type: 'object' } }));
    mocks.listMcpTools.mockResolvedValue(tools);
    const integrations = await listFastAgentIntegrations(auditContext);
    expect(integrations.map(({ id }) => id)).toEqual(['github']);
    expect(integrations[0]?.tools).toEqual(tools);
    expect(mocks.isRouterMcpServerEnabled).toHaveBeenCalledWith('github');
    expect(mocks.findGithubInstallation).toHaveBeenCalledTimes(2);
    expect(mocks.findMember).not.toHaveBeenCalled();
    expect(mocks.listMcpTools).toHaveBeenCalledWith({
      url: 'https://api.example.com/api/mcp-routing/github',
      headers: { Authorization: 'Bearer control-plane-token' },
      signal: expect.any(AbortSignal),
    });
    mocks.isRouterMcpServerEnabled.mockReturnValue(false);
    expect(await listFastAgentIntegrations(auditContext)).toEqual([]);
    expect(mocks.listMcpTools).toHaveBeenCalledOnce();
  });

  it('preserves custom GitHub configuration and disabled tools without adding a default server', async () => {
    mocks.isRouterMcpServerEnabled.mockReturnValue(true);
    mocks.configuredServers.github = {
      url: 'https://github-mcp.example.com/mcp',
      headers: { Authorization: 'Bearer custom-token' },
      disabledTools: ['issue_read'],
    };
    mocks.listMcpTools.mockResolvedValue([
      { name: 'get_file_contents', inputSchema: { type: 'object' } },
      { name: 'issue_read', inputSchema: { type: 'object' } },
    ]);
    const integrations = await listFastAgentIntegrations(auditContext);
    expect(integrations.map(({ id }) => id)).toEqual(['github']);
    expect(integrations[0]?.tools.map(({ name }) => name)).toEqual([
      'get_file_contents',
    ]);
    expect(mocks.listMcpTools).toHaveBeenCalledOnce();
    expect(mocks.listMcpTools).toHaveBeenCalledWith({
      url: 'https://github-mcp.example.com/mcp',
      headers: { Authorization: 'Bearer custom-token' },
      signal: expect.any(AbortSignal),
    });
  });

  // Synthetic upstream contracts exercise transport, not the live Better Stack API.
  it.each([
    {
      name: 'sources',
      fields: [],
      properties: {
        name: { type: 'string' },
        page: { type: 'integer' },
        per_page: { type: 'integer' },
      },
      args: {},
    },
    {
      name: 'source',
      fields: ['id'],
      properties: { id: { type: 'integer' } },
      args: { id: 42 },
    },
    {
      name: 'query',
      fields: ['source_id', 'table', 'query'],
      properties: {
        source_id: { type: 'number' },
        table: { type: 'string' },
        host: { type: 'string' },
        query: { type: 'string' },
      },
      args: {
        source_id: 42,
        table: 'observed_logs_7',
        host: 'cluster.example.test',
        query: 'SELECT count() FROM observed_logs_7',
      },
    },
  ])(
    'discovers exact Better Stack $name in integration scope and forwards without defaults',
    async ({ name, fields, properties, args }) => {
      mocks.configuredServers = {
        betterstack: {
          url: 'https://api.example.com/api/mcp/betterstack',
          headers: {},
        },
        'other-server': { url: 'https://other.example.test/mcp', headers: {} },
      };
      const inputSchema = {
        type: 'object',
        additionalProperties: false,
        properties,
        required: fields,
      };
      const upstreamTool = {
        name,
        description: `Synthetic ${name} contract`,
        inputSchema,
      };
      mocks.listMcpTools.mockResolvedValue([upstreamTool]);
      mocks.callMcpTool.mockImplementation(async ({ args: forwarded }) => {
        z.object(
          Object.fromEntries(
            Object.entries(properties).map(([field, { type }]) => {
              const schema =
                type === 'integer'
                  ? z.number().int()
                  : type === 'number'
                    ? z.number()
                    : z.string();
              return [
                field,
                fields.some((required) => required === field)
                  ? schema
                  : schema.optional(),
              ];
            }),
          ),
        )
          .strict()
          .parse(forwarded);
        return { result: [] };
      });
      const available = await listFastAgentIntegrations(auditContext);
      const catalog = available.flatMap((integration) =>
        integration.tools.map((tool) => ({
          ...tool,
          integrationId: integration.id,
        })),
      );
      expect(
        matchIntegrationTools(catalog, {
          integrationId: 'betterstack',
          toolName: name,
          query: 'source table metadata',
        }).tools,
      ).toEqual([{ ...upstreamTool, integrationId: 'betterstack' }]);
      const request = z
        .object(CALL_INTEGRATION_TOOL_TOOL.inputSchema)
        .parse({ integrationId: 'betterstack', toolName: name, args });
      await expect(
        callFastAgentIntegration(auditContext, available, {
          ...request,
          args: request.args!,
        }),
      ).resolves.toEqual({ result: [] });
      expect(mocks.callMcpTool).toHaveBeenLastCalledWith(
        expect.objectContaining({
          url: 'https://api.example.com/api/mcp/betterstack',
          headers: { Authorization: 'Bearer control-plane-token' },
          toolName: name,
          args,
        }),
      );
      if (name === 'query') {
        const withoutHost = Object.fromEntries(
          Object.entries(args).filter(([key]) => key !== 'host'),
        );
        await expect(
          callFastAgentIntegration(auditContext, available, {
            ...request,
            args: withoutHost,
          }),
        ).resolves.toEqual({ result: [] });
        expect(mocks.callMcpTool).toHaveBeenLastCalledWith(
          expect.objectContaining({ args: withoutHost }),
        );
      }
      for (const missing of fields) {
        const incomplete = Object.fromEntries(
          Object.entries(args).filter(([key]) => key !== missing),
        );
        await expect(
          callFastAgentIntegration(auditContext, available, {
            ...request,
            args: incomplete,
          }),
        ).rejects.toThrow();
        expect(mocks.callMcpTool).toHaveBeenLastCalledWith(
          expect.objectContaining({ args: incomplete }),
        );
      }
      expect(mocks.callMcpTool).toHaveBeenCalledTimes(
        1 + fields.length + (name === 'query' ? 1 : 0),
      );
    },
  );

  it.each(['Unauthorized', 'integration unavailable'])(
    'fails closed when Better Stack discovery rejects with %s',
    async (message) => {
      mocks.configuredServers = {
        betterstack: {
          url: 'https://api.example.com/api/mcp/betterstack',
          headers: {},
        },
      };
      mocks.listMcpTools.mockRejectedValueOnce(new Error(message));
      const available = await listFastAgentIntegrations(auditContext);
      expect(available).toEqual([]);
      await expect(
        callFastAgentIntegration(auditContext, available, {
          integrationId: 'betterstack',
          toolName: 'query',
          args: {},
        }),
      ).rejects.toThrow('not available');
      expect(mocks.callMcpTool).not.toHaveBeenCalled();
      expect(mocks.beginIntegrationCall).not.toHaveBeenCalled();
    },
  );

  it('rejects an undiscovered Better Stack query even when another integration exposes it', async () => {
    mocks.configuredServers = {
      betterstack: {
        url: 'https://api.example.com/api/mcp/betterstack',
        headers: {},
      },
      'other-server': { url: 'https://other.example.test/mcp', headers: {} },
    };
    mocks.listMcpTools.mockImplementation(async ({ url }) => [
      {
        name: url.includes('betterstack') ? 'sources' : 'query',
        inputSchema: { type: 'object' },
      },
    ]);
    const available = await listFastAgentIntegrations(auditContext);
    await expect(
      callFastAgentIntegration(auditContext, available, {
        integrationId: 'betterstack',
        toolName: 'query',
        args: {},
      }),
    ).rejects.toThrow('not available');
    expect(mocks.callMcpTool).not.toHaveBeenCalled();
    expect(mocks.beginIntegrationCall).not.toHaveBeenCalled();
  });

  it.each(['Unauthorized', 'tool unavailable'])(
    'preserves Better Stack call-time rejection: %s',
    async (message) => {
      mocks.configuredServers = {
        betterstack: {
          url: 'https://api.example.com/api/mcp/betterstack',
          headers: {},
        },
      };
      mocks.listMcpTools.mockResolvedValue([
        { name: 'query', inputSchema: { type: 'object' } },
      ]);
      const available = await listFastAgentIntegrations(auditContext);
      mocks.callMcpTool.mockRejectedValueOnce(new Error(message));
      await expect(
        callFastAgentIntegration(auditContext, available, {
          integrationId: 'betterstack',
          toolName: 'query',
          args: {},
        }),
      ).rejects.toThrow(message);
      expect(mocks.callMcpTool).toHaveBeenCalledOnce();
      expect(mocks.completeIntegrationCall).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed', error: message }),
      );
    },
  );

  it('exposes GitHub reads and bounded writes through the existing router MCP', async () => {
    mocks.isRouterMcpServerEnabled.mockReturnValue(true);
    mocks.findGithubInstallation.mockResolvedValue({ id: 42 });
    mocks.listMcpTools.mockResolvedValue([
      { name: 'actions_get', inputSchema: { type: 'object' } },
      { name: 'actions_list', inputSchema: { type: 'object' } },
      { name: 'get_job_logs', inputSchema: { type: 'object' } },
      { name: 'update_pull_request', inputSchema: { type: 'object' } },
      { name: 'add_issue_comment', inputSchema: { type: 'object' } },
      {
        name: 'add_reply_to_pull_request_comment',
        inputSchema: { type: 'object' },
      },
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
      'add_reply_to_pull_request_comment',
    ]);
    expect(integrations[0]?.description).toContain(
      'including reviewer requests, draft status, and comment reactions',
    );
    expect(integrations[0]?.description).toContain(
      'Follow the discovered native tool descriptions and schemas',
    );
    expect(mocks.listMcpTools).toHaveBeenCalledWith({
      url: 'https://api.example.com/api/mcp-routing/github',
      headers: { Authorization: 'Bearer control-plane-token' },
      signal: expect.any(AbortSignal),
    });
  });

  it('discovers GitLab from the existing connection without reading secrets and refreshes broker auth at call time', async () => {
    mocks.findGitlabRepository.mockResolvedValue({ id: 'repo-1' });
    mocks.findGitlabConnection.mockResolvedValue({
      name: 'gitlab_deployment_oauth_connection',
    });
    const integrations = await listFastAgentIntegrations(auditContext);
    expect(integrations.map(({ id }) => id)).toEqual(['gitlab']);
    expect(mocks.findGitlabRepository).toHaveBeenCalledWith({
      where: [
        ['provider', 'gitlab'],
        ['active', true],
        ['host', 'gitlab.example.com:8443'],
      ],
      columns: { id: true },
    });
    expect(mocks.findGitlabConnection).toHaveBeenCalledWith({
      where: ['name', 'gitlab_deployment_oauth_connection'],
      columns: { name: true },
    });
    expect(mocks.listMcpTools).toHaveBeenCalledWith({
      url: 'https://api.example.com/api/mcp-routing/gitlab',
      headers: { Authorization: 'Bearer control-plane-token' },
      signal: expect.any(AbortSignal),
    });
    mocks.createAuthToken.mockResolvedValue('fresh-token');
    mocks.callMcpTool.mockResolvedValue({ results: [] });
    await callFastAgentIntegration(auditContext, integrations, {
      integrationId: 'gitlab',
      toolName: 'search',
      args: {},
    });
    expect(mocks.callMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.example.com/api/mcp-routing/gitlab',
        headers: { Authorization: 'Bearer fresh-token' },
      }),
    );
  });

  it.each(['disabled', 'no repository', 'no connection', 'discovery denied'])(
    'does not advertise GitLab with %s',
    async (reason) => {
      mocks.env.R_CURATED_INTEGRATIONS_DISABLED = reason === 'disabled';
      mocks.findGitlabRepository.mockResolvedValue(
        reason === 'no repository' ? undefined : { id: 'repo-1' },
      );
      mocks.findGitlabConnection.mockResolvedValue(
        reason === 'no connection'
          ? undefined
          : { name: 'gitlab_deployment_oauth_connection' },
      );
      if (reason === 'discovery denied')
        mocks.listMcpTools.mockRejectedValueOnce(new Error('Unauthorized'));
      expect(await listFastAgentIntegrations(auditContext)).toEqual([]);
      if (reason !== 'discovery denied')
        expect(mocks.listMcpTools).not.toHaveBeenCalled();
      if (reason === 'disabled')
        expect(mocks.findGitlabConnection).not.toHaveBeenCalled();
    },
  );

  it.each(['disabled', 'no repository', 'no connection'])(
    'does not retain a GitLab catalog after %s',
    async (reason) => {
      mocks.findGitlabRepository.mockResolvedValue({ id: 'repo-1' });
      mocks.findGitlabConnection.mockResolvedValue({
        name: 'gitlab_deployment_oauth_connection',
      });
      expect(await listFastAgentIntegrations(auditContext)).toEqual([
        expect.objectContaining({ id: 'gitlab' }),
      ]);
      mocks.env.R_CURATED_INTEGRATIONS_DISABLED = reason === 'disabled';
      if (reason === 'no repository')
        mocks.findGitlabRepository.mockResolvedValue(undefined);
      if (reason === 'no connection')
        mocks.findGitlabConnection.mockResolvedValue(undefined);
      expect(await listFastAgentIntegrations(auditContext)).toEqual([]);
      expect(mocks.listMcpTools).toHaveBeenCalledOnce();
    },
  );

  it.each(['configuration', 'repository database', 'connection database'])(
    'keeps Roomote and GitHub available when GitLab %s fails',
    async (reason) => {
      mocks.configuredServers = {
        roomote: { url: 'https://api.example.com/mcp', headers: {} },
      };
      mocks.isRouterMcpServerEnabled.mockReturnValue(true);
      mocks.findGithubInstallation.mockResolvedValue({ id: 42 });
      if (reason === 'configuration') {
        mocks.resolveGitLabInstanceHost.mockImplementationOnce(() => {
          throw new Error('Invalid GitLab configuration');
        });
      } else {
        const lookup =
          reason === 'repository database'
            ? mocks.findGitlabRepository
            : mocks.findGitlabConnection;
        lookup.mockRejectedValueOnce(new Error('Database unavailable'));
      }
      const integrations = await listFastAgentIntegrations(auditContext);
      expect(integrations.map(({ id }) => id)).toEqual(['roomote', 'github']);
      expect(mocks.listMcpTools).toHaveBeenCalledTimes(2);
    },
  );

  it('reuses GitLab schemas but preserves call-time actor revocation with fresh auth', async () => {
    mocks.findGitlabRepository.mockResolvedValue({ id: 'repo-1' });
    mocks.findGitlabConnection.mockResolvedValue({
      name: 'gitlab_deployment_oauth_connection',
    });
    await listFastAgentIntegrations(auditContext);
    const integrations = await listFastAgentIntegrations(auditContext);
    expect(mocks.listMcpTools).toHaveBeenCalledOnce();

    mocks.createAuthToken.mockResolvedValueOnce('fresh-revoked-actor-token');
    mocks.callMcpTool.mockRejectedValueOnce(
      new Error('Active member required'),
    );
    await expect(
      callFastAgentIntegration(auditContext, integrations, {
        integrationId: 'gitlab',
        toolName: 'search',
        args: {},
      }),
    ).rejects.toThrow('Active member required');
    expect(mocks.callMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.example.com/api/mcp-routing/gitlab',
        headers: { Authorization: 'Bearer fresh-revoked-actor-token' },
      }),
    );
    expect(mocks.completeIntegrationCall).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'Active member required',
      }),
    );
  });

  it('discovers GitLab and Bitbucket together with independent repository eligibility', async () => {
    mocks.findGitlabRepository.mockResolvedValue({ id: 'repo-1' });
    mocks.findGitlabConnection.mockResolvedValue({
      name: 'gitlab_deployment_oauth_connection',
    });
    mocks.getBitbucketOAuthConnection.mockResolvedValue({ status: 'active' });

    const integrations = await listFastAgentIntegrations(auditContext);
    expect(integrations.map(({ id, endpoint }) => [id, endpoint?.url])).toEqual(
      [
        ['gitlab', 'https://api.example.com/api/mcp-routing/gitlab'],
        ['bitbucket', 'https://api.example.com/api/mcp/bitbucket'],
      ],
    );
    expect(mocks.findGitlabRepository).toHaveBeenCalledOnce();
    expect(mocks.findRepository).toHaveBeenCalledOnce();

    mocks.findGitlabRepository.mockResolvedValue(undefined);
    expect(
      (await listFastAgentIntegrations(auditContext)).map(({ id }) => id),
    ).toEqual(['bitbucket']);

    mocks.findGitlabRepository.mockResolvedValue({ id: 'repo-1' });
    mocks.findRepository.mockResolvedValue(undefined);
    expect(
      (await listFastAgentIntegrations(auditContext)).map(({ id }) => id),
    ).toEqual(['gitlab']);
    expect(mocks.listMcpTools).toHaveBeenCalledTimes(2);
  });

  it.each([null, { status: 'reauthorization_required' }])(
    'omits Bitbucket without an active deployment OAuth connection: %j',
    async (connection) => {
      mocks.getBitbucketOAuthConnection.mockResolvedValue(connection);
      expect(await listFastAgentIntegrations(auditContext)).toEqual([]);
      expect(mocks.listMcpTools).not.toHaveBeenCalled();
      expect(mocks.findMember).not.toHaveBeenCalled();
    },
  );

  it('hides cached Bitbucket tools when curated integrations are disabled', async () => {
    mocks.getBitbucketOAuthConnection.mockResolvedValue({ status: 'active' });
    expect(await listFastAgentIntegrations(auditContext)).toHaveLength(1);
    mocks.env.R_CURATED_INTEGRATIONS_DISABLED = true;
    expect(await listFastAgentIntegrations(auditContext)).toEqual([]);
    expect(mocks.listMcpTools).toHaveBeenCalledOnce();
    expect(mocks.getBitbucketOAuthConnection).toHaveBeenCalledOnce();
  });

  it.each([undefined, { externalRepoId: null }, { externalRepoId: '' }])(
    'omits Bitbucket without an active connected Cloud repository: %j',
    async (repository) => {
      mocks.getBitbucketOAuthConnection.mockResolvedValue({ status: 'active' });
      mocks.findRepository.mockResolvedValue(repository);
      expect(await listFastAgentIntegrations(auditContext)).toEqual([]);
      expect(mocks.listMcpTools).not.toHaveBeenCalled();
      expect(mocks.findRepository).toHaveBeenCalledWith({
        where: [
          ['provider', 'bitbucket'],
          ['host', 'bitbucket.org'],
          ['active', true],
        ],
        columns: { externalRepoId: true },
      });
    },
  );

  it('discovers and calls Bitbucket tools using the configured www Cloud host', async () => {
    mocks.getBitbucketOAuthConnection.mockResolvedValue({ status: 'active' });
    mocks.resolveBitbucketInstanceHost.mockResolvedValue('www.bitbucket.org');
    const available = await listFastAgentIntegrations(auditContext);
    expect(available.map((integration) => integration.id)).toEqual([
      'bitbucket',
    ]);
    expect(mocks.findRepository).toHaveBeenCalledWith({
      where: [
        ['provider', 'bitbucket'],
        ['host', 'www.bitbucket.org'],
        ['active', true],
      ],
      columns: { externalRepoId: true },
    });
    mocks.callMcpTool.mockResolvedValue({ result: 'contents' });
    await expect(
      callFastAgentIntegration(auditContext, available, {
        integrationId: 'bitbucket',
        toolName: 'search',
        args: {},
      }),
    ).resolves.toEqual({ result: 'contents' });
  });

  it('omits Bitbucket when no repository matches the configured www host', async () => {
    mocks.getBitbucketOAuthConnection.mockResolvedValue({ status: 'active' });
    mocks.resolveBitbucketInstanceHost.mockResolvedValue('www.bitbucket.org');
    mocks.findRepository.mockResolvedValue(undefined);
    expect(await listFastAgentIntegrations(auditContext)).toEqual([]);
    expect(mocks.findRepository).toHaveBeenCalledWith({
      where: [
        ['provider', 'bitbucket'],
        ['host', 'www.bitbucket.org'],
        ['active', true],
      ],
      columns: { externalRepoId: true },
    });
    expect(mocks.listMcpTools).not.toHaveBeenCalled();
  });

  it.each(['bitbucket.example.com', 'bitbucket.org.evil.test'])(
    'omits Bitbucket for non-Cloud configured host %s before repository lookup',
    async (host) => {
      mocks.getBitbucketOAuthConnection.mockResolvedValue({ status: 'active' });
      mocks.resolveBitbucketInstanceHost.mockResolvedValue(host);
      expect(await listFastAgentIntegrations(auditContext)).toEqual([]);
      expect(mocks.findRepository).not.toHaveBeenCalled();
      expect(mocks.listMcpTools).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, { role: 'guest' }])(
    'hides a cached Bitbucket catalog when current membership is revoked: %j',
    async (member) => {
      mocks.getBitbucketOAuthConnection.mockResolvedValue({ status: 'active' });
      expect(await listFastAgentIntegrations(auditContext)).toHaveLength(1);
      mocks.findMember.mockResolvedValue(member);
      expect(await listFastAgentIntegrations(auditContext)).toEqual([]);
      expect(mocks.listMcpTools).toHaveBeenCalledOnce();
      expect(mocks.findMember).toHaveBeenLastCalledWith({
        where: [['user-id', 'user-1'], 'not-suspended-filter'],
        columns: { role: true },
      });
    },
  );

  it.each(['admin', 'member'])(
    'dispatches discovered Bitbucket tools as a %s with fresh Roomote auth and an audit',
    async (role) => {
      mocks.getBitbucketOAuthConnection.mockResolvedValue({
        status: 'active',
        accessToken: 'never-forward-upstream-token',
      });
      mocks.findMember.mockResolvedValue({ role });
      const inputSchema = {
        type: 'object',
        additionalProperties: false,
        properties: {
          repositoryFullName: { type: 'string' },
          pullRequestNumber: { type: 'integer' },
          body: { type: 'string' },
          parentCommentId: { type: 'integer' },
        },
        required: ['repositoryFullName', 'pullRequestNumber', 'body'],
      };
      mocks.listMcpTools.mockResolvedValue([
        { name: 'add_pull_request_comment', inputSchema },
      ]);
      mocks.createAuthToken
        .mockResolvedValueOnce('discovery-token')
        .mockResolvedValueOnce('fresh-call-token');
      const available = await listFastAgentIntegrations(auditContext);
      const { tools } = matchIntegrationTools(
        available.flatMap((integration) =>
          integration.tools.map((tool) => ({
            ...tool,
            integrationId: integration.id,
          })),
        ),
        { integrationId: 'bitbucket', toolName: 'add_pull_request_comment' },
      );
      expect(tools[0]?.inputSchema).toEqual(inputSchema);
      expect(mocks.listMcpTools).toHaveBeenCalledWith({
        url: 'https://api.example.com/api/mcp/bitbucket',
        headers: { Authorization: 'Bearer discovery-token' },
        signal: expect.any(AbortSignal),
      });
      const args = {
        repositoryFullName: 'acme/repo',
        pullRequestNumber: 12,
        body: 'Reply',
        parentCommentId: 4,
      };
      mocks.callMcpTool.mockResolvedValue({ result: { id: 5 } });
      await expect(
        callFastAgentIntegration(auditContext, available, {
          integrationId: 'bitbucket',
          toolName: 'add_pull_request_comment',
          args,
        }),
      ).resolves.toEqual({ result: { id: 5 } });
      expect(mocks.callMcpTool).toHaveBeenCalledWith({
        url: 'https://api.example.com/api/mcp/bitbucket',
        headers: { Authorization: 'Bearer fresh-call-token' },
        toolName: 'add_pull_request_comment',
        args,
        toolCallId: 'fast:audit-1:bitbucket:add_pull_request_comment',
        signal: expect.any(AbortSignal),
      });
      expect(mocks.createAuthToken).toHaveBeenLastCalledWith({
        userId: 'user-1',
        timeoutMs: 120_000,
      });
      expect(mocks.beginIntegrationCall).toHaveBeenCalledWith(
        expect.objectContaining({
          integrationId: 'bitbucket',
          toolName: 'add_pull_request_comment',
          arguments: args,
          userId: 'user-1',
        }),
      );
      expect(mocks.completeIntegrationCall).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'audit-1', status: 'succeeded' }),
      );
      await expect(
        callFastAgentIntegration(auditContext, available, {
          integrationId: 'bitbucket',
          toolName: 'merge_pull_request',
          args,
        }),
      ).rejects.toThrow('not available');
      expect(mocks.callMcpTool).toHaveBeenCalledOnce();
    },
  );

  it('keeps endpoint authorization authoritative for a previously discovered Bitbucket tool', async () => {
    mocks.getBitbucketOAuthConnection.mockResolvedValue({ status: 'active' });
    const available = await listFastAgentIntegrations(auditContext);
    mocks.callMcpTool.mockRejectedValue(
      new Error('Current deployment membership required'),
    );
    await expect(
      callFastAgentIntegration(auditContext, available, {
        integrationId: 'bitbucket',
        toolName: 'search',
        args: {},
      }),
    ).rejects.toThrow('Current deployment membership required');
    expect(mocks.completeIntegrationCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it.each([
    {
      name: 'update_pull_request',
      args: {
        owner: 'example',
        repo: 'repo',
        pullNumber: 42,
        reviewers: ['octocat'],
        base: 'develop',
        draft: false,
        maintainer_can_modify: true,
      },
    },
    {
      name: 'add_issue_comment',
      args: {
        owner: 'example',
        repo: 'repo',
        issue_number: 42,
        comment_id: 123,
        reaction: '+1',
      },
    },
    {
      name: 'add_reply_to_pull_request_comment',
      args: { owner: 'example', repo: 'repo', commentId: 456, reaction: '+1' },
    },
  ])(
    'preserves discovered $name descriptions, schemas, and arguments',
    async ({ name, args }) => {
      mocks.isRouterMcpServerEnabled.mockReturnValue(true);
      mocks.findGithubInstallation.mockResolvedValue({ id: 42 });
      const nativeTool = {
        name,
        description: `Native ${name} description`,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            Object.keys(args).map((key) => [key, { description: key }]),
          ),
          required: ['owner', 'repo'],
        },
      };
      mocks.listMcpTools.mockResolvedValue([nativeTool]);
      mocks.callMcpTool.mockResolvedValue({ success: true });
      const integrations = await listFastAgentIntegrations(auditContext);
      expect(integrations[0]?.tools).toEqual([nativeTool]);
      await callFastAgentIntegration(auditContext, integrations, {
        integrationId: 'github',
        toolName: name,
        args,
      });
      expect(mocks.callMcpTool).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: name, args }),
      );
    },
  );

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
      { name: 'create_custom_skill', inputSchema: { type: 'object' } },
    ]);

    const integrations = await listFastAgentIntegrations({
      userId: 'user-1',
      apiBaseUrl: 'https://app.example.test/_roomote-api',
    });

    expect(integrations[0]?.tools).toEqual([
      { name: 'manage_custom_automations', inputSchema: { type: 'object' } },
      { name: 'create_custom_skill', inputSchema: { type: 'object' } },
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

  it('rediscovers tools when the persisted integration revision changes', async () => {
    mocks.configuredServers = {
      notion: {
        url: 'https://api.example.com/api/mcp/notion',
        headers: {},
        cacheRevision: '1',
      },
    };

    await listFastAgentIntegrations(auditContext);
    mocks.configuredServers.notion!.cacheRevision = '2';
    await listFastAgentIntegrations(auditContext);

    expect(mocks.listMcpTools).toHaveBeenCalledTimes(2);
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

  it.each([
    'allowed',
    'denied POST',
    'revoked permission',
    'protocol failure',
    'transport failure',
  ])(
    'audits a real MCP %s call without a false succeeded record',
    async (scenario) => {
      const { callMcpTool, McpToolCallError } = await vi.importActual<
        typeof import('../../mcp-tool-client')
      >('../../mcp-tool-client');
      mocks.callMcpTool.mockImplementation(callMcpTool);
      const call = vi.fn(() => {
        if (scenario === 'protocol failure') {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid tool arguments');
        }
        return scenario === 'allowed'
          ? { content: [], structuredContent: { ok: true } }
          : {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `${scenario}: synthetic-secret`,
                },
              ],
            };
      });
      const endpoint = await startMcpToolTestServer(call, {
        httpFailure: scenario === 'transport failure',
      });
      try {
        const result = callFastAgentIntegration(
          auditContext,
          [
            {
              id: '_roomote_http_integrations',
              name: 'HTTP integrations',
              description: 'HTTP',
              tools: [{ name: 'integration_request' }],
              endpoint: { url: endpoint.url, headers: {} },
            },
          ],
          {
            integrationId: '_roomote_http_integrations',
            toolName: 'integration_request',
            args: { method: scenario === 'denied POST' ? 'POST' : 'GET' },
          },
        );
        if (scenario === 'allowed') {
          await expect(result).resolves.toEqual({ ok: true });
        } else if (
          scenario === 'denied POST' ||
          scenario === 'revoked permission'
        ) {
          await expect(result).rejects.toBeInstanceOf(McpToolCallError);
        } else {
          await expect(result).rejects.toThrow(
            scenario === 'protocol failure' ? 'Invalid tool arguments' : '503',
          );
        }
        expect(mocks.beginIntegrationCall).toHaveBeenCalledOnce();
        expect(mocks.completeIntegrationCall).toHaveBeenCalledExactlyOnceWith({
          id: 'audit-1',
          status: scenario === 'allowed' ? 'succeeded' : 'failed',
          ...(scenario === 'allowed'
            ? { resultPreview: '[Broker result omitted]' }
            : {
                error:
                  scenario === 'denied POST' ||
                  scenario === 'revoked permission'
                    ? 'McpToolCallError | MCP tool reported an error (isError: true).'
                    : expect.any(String),
              }),
          startedAt: new Date('2026-08-16T00:00:00.000Z'),
        });
        expect(
          JSON.stringify(mocks.completeIntegrationCall.mock.calls),
        ).not.toContain('synthetic-secret');
        if (scenario !== 'transport failure')
          expect(call).toHaveBeenCalledOnce();
      } finally {
        mocks.callMcpTool.mockReset();
        await endpoint.close();
      }
    },
  );

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
