import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

const mockEnv = vi.hoisted(() => ({
  R_CURATED_INTEGRATIONS_DISABLED: false,
  R_CUSTOM_MCP_DISABLED: false,
}));

vi.mock('@roomote/env', () => ({
  Env: mockEnv,
  areCuratedIntegrationsDisabled: (value: boolean | undefined) =>
    value === true,
  isCustomMcpDisabled: (value: boolean | undefined) => value === true,
}));

const {
  mockFindTaskRun,
  mockFindEnablements,
  mockFindConnections,
  mockSelect,
  mockFrom,
  mockLeftJoin,
  mockWhere,
  mockOrderBy,
  mockGetValidAccessToken,
  mockEq,
  mockAnd,
  mockOr,
  mockIsNull,
  mockInArray,
  mockDesc,
  mockFindCustomServers,
  mockFindConnectionFirst,
} = vi.hoisted(() => {
  const mockOrderBy = vi.fn();
  const mockWhere = vi.fn(() => ({
    orderBy: mockOrderBy,
  }));
  const mockLeftJoin = vi.fn(() => ({
    where: mockWhere,
  }));
  const mockFrom = vi.fn(() => ({
    leftJoin: mockLeftJoin,
  }));
  const mockSelect = vi.fn(() => ({
    from: mockFrom,
  }));

  return {
    mockFindTaskRun: vi.fn(),
    mockFindEnablements: vi.fn(),
    mockFindConnections: vi.fn(),
    mockSelect,
    mockFrom,
    mockLeftJoin,
    mockWhere,
    mockOrderBy,
    mockGetValidAccessToken: vi.fn(),
    mockEq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
    mockAnd: vi.fn((...conditions: unknown[]) => ({ conditions })),
    mockOr: vi.fn((...conditions: unknown[]) => ({
      type: 'or',
      conditions,
    })),
    mockIsNull: vi.fn((column: unknown) => ({ type: 'isNull', column })),
    mockInArray: vi.fn((column: unknown, values: unknown[]) => ({
      type: 'inArray',
      column,
      values,
    })),
    mockDesc: vi.fn((column: unknown) => ({ type: 'desc', column })),
    mockFindCustomServers: vi.fn<(...args: unknown[]) => Promise<unknown>>(
      async () => [],
    ),
    mockFindConnectionFirst: vi.fn<(...args: unknown[]) => Promise<unknown>>(
      async () => undefined,
    ),
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {
    select: mockSelect,
    query: {
      taskRuns: { findFirst: mockFindTaskRun },
      deploymentMcpEnablements: {
        findFirst: vi.fn(),
        findMany: mockFindEnablements,
      },
      mcpConnections: {
        findMany: mockFindConnections,
        findFirst: mockFindConnectionFirst,
      },
      customMcpServers: {
        findMany: mockFindCustomServers,
        findFirst: vi.fn(),
      },
    },
  },
  customMcpServers: {
    id: 'customServer.id',
    name: 'customServer.name',
    enabled: 'customServer.enabled',
    stdio: 'customServer.stdio',
  },
  mcpConnections: {
    id: 'connection.id',
    userId: 'connection.userId',
    mcpId: 'connection.mcpId',
    enabled: 'connection.enabled',
    createdAt: 'connection.createdAt',
  },
  taskRuns: {
    id: 'taskRun.id',
  },
  deploymentMcpEnablements: {
    mcpId: 'enablement.mcpId',
    enabled: 'enablement.enabled',
  },
  desc: mockDesc,
  eq: mockEq,
  and: mockAnd,
  or: mockOr,
  isNull: mockIsNull,
  isNotNull: vi.fn((column: unknown) => ({ type: 'isNotNull', column })),
  inArray: mockInArray,
}));

vi.mock('@roomote/db/encryption', () => ({
  encrypt: vi.fn((value: string) => `enc(${value})`),
  decrypt: vi.fn((value: string) => value.replace(/^enc\(|\)$/g, '')),
  decryptText: vi.fn((value: string) => value),
}));

