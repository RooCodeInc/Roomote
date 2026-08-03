import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

const mockEnv = vi.hoisted(() => ({
  R_CURATED_INTEGRATIONS_ENABLED: true,
}));

vi.mock('@roomote/env', () => ({
  Env: mockEnv,
  areCuratedIntegrationsEnabled: (value: boolean | undefined) => value === true,
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
        findFirst: vi.fn(),
      },
    },
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
  inArray: mockInArray,
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
    mockEnv.R_CURATED_INTEGRATIONS_ENABLED = true;
    mockFindTaskRun.mockResolvedValue({
      actingUserId: null,
    });
    mockFindEnablements.mockResolvedValue([]);
    mockFindConnections.mockResolvedValue([]);
    mockOrderBy.mockResolvedValue([buildJoinedConnectionRow()]);
  });

  it('returns no curated servers when the operator disables integrations', async () => {
    mockEnv.R_CURATED_INTEGRATIONS_ENABLED = false;

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
