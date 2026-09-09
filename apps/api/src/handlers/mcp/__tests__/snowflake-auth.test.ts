import { createPrivateKey, generateKeyPairSync } from 'node:crypto';

import { Hono } from 'hono';
import type { RunTokenContext } from '@roomote/types';

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

const PRIVATE_KEY_PASSPHRASE = 'test-pem-passphrase';
const { privateKey: encryptedPrivateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem',
    cipher: 'aes-256-cbc',
    passphrase: PRIVATE_KEY_PASSPHRASE,
  },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const unencryptedPrivateKey = createPrivateKey({
  key: encryptedPrivateKey,
  format: 'pem',
  passphrase: PRIVATE_KEY_PASSPHRASE,
})
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();

// Throwaway 1024-bit RSA key used only to prove that Roomote rejects keys
// below Snowflake's 2048-bit minimum. It is a static fixture so the test does
// not have to generate a weak key at runtime.
const WEAK_RSA_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIICdgIBADANBgkqhkiG9w0BAQEFAASCAmAwggJcAgEAAoGBAMpUctCsXrXT3N72
xjom38dV1SjCSykBWPi0SZiCINbAe8HB9poI4OXxV7mgSD08zWL+oHy/+xOrk0Vn
FpE8lUBuGs/OPmpiMAMpn8afkHui1wjUI4QDYViqnVQ3DZrFgQgmzryliujn5fgt
FeW8U1oSMOVXxOitwmsz2L9PLPqXAgMBAAECgYBBGExcQKiz/Ta5cVGzUeB7RG0x
ENmXlrxmP7LR40Pnc8QdQWcyhZq9wBkGOsAjG5XEvMErgaSo3nGiSZlkHsaxgi7Y
g2FjOrz5dwANoxWfeXviQxeFhTcr9zZ7Kf4XLl67Julr0mrXCFwQjN0tSqKkJqa3
T01RXZhPOOl2lZSX0QJBAPPzWLkLbfvABV6O8NmoLP6h/f8R+RWNJFfwT346JY7N
klDVcq4r/PQdgOEF6PtSFoDRILCvWrSRn2S7y19zIs8CQQDUUtNXkJzMOlk3v6mZ
6o8Gj03XMiWZxB1rc21yhkwuuah+amm3xDYb7usv36N+PZWtGCi4qEANJ6fqpC1Q
2r25AkEArze6Ii7zcD8bnC9PDwacSshPh0WBgtk9oWwZrLBXCZrd3PFyzWcK6MvI
Jdf434q2Xw/WSxGoNMnjkpbQHF62QQJANGFakjey9w9OA1rdVINxVYT1Bynv7Mdd
Gq0XSzGmicBzuPw3qIZXcvy2ONFLXFGFI3baVPPtGVG3M0PdihzswQJAURom6e1h
RHZARrKx3F4VZFnDiRRy7f+9DIwQt9KGyoyOLOSik/XFhWEE/NtYhC1adrMOaLD/
4YBjSVQEeHBBgg==
-----END PRIVATE KEY-----`;

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
      encryptedPrivateKey: `enc:${unencryptedPrivateKey}`,
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
        authenticator: 'SNOWFLAKE_JWT',
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
        authenticator: 'SNOWFLAKE_JWT',
      }),
    );
    expect(connectionConfig).not.toHaveProperty('warehouse');
  });

  it('uses Snowflake JWT auth when a private key is configured', async () => {
    mockFindConnection.mockResolvedValue(
      mockConnectionRow({
        encryptedPrivateKey: `enc:${encryptedPrivateKey}`,
        encryptedPrivateKeyPassphrase: `enc:${PRIVATE_KEY_PASSPHRASE}`,
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
    if (!connectionConfig) {
      throw new Error('Expected Snowflake connection options');
    }
    expect(connectionConfig).toEqual(
      expect.objectContaining({
        account: 'xy12345.us-east-1',
        username: 'roomote',
        authenticator: 'SNOWFLAKE_JWT',
        privateKey: expect.stringContaining('-----BEGIN PRIVATE KEY-----'),
      }),
    );
    expect(connectionConfig).not.toHaveProperty('privateKeyPass');
    expect(connectionConfig.privateKey).not.toBe(encryptedPrivateKey);
    expect(() =>
      createPrivateKey({
        key: connectionConfig.privateKey as string,
        format: 'pem',
      }),
    ).not.toThrow();
  });

  it('continues to accept unencrypted PKCS8 private keys', async () => {
    mockFindConnection.mockResolvedValue(
      mockConnectionRow({
        encryptedPrivateKey: `enc:${unencryptedPrivateKey}`,
        encryptedPrivateKeyPassphrase: undefined,
      }),
    );

    const response = await postMcp(
      createApp(createRunToken()),
      createInitializeRequest(77),
    );

    expect(response.status).toBe(200);
    expect(mockSnowflakeCreateConnection).not.toHaveBeenCalled();
  });

  it('rejects an incorrect private key passphrase without exposing secrets', async () => {
    mockFindConnection.mockResolvedValue(
      mockConnectionRow({
        encryptedPrivateKey: `enc:${encryptedPrivateKey}`,
        encryptedPrivateKeyPassphrase: 'enc:wrong-secret-passphrase',
      }),
    );

    const response = await postMcp(
      createApp(createRunToken()),
      createInitializeRequest(73),
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain('Snowflake private key or passphrase is invalid');
    expect(body).not.toContain('wrong-secret-passphrase');
    expect(body).not.toContain(encryptedPrivateKey);
    expect(mockSnowflakeCreateConnection).not.toHaveBeenCalled();
  });

  it('rejects non-RSA PKCS8 private keys', async () => {
    const { privateKey: encryptedEcPrivateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: PRIVATE_KEY_PASSPHRASE,
      },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    mockFindConnection.mockResolvedValue(
      mockConnectionRow({
        encryptedPrivateKey: `enc:${encryptedEcPrivateKey}`,
        encryptedPrivateKeyPassphrase: `enc:${PRIVATE_KEY_PASSPHRASE}`,
      }),
    );

    const response = await postMcp(
      createApp(createRunToken()),
      createInitializeRequest(74),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Snowflake private key or passphrase is invalid' },
    });
    expect(mockSnowflakeCreateConnection).not.toHaveBeenCalled();
  });

  it('rejects RSA private keys smaller than 2048 bits', async () => {
    mockFindConnection.mockResolvedValue(
      mockConnectionRow({
        encryptedPrivateKey: `enc:${WEAK_RSA_PRIVATE_KEY}`,
        encryptedPrivateKeyPassphrase: undefined,
      }),
    );

    const response = await postMcp(
      createApp(createRunToken()),
      createInitializeRequest(75),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Snowflake private key or passphrase is invalid' },
    });
    expect(mockSnowflakeCreateConnection).not.toHaveBeenCalled();
  });

  it('redacts Snowflake SDK connection errors', async () => {
    mockSnowflakeConnect.mockImplementationOnce((callback) => {
      callback?.(new Error(`Login failed for ${PRIVATE_KEY_PASSPHRASE}`));
      return {} as never;
    });

    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 76,
      method: 'tools/call',
      params: {
        name: 'execute_sql',
        arguments: { sql: 'SELECT 1 AS RESULT' },
      },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('Snowflake connection failed');
    expect(body).not.toContain(PRIVATE_KEY_PASSPHRASE);
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
});