vi.mock('../lib/mcp/data', () => ({
  getValidAccessToken: mockGetValidAccessToken,
  hasValidOAuthTokens: vi.fn(),
}));

import { getValidAccessToken } from '../lib/mcp/data';
import { mcpConnectionsRouter } from './mcp-connections';

const consoleInfoSpy = vi
  .spyOn(console, 'info')
  .mockImplementation(() => undefined);
const consoleWarnSpy = vi
  .spyOn(console, 'warn')
  .mockImplementation(() => undefined);
const consoleErrorSpy = vi
  .spyOn(console, 'error')
  .mockImplementation(() => undefined);

function createCaller(requestUrl?: string) {
  const auth: AuthTokenContext = {
    userId: 'user-1',
    tokenType: 'auth',
    version: 1,
  };

  return mcpConnectionsRouter.createCaller({
    auth,
    req: requestUrl ? ({ url: requestUrl } as Request) : undefined,
  });
}

function createJobCaller(requestUrl?: string) {
  const auth: RunTokenContext = {
    runId: 42,
    userId: 'owner-user',
    principal: 'user',
    tokenType: 'run',
    version: 1,
  };

  return mcpConnectionsRouter.createCaller({
    auth,
    req: requestUrl ? ({ url: requestUrl } as Request) : undefined,
  });
}

function buildJoinedConnectionRow({
  id = 'conn-1',
  userId = 'user-1',
  mcpId = 'notion',
  authConfig = {
    type: 'oauth_client',
    client_id: 'client-id',
    registered_redirect_uri: 'https://example.com/callback',
  },
}: {
  id?: string;
  userId?: string | null;
  mcpId?: string;
  authConfig?: Record<string, unknown>;
} = {}) {
  return {
    enabledMcpId: mcpId,
    connection: {
      id,
      userId,
      mcpId,
      enabled: true,
      authConfig,
      createdAt: new Date('2026-03-12T00:00:00.000Z'),
    },
  };
}

function buildEnabledOnlyRow(mcpId: string) {
  return {
    enabledMcpId: mcpId,
    connection: null,
  };
}

