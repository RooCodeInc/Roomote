import { Hono } from 'hono';
import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const {
  mockFindTaskRun,
  mockFindConnection,
  mockEq,
  mockAnd,
  mockIsNull,
  mockSnowflakeConfigure,
  mockSnowflakeCreateConnection,
  mockSnowflakeConnect,
  mockSnowflakeDestroy,
  mockSnowflakeExecute,
} = vi.hoisted(() => {
  const mockSnowflakeConnect = vi.fn();
  const mockSnowflakeDestroy = vi.fn();
  const mockSnowflakeExecute = vi.fn();
  const mockSnowflakeCreateConnection = vi.fn(() => ({
    connect: mockSnowflakeConnect,
    destroy: mockSnowflakeDestroy,
    execute: mockSnowflakeExecute,
  }));

  return {
    mockFindTaskRun: vi.fn(),
    mockFindConnection: vi.fn(),
    mockEq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
    mockAnd: vi.fn((...clauses: unknown[]) => clauses),
    mockIsNull: vi.fn((column: unknown) => ({ type: 'isNull', column })),
    mockSnowflakeConfigure: vi.fn(),
    mockSnowflakeCreateConnection,
    mockSnowflakeConnect,
    mockSnowflakeDestroy,
    mockSnowflakeExecute,
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mockFindTaskRun },
      mcpConnections: { findFirst: mockFindConnection },
    },
  },
  taskRuns: { id: 'id' },
  mcpConnections: {
    mcpId: 'mcpId',
    enabled: 'enabled',
    authStatus: 'authStatus',
    userId: 'userId',
  },
  eq: mockEq,
  and: mockAnd,
  isNull: mockIsNull,
}));

vi.mock('@roomote/db/encryption', () => ({
  decrypt: vi.fn((value: string) =>
    value.startsWith('enc:') ? value.slice(4) : value,
  ),
}));

vi.mock('snowflake-sdk', () => ({
  default: {
    configure: mockSnowflakeConfigure,
    createConnection: mockSnowflakeCreateConnection,
  },
  configure: mockSnowflakeConfigure,
  createConnection: mockSnowflakeCreateConnection,
}));

import { db } from '@roomote/db/server';
import { snowflakeMcp } from '../snowflake';

type JsonRpcErrorBody = {
  error: { message: string };
};

function createInitializeRequest(id: number) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {
        name: 'roomote-api-test',
        version: '1.0.0',
      },
    },
  };
}

function createApp(authContext: Variables['authContext']) {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    c.set('authContext', authContext);
    await next();
  });

  app.route('/mcp', snowflakeMcp);
  return app;
}