describe('mcpConnectionsRouter.getMcpServerConfigs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.R_CURATED_INTEGRATIONS_DISABLED = false;
    mockFindTaskRun.mockResolvedValue({
      actingUserId: null,
    });
    mockFindEnablements.mockResolvedValue([]);
    mockFindConnections.mockResolvedValue([]);
    mockOrderBy.mockResolvedValue([buildJoinedConnectionRow()]);
  });

  it('returns no curated servers when the operator disables integrations', async () => {
    mockEnv.R_CURATED_INTEGRATIONS_DISABLED = true;

    const result = await createCaller().getMcpServerConfigs();

    expect(result).toEqual({ servers: {} });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGetValidAccessToken).not.toHaveBeenCalled();
  });

  it('returns Notion proxy config without raw OAuth bearer token', async () => {
    mockGetValidAccessToken.mockResolvedValue('notion-raw-access-token');

    const result = await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    expect(getValidAccessToken).toHaveBeenCalledWith(
      'conn-1',
      'https://mcp.notion.com/mcp',
    );

    expect(result).toEqual({
      servers: {
        notion: {
          url: 'https://api.preview.roomote.run/api/mcp/notion',
          headers: {
            'X-MCP-Client': 'Roomote',
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('notion-raw-access-token');
  });

  it.each([
    {
      mcpId: 'pylon',
      connectionId: 'conn-pylon',
      accessToken: 'pylon-raw-access-token',
      upstreamUrl: 'https://mcp.usepylon.com',
    },
    {
      mcpId: 'betterstack',
      connectionId: 'conn-5',
      accessToken: 'betterstack-raw-access-token',
      upstreamUrl: 'https://mcp.betterstack.com',
    },
    {
      mcpId: 'railway',
      connectionId: 'conn-7',
      accessToken: 'railway-raw-access-token',
      upstreamUrl: 'https://mcp.railway.com',
    },
  ])(
    'returns $mcpId proxy config without raw OAuth bearer token',
    async ({ mcpId, connectionId, accessToken, upstreamUrl }) => {
      mockOrderBy.mockResolvedValue([
        buildJoinedConnectionRow({
          id: connectionId,
          userId: null,
          mcpId,
        }),
      ]);
      mockGetValidAccessToken.mockResolvedValue(accessToken);

      const result = await createCaller(
        'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
      ).getMcpServerConfigs();

      expect(getValidAccessToken).toHaveBeenCalledWith(
        connectionId,
        upstreamUrl,
      );

      expect(result).toEqual({
        servers: {
          [mcpId]: {
            url: `https://api.preview.roomote.run/api/mcp/${mcpId}`,
            headers: {
              'X-MCP-Client': 'Roomote',
            },
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain(accessToken);
    },
  );

  it('uses a single joined query so PostHog enablement and connection resolution share one snapshot', async () => {
    mockOrderBy.mockResolvedValue([
      buildJoinedConnectionRow({
        id: 'conn-posthog',
        userId: null,
        mcpId: 'posthog',
      }),
    ]);
    mockGetValidAccessToken.mockResolvedValue('posthog-raw-access-token');

    const result = await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    expect(result).toEqual({
      servers: {
        posthog: {
          url: 'https://api.preview.roomote.run/api/mcp/posthog',
          headers: {
            'X-MCP-Client': 'Roomote',
          },
        },
      },
    });
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockLeftJoin).toHaveBeenCalledTimes(1);
    expect(mockWhere).toHaveBeenCalledTimes(1);
    expect(mockOrderBy).toHaveBeenCalledTimes(1);
    expect(mockFindEnablements).not.toHaveBeenCalled();
    expect(mockFindConnections).not.toHaveBeenCalled();
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      '[getMcpServerConfigs] Enabled MCP IDs found:',
      ['posthog'],
    );
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      '[getMcpServerConfigs] Final resolved server keys:',
      ['posthog'],
    );
    expect(JSON.stringify(result)).not.toContain('posthog-raw-access-token');
  });

  it('returns Snowflake proxy config without requesting OAuth tokens', async () => {
    mockOrderBy.mockResolvedValue([
      buildJoinedConnectionRow({
        id: 'conn-snowflake',
        userId: null,
        mcpId: 'snowflake',
        authConfig: {
          type: 'snowflake',
          account: 'xy12345.us-east-1',
          username: 'roomote',
          role: 'ANALYST',
          warehouse: 'ROOMOTE_WH',
          encryptedPassword: 'enc:secret',
        },
      }),
    ]);

    const result = await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    expect(getValidAccessToken).not.toHaveBeenCalled();
    expect(result).toEqual({
      servers: {
        snowflake: {
          url: 'https://api.preview.roomote.run/api/mcp/snowflake',
          headers: {
            'X-MCP-Client': 'Roomote',
          },
        },
      },
    });
  });

  it('returns Asana proxy config without requesting OAuth tokens', async () => {
    mockOrderBy.mockResolvedValue([
      buildJoinedConnectionRow({
        id: 'conn-asana',
        userId: null,
        mcpId: 'asana',
        authConfig: {
          type: 'asana',
          encryptedToken: 'enc:secret',
        },
      }),
    ]);

    const result = await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    expect(getValidAccessToken).not.toHaveBeenCalled();
    expect(result).toEqual({
      servers: {
        asana: {
          url: 'https://api.preview.roomote.run/api/mcp/asana',
          headers: {
            'X-MCP-Client': 'Roomote',
          },
        },
      },
    });
  });

  it('returns Grafana proxy config without requesting OAuth tokens', async () => {
    mockOrderBy.mockResolvedValue([
      buildJoinedConnectionRow({
        id: 'conn-grafana',
        userId: null,
        mcpId: 'grafana',
        authConfig: {
          type: 'grafana',
          baseUrl: 'https://acme.grafana.net',
          encryptedServiceAccountToken: 'enc:secret',
        },
      }),
    ]);

    const result = await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    expect(getValidAccessToken).not.toHaveBeenCalled();
    expect(result).toEqual({
      servers: {
        grafana: {
          url: 'https://api.preview.roomote.run/api/mcp/grafana',
          headers: {
            'X-MCP-Client': 'Roomote',
          },
        },
      },
    });
  });

  it('returns Granola proxy config without exposing the API key', async () => {
    mockOrderBy.mockResolvedValue([
      buildJoinedConnectionRow({
        id: 'conn-granola',
        userId: null,
        mcpId: 'granola',
        authConfig: {
          type: 'granola',
          encryptedApiKey: 'enc:secret',
        },
      }),
    ]);

    const result = await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    expect(getValidAccessToken).not.toHaveBeenCalled();
    expect(result).toEqual({
      servers: {
        granola: {
          url: 'https://api.preview.roomote.run/api/mcp/granola',
          headers: {
            'X-MCP-Client': 'Roomote',
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('enc:secret');
  });

  it('never delivers a credential-only ElevenLabs connection to agents', async () => {
    mockOrderBy.mockResolvedValue([
      buildJoinedConnectionRow({
        id: 'conn-elevenlabs',
        userId: null,
        mcpId: 'elevenlabs',
        authConfig: {
          type: 'elevenlabs',
          encryptedApiKey: 'enc:secret',
          voiceId: 'v1',
        },
      }),
    ]);

    const result = await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    // Credential-only: no MCP server, and the secret never leaves the
    // control plane toward a task sandbox.
    expect(result).toEqual({ servers: {} });
    expect(JSON.stringify(result)).not.toContain('enc:secret');
    expect(JSON.stringify(result)).not.toContain('v1');
  });

  it('returns Vercel proxy config without requesting OAuth tokens', async () => {
    mockOrderBy.mockResolvedValue([
      buildJoinedConnectionRow({
        id: 'conn-vercel',
        userId: null,
        mcpId: 'vercel',
        authConfig: {
          type: 'vercel',
          encryptedAccessToken: 'enc:secret',
          defaultTeamIdOrSlug: 'acme-team',
        },
      }),
    ]);

    const result = await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    expect(getValidAccessToken).not.toHaveBeenCalled();
    expect(result).toEqual({
      servers: {
        vercel: {
          url: 'https://api.preview.roomote.run/api/mcp/vercel',
          headers: {
            'X-MCP-Client': 'Roomote',
          },
        },
      },
    });
  });

  it('returns Neon proxy config without raw OAuth bearer token', async () => {
    mockOrderBy.mockResolvedValue([
      buildJoinedConnectionRow({
        id: 'conn-3',
        userId: 'user-1',
        mcpId: 'neon',
      }),
    ]);
    mockGetValidAccessToken.mockResolvedValue('neon-raw-access-token');

    const result = await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    expect(getValidAccessToken).toHaveBeenCalledWith(
      'conn-3',
      'https://mcp.neon.tech/mcp',
    );

    expect(result).toEqual({
      servers: {
        neon: {
          url: 'https://api.preview.roomote.run/api/mcp/neon',
          headers: {
            'X-MCP-Client': 'Roomote',
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('neon-raw-access-token');
  });

  it('returns Jira proxy config without raw OAuth bearer token', async () => {
    mockOrderBy.mockResolvedValue([
      buildJoinedConnectionRow({
        id: 'conn-jira',
        userId: null,
        mcpId: 'jira',
      }),
    ]);
    mockGetValidAccessToken.mockResolvedValue('jira-raw-access-token');

    const result = await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    expect(getValidAccessToken).toHaveBeenCalledWith(
      'conn-jira',
      'https://mcp.atlassian.com/v1/mcp/authv2',
    );

    expect(result).toEqual({
      servers: {
        jira: {
          url: 'https://api.preview.roomote.run/api/mcp/jira',
          headers: {
            'X-MCP-Client': 'Roomote',
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('jira-raw-access-token');
  });

  it('returns Supabase proxy config without raw OAuth bearer token', async () => {
    mockOrderBy.mockResolvedValue([
      buildJoinedConnectionRow({
        id: 'conn-4',
        userId: 'user-1',
        mcpId: 'supabase',
      }),
    ]);
    mockGetValidAccessToken.mockResolvedValue('supabase-raw-access-token');

    const result = await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    expect(getValidAccessToken).toHaveBeenCalledWith(
      'conn-4',
      'https://mcp.supabase.com/mcp?read_only=true&features=database',
    );

    expect(result).toEqual({
      servers: {
        supabase: {
          url: 'https://api.preview.roomote.run/api/mcp/supabase',
          headers: {
            'X-MCP-Client': 'Roomote',
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('supabase-raw-access-token');
  });

  it('falls back to a proxy path when request origin is unavailable', async () => {
    mockGetValidAccessToken.mockResolvedValue('notion-raw-access-token');

    const result = await createCaller().getMcpServerConfigs();

    expect(result).toEqual({
      servers: {
        notion: {
          url: '/api/mcp/notion',
          headers: {
            'X-MCP-Client': 'Roomote',
          },
        },
      },
    });
  });

  it('skips enabled MCPs that do not have a matching connection row', async () => {
    mockOrderBy.mockResolvedValue([
      buildEnabledOnlyRow('posthog'),
      buildJoinedConnectionRow(),
    ]);
    mockGetValidAccessToken.mockResolvedValue('notion-raw-access-token');

    const result = await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    expect(result).toEqual({
      servers: {
        notion: {
          url: 'https://api.preview.roomote.run/api/mcp/notion',
          headers: {
            'X-MCP-Client': 'Roomote',
          },
        },
      },
    });
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      '[getMcpServerConfigs] Enabled MCP IDs found:',
      ['posthog', 'notion'],
    );
  });

  it('skips Notion connections when no valid token can be resolved', async () => {
    mockGetValidAccessToken.mockResolvedValue(undefined);

    const result = await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    expect(result).toEqual({ servers: {} });
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[getMcpServerConfigs] No tokens found for connection conn-1, skipping',
    );
  });

  it('uses taskRuns.actingUserId for run-token actor-scoped lookups', async () => {
    mockFindTaskRun.mockResolvedValueOnce({
      actingUserId: 'actor-user',
    });
    mockGetValidAccessToken.mockResolvedValue('notion-raw-access-token');

    await createJobCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    const joinCondition = (mockLeftJoin.mock.calls as unknown[][])[0]?.[1];

    expect(joinCondition).toEqual(
      expect.objectContaining({
        conditions: expect.arrayContaining([
          { column: 'connection.mcpId', value: 'enablement.mcpId' },
          { column: 'connection.enabled', value: true },
          expect.objectContaining({
            type: 'or',
            conditions: expect.arrayContaining([
              expect.objectContaining({
                conditions: expect.arrayContaining([
                  { column: 'connection.userId', value: 'actor-user' },
                  expect.objectContaining({
                    type: 'inArray',
                    column: 'connection.mcpId',
                    values: expect.arrayContaining(['notion']),
                  }),
                ]),
              }),
            ]),
          }),
        ]),
      }),
    );
  });

  it('builds deployment-scoped visibility filters against connection rows for Snowflake', async () => {
    mockOrderBy.mockResolvedValue([
      buildJoinedConnectionRow({
        id: 'conn-snowflake',
        userId: null,
        mcpId: 'snowflake',
        authConfig: {
          type: 'snowflake',
          account: 'xy12345.us-east-1',
          username: 'roomote',
          role: 'ANALYST',
          encryptedPassword: 'enc:secret',
        },
      }),
    ]);

    await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    const joinCondition = (mockLeftJoin.mock.calls as unknown[][])[0]?.[1];

    expect(joinCondition).toEqual(
      expect.objectContaining({
        conditions: expect.arrayContaining([
          expect.objectContaining({
            type: 'or',
            conditions: expect.arrayContaining([
              expect.objectContaining({
                conditions: expect.arrayContaining([
                  { type: 'isNull', column: 'connection.userId' },
                  expect.objectContaining({
                    type: 'inArray',
                    column: 'connection.mcpId',
                    values: expect.arrayContaining(['snowflake']),
                  }),
                ]),
              }),
            ]),
          }),
        ]),
      }),
    );
  });

  it('builds deployment-scoped visibility filters against connection rows for Asana', async () => {
    mockOrderBy.mockResolvedValue([
      buildJoinedConnectionRow({
        id: 'conn-asana',
        userId: null,
        mcpId: 'asana',
        authConfig: {
          type: 'asana',
          encryptedToken: 'enc:secret',
        },
      }),
    ]);

    await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    const joinCondition = (mockLeftJoin.mock.calls as unknown[][])[0]?.[1];

    expect(joinCondition).toEqual(
      expect.objectContaining({
        conditions: expect.arrayContaining([
          expect.objectContaining({
            type: 'or',
            conditions: expect.arrayContaining([
              expect.objectContaining({
                conditions: expect.arrayContaining([
                  { type: 'isNull', column: 'connection.userId' },
                  expect.objectContaining({
                    type: 'inArray',
                    column: 'connection.mcpId',
                    values: expect.arrayContaining(['asana']),
                  }),
                ]),
              }),
            ]),
          }),
        ]),
      }),
    );
  });

  it('builds organization-scoped visibility filters against connection rows for Grafana', async () => {
    mockOrderBy.mockResolvedValue([
      buildJoinedConnectionRow({
        id: 'conn-grafana',
        userId: null,
        mcpId: 'grafana',
        authConfig: {
          type: 'grafana',
          baseUrl: 'https://acme.grafana.net',
          encryptedServiceAccountToken: 'enc:secret',
        },
      }),
    ]);

    await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    const joinCondition = (mockLeftJoin.mock.calls as unknown[][])[0]?.[1];

    expect(joinCondition).toEqual(
      expect.objectContaining({
        conditions: expect.arrayContaining([
          expect.objectContaining({
            type: 'or',
            conditions: expect.arrayContaining([
              expect.objectContaining({
                conditions: expect.arrayContaining([
                  { type: 'isNull', column: 'connection.userId' },
                  expect.objectContaining({
                    type: 'inArray',
                    column: 'connection.mcpId',
                    values: expect.arrayContaining(['grafana']),
                  }),
                ]),
              }),
            ]),
          }),
        ]),
      }),
    );
  });

  it('builds organization-scoped visibility filters against connection rows for Vercel', async () => {
    mockOrderBy.mockResolvedValue([
      buildJoinedConnectionRow({
        id: 'conn-vercel',
        userId: null,
        mcpId: 'vercel',
        authConfig: {
          type: 'vercel',
          encryptedAccessToken: 'enc:secret',
        },
      }),
    ]);

    await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    const joinCondition = (mockLeftJoin.mock.calls as unknown[][])[0]?.[1];

    expect(joinCondition).toEqual(
      expect.objectContaining({
        conditions: expect.arrayContaining([
          expect.objectContaining({
            type: 'or',
            conditions: expect.arrayContaining([
              expect.objectContaining({
                conditions: expect.arrayContaining([
                  { type: 'isNull', column: 'connection.userId' },
                  expect.objectContaining({
                    type: 'inArray',
                    column: 'connection.mcpId',
                    values: expect.arrayContaining(['vercel']),
                  }),
                ]),
              }),
            ]),
          }),
        ]),
      }),
    );
  });

  it('does not log build failures during the happy path', async () => {
    mockGetValidAccessToken.mockResolvedValue('notion-raw-access-token');

    await createCaller(
      'https://api.preview.roomote.run/trpc/mcpConnections.getMcpServerConfigs',
    ).getMcpServerConfigs();

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

describe('custom MCP server delivery', () => {
  beforeEach(() => {
    mockFindCustomServers.mockReset();
    mockFindCustomServers.mockResolvedValue([]);
    mockFindConnectionFirst.mockReset();
    mockFindConnectionFirst.mockResolvedValue(undefined);
    mockEnv.R_CURATED_INTEGRATIONS_DISABLED = false;
    mockEnv.R_CUSTOM_MCP_DISABLED = false;
  });

  const remoteRow = {
    id: 'server-uuid-1',
    name: 'internal-tools',
    url: 'https://mcp.internal.example/mcp',
    authType: 'static_headers',
    stdio: null,
    enabled: true,
  };

  it('delivers custom proxy entries even when curated integrations are disabled', async () => {
    mockEnv.R_CURATED_INTEGRATIONS_DISABLED = true;
    mockFindCustomServers.mockResolvedValue([remoteRow]);

    const result = await createJobCaller(
      'https://app.example.com/api/trpc/x',
    ).getMcpServerConfigs();

    expect(result.servers['internal-tools']).toEqual({
      url: 'https://app.example.com/api/mcp/custom/server-uuid-1',
      headers: { 'X-MCP-Client': 'Roomote' },
    });
    // The upstream URL and static headers never appear in the response.
    expect(JSON.stringify(result)).not.toContain('mcp.internal.example');
  });

  it('honors the custom kill switch independently of the curated flag', async () => {
    mockEnv.R_CUSTOM_MCP_DISABLED = true;
    mockFindCustomServers.mockResolvedValue([remoteRow]);
    mockFindEnablements.mockResolvedValue([]);
    mockOrderBy.mockResolvedValue([]);

    const result = await createJobCaller(
      'https://app.example.com/api/trpc/x',
    ).getMcpServerConfigs();

    expect(result.servers['internal-tools']).toBeUndefined();
  });

  it('skips oauth custom servers without an authenticated connection', async () => {
    mockFindCustomServers.mockResolvedValue([
      { ...remoteRow, authType: 'oauth' },
    ]);
    mockFindEnablements.mockResolvedValue([]);
    mockOrderBy.mockResolvedValue([]);
    mockFindConnectionFirst.mockResolvedValue({ authStatus: 'pending' });

    const result = await createJobCaller(
      'https://app.example.com/api/trpc/x',
    ).getMcpServerConfigs();

    expect(result.servers['internal-tools']).toBeUndefined();
  });

  it('includes oauth custom servers once authenticated', async () => {
    mockFindCustomServers.mockResolvedValue([
      { ...remoteRow, authType: 'oauth' },
    ]);
    mockFindEnablements.mockResolvedValue([]);
    mockOrderBy.mockResolvedValue([]);
    mockFindConnectionFirst.mockResolvedValue({ authStatus: 'authenticated' });

    const result = await createJobCaller(
      'https://app.example.com/api/trpc/x',
    ).getMcpServerConfigs();

    expect(result.servers['internal-tools']?.url).toBe(
      'https://app.example.com/api/mcp/custom/server-uuid-1',
    );
  });

  it('excludes stdio rows from remote delivery', async () => {
    mockFindCustomServers.mockResolvedValue([
      {
        ...remoteRow,
        url: null,
        stdio: { command: 'npx', env: { TOKEN: 'enc(sec)' } },
      },
    ]);
    mockFindEnablements.mockResolvedValue([]);
    mockOrderBy.mockResolvedValue([]);

    const result = await createJobCaller(
      'https://app.example.com/api/trpc/x',
    ).getMcpServerConfigs();

    expect(Object.keys(result.servers)).toHaveLength(0);
  });
});

describe('getCustomStdioMcpServers', () => {
  beforeEach(() => {
    mockFindCustomServers.mockReset();
    mockFindCustomServers.mockResolvedValue([]);
    mockEnv.R_CUSTOM_MCP_DISABLED = false;
  });

  it('rejects plain auth tokens', async () => {
    await expect(
      createCaller().getCustomStdioMcpServers(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns decrypted stdio env values to run tokens', async () => {
    mockFindCustomServers.mockResolvedValue([
      {
        id: 'server-uuid-2',
        name: 'local-tools',
        url: null,
        authType: 'none',
        stdio: {
          command: 'npx',
          args: ['-y', '@example/server'],
          env: { EXAMPLE_TOKEN: 'enc(stdio-secret)' },
        },
        enabled: true,
      },
    ]);

    const result = await createJobCaller().getCustomStdioMcpServers();

    expect(result.servers['local-tools']).toEqual({
      command: 'npx',
      args: ['-y', '@example/server'],
      env: { EXAMPLE_TOKEN: 'stdio-secret' },
    });
  });
});