async function postMcp(app: Hono<{ Variables: Variables }>, body: unknown) {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function mockConnectionRow(overrides?: Record<string, unknown>) {
  return {
    id: 'conn-1',
    userId: null,
    mcpId: 'snowflake',
    enabled: true,
    authStatus: 'authenticated',
    authConfig: {
      type: 'snowflake',
      account: 'xy12345.us-east-1',
      username: 'roomote',
      role: 'ANALYST',
      warehouse: 'ROOMOTE_WH',
      encryptedPassword: 'enc:secret',
      ...(overrides ?? {}),
    },
  } as Awaited<ReturnType<typeof db.query.mcpConnections.findFirst>>;
}

function createRunToken(overrides?: Partial<RunTokenContext>): RunTokenContext {
  return {
    runId: 42,
    userId: 'user-1',
    principal: 'user',
    tokenType: 'run',
    version: 1,
    ...(overrides ?? {}),
  };
}

describe('snowflake MCP auth and tool handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindTaskRun.mockResolvedValue({
      id: 42,
      actingUserId: 'user-1',
    });
    mockFindConnection.mockResolvedValue(mockConnectionRow());
    mockSnowflakeConnect.mockImplementation((callback) => {
      callback?.(null, {} as never);
      return {} as never;
    });
    mockSnowflakeDestroy.mockImplementation((callback) => {
      callback?.(null, {} as never);
      return {} as never;
    });
    mockSnowflakeExecute.mockImplementation(({ sqlText, complete }) => {
      if (sqlText === 'SHOW DATABASES') {
        complete(null, {} as never, [{ name: 'ANALYTICS', kind: 'STANDARD' }]);
        return {} as never;
      }

      if (sqlText.includes('SHOW SCHEMAS')) {
        complete(null, {} as never, [
          { name: 'PUBLIC', database_name: 'ANALYTICS' },
        ]);
        return {} as never;
      }

      if (sqlText.includes('SHOW TABLES')) {
        complete(null, {} as never, [
          {
            name: 'EVENTS',
            database_name: 'ANALYTICS',
            schema_name: 'PUBLIC',
            kind: 'TABLE',
          },
        ]);
        return {} as never;
      }

      if (sqlText.includes('DESCRIBE TABLE')) {
        complete(null, {} as never, [
          { name: 'ID', type: 'NUMBER', 'null?': 'N', comment: 'Primary key' },
        ]);
        return {} as never;
      }

      complete(null, {} as never, [{ QUERY: sqlText, RESULT: 'ok' }]);
      return {} as never;
    });
  });

  it('rejects when auth context is missing', async () => {
    const response = await postMcp(
      createApp(undefined),
      createInitializeRequest(1),
    );
    const body = (await response.json()) as JsonRpcErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.message).toContain('Unauthorized');
  });

  it('rejects user auth tokens for Snowflake access', async () => {
    const authToken: AuthTokenContext = {
      userId: 'user-1',
      tokenType: 'auth',
      version: 1,
    };

    const response = await postMcp(
      createApp(authToken),
      createInitializeRequest(1),
    );
    const body = (await response.json()) as JsonRpcErrorBody;

    expect(response.status).toBe(403);
    expect(body.error.message).toContain('requires a task run token');
  });

  it('initializes successfully for task run tokens', async () => {
    const response = await postMcp(
      createApp(createRunToken()),
      createInitializeRequest(1),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'roomote-snowflake-mcp', version: '1.0.0' },
        capabilities: {
          tools: {
            listChanged: true,
          },
        },
      },
    });
  });

  it('lists the Snowflake tools', async () => {
    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'execute_sql' }),
          expect.objectContaining({ name: 'list_databases' }),
          expect.objectContaining({ name: 'list_schemas' }),
          expect.objectContaining({ name: 'list_tables' }),
          expect.objectContaining({ name: 'describe_table' }),
        ]),
      },
    });
  });

  it('executes SQL through the Snowflake SDK wrapper', async () => {
    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'execute_sql',
        arguments: {
          sql: 'SELECT 1 AS RESULT',
        },
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          rowCount: 1,
          rows: [{ QUERY: 'SELECT 1 AS RESULT', RESULT: 'ok' }],
        },
      },
    });
    expect(mockSnowflakeCreateConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        account: 'xy12345.us-east-1',
        username: 'roomote',
        password: 'secret',
      }),
    );
  });

  it('omits warehouse from Snowflake SDK options when no warehouse is configured', async () => {
    mockFindConnection.mockResolvedValue(
      mockConnectionRow({
        warehouse: undefined,
      }),
    );

    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 71,
      method: 'tools/call',
      params: {
        name: 'execute_sql',
        arguments: {
          sql: 'SELECT 1 AS RESULT',
        },
      },
    });

    expect(response.status).toBe(200);
    const lastCreateConnectionCall =
      mockSnowflakeCreateConnection.mock.calls.at(-1) as
        | [Record<string, unknown>]
        | undefined;
    expect(lastCreateConnectionCall).toBeDefined();
    const [connectionConfig] = lastCreateConnectionCall ?? [];
    expect(connectionConfig).toEqual(
      expect.objectContaining({
        account: 'xy12345.us-east-1',
        username: 'roomote',
        password: 'secret',
      }),
    );
    expect(connectionConfig).not.toHaveProperty('warehouse');
  });

  it('uses Snowflake JWT auth when a private key is configured', async () => {
    mockFindConnection.mockResolvedValue(
      mockConnectionRow({
        encryptedPassword: 'enc:legacy-password',
        encryptedPrivateKey:
          'enc:-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
        encryptedPrivateKeyPassphrase: 'enc:pem-passphrase',
      }),
    );

    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 72,
      method: 'tools/call',
      params: {
        name: 'execute_sql',
        arguments: {
          sql: 'SELECT 1 AS RESULT',
        },
      },
    });

    expect(response.status).toBe(200);
    const lastCreateConnectionCall =
      mockSnowflakeCreateConnection.mock.calls.at(-1) as
        | [Record<string, unknown>]
        | undefined;
    expect(lastCreateConnectionCall).toBeDefined();
    const [connectionConfig] = lastCreateConnectionCall ?? [];
    expect(connectionConfig).toEqual(
      expect.objectContaining({
        account: 'xy12345.us-east-1',
        username: 'roomote',
        authenticator: 'SNOWFLAKE_JWT',
        privateKey:
          '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
        privateKeyPass: 'pem-passphrase',
      }),
    );
    expect(connectionConfig).not.toHaveProperty('password');
  });

  it('returns normalized table descriptions', async () => {
    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'describe_table',
        arguments: {
          table_name: 'ANALYTICS.PUBLIC.EVENTS',
        },
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          table: {
            database: 'ANALYTICS',
            schema: 'PUBLIC',
            name: 'EVENTS',
          },
          columns: [
            {
              name: 'ID',
              type: 'NUMBER',
              nullable: false,
              comment: 'Primary key',
            },
          ],
        },
      },
    });
  });

  it('rejects disallowed statement types as JSON-RPC errors', async () => {
    mockFindConnection.mockResolvedValue(
      mockConnectionRow({
        allowedStatementTypes: ['SELECT'],
      }),
    );

    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: {
        name: 'execute_sql',
        arguments: {
          sql: 'DELETE FROM ANALYTICS.PUBLIC.EVENTS',
        },
      },
    });
    const body = (await response.json()) as {
      result?: {
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      error?: { message?: string };
    };

    expect(response.status).toBe(200);
    expect(body.error?.message ?? body.result?.content?.[0]?.text).toContain(
      'DELETE is not allowed',
    );
  });

  it('treats CTE-based read queries as SELECT for allowlist checks', async () => {
    mockFindConnection.mockResolvedValue(
      mockConnectionRow({
        allowedStatementTypes: ['SELECT'],
      }),
    );

    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 100,
      method: 'tools/call',
      params: {
        name: 'execute_sql',
        arguments: {
          sql: 'WITH recent_events AS (SELECT 1 AS id) SELECT id FROM recent_events',
        },
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          rowCount: 1,
          rows: [
            {
              QUERY:
                'WITH recent_events AS (SELECT 1 AS id) SELECT id FROM recent_events',
              RESULT: 'ok',
            },
          ],
        },
      },
    });
  });

  it('validates task run tokens before serving Snowflake tools', async () => {
    const response = await postMcp(
      createApp(createRunToken()),
      createInitializeRequest(3),
    );

    expect(response.status).toBe(200);
    expect(mockFindTaskRun).toHaveBeenCalled();
  });

  it('accepts a token minted for user A after the acting user switched to user B', async () => {
    // Web steer / follow-up delivery mutate task_runs.actingUserId mid-run;
    // the run-scoped token stays authorized (the token's userId is mint-time
    // attribution and is never compared against the mutable acting user).
    mockFindTaskRun.mockResolvedValue({
      id: 42,
      actingUserId: 'user-2',
    });

    const response = await postMcp(
      createApp(createRunToken()),
      createInitializeRequest(4),
    );

    expect(response.status).toBe(200);
  });

  it('accepts a deployment-principal token after a human became the acting user', async () => {
    // A human replying in the thread of an automation run switches the acting
    // user from null to that human; the run-scoped null-principal token must
    // keep working.
    mockFindTaskRun.mockResolvedValue({
      id: 42,
      actingUserId: 'user-2',
    });

    const response = await postMcp(
      createApp(createRunToken({ userId: null, principal: 'deployment' })),
      createInitializeRequest(4),
    );

    expect(response.status).toBe(200);
  });

  it('allows deployment-principal tokens for deployment-principal task runs backed by a deployment-scoped connection', async () => {
    mockFindTaskRun.mockResolvedValue({
      id: 42,
      actingUserId: null,
    });

    const response = await postMcp(
      createApp(createRunToken({ userId: null, principal: 'deployment' })),
      createInitializeRequest(4),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        serverInfo: { name: 'roomote-snowflake-mcp' },
      },
    });
  });
});
