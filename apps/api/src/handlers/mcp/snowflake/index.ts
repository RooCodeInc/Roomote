import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  and,
  db,
  eq,
  isNull,
  mcpConnections,
  taskRuns,
} from '@roomote/db/server';
import { isMcpConnectionSnowflakeConfig } from '@roomote/types';

import type { Variables } from '../../../types';

import {
  isJobTokenContext,
  McpProxyError,
  type McpAuthContext,
} from '../proxy-utils';
import { registerSnowflakeTools } from './tools';

const SNOWFLAKE_MCP_SERVER_INFO = {
  name: 'roomote-snowflake-mcp',
  version: '1.0.0',
} as const;

function createSnowflakeTransport() {
  return new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
}

async function resolveSnowflakeMcpAuth(
  authContext: Variables['authContext'],
): Promise<McpAuthContext> {
  if (!authContext) {
    throw new McpProxyError(
      401,
      'Unauthorized: missing or invalid bearer token',
    );
  }

  if (isJobTokenContext(authContext)) {
    const cloudJob = await db.query.taskRuns.findFirst({
      columns: { id: true },
      where: eq(taskRuns.id, authContext.cloudJobId),
    });

    if (!cloudJob) {
      throw new McpProxyError(404, 'Cloud job not found for this MCP token');
    }

    // No principal equality check: the run-scoped token IS the authorization
    // (only this run's sandbox holds it), and Snowflake credentials come from a
    // deployment-scoped connection, so the token's userId plays no role in
    // credential selection. The token's userId is mint-time attribution while
    // task_runs.actingUserId is current-steering attribution — they
    // legitimately diverge once a web steer or follow-up switches the acting
    // user mid-run.

    return {
      userId: authContext.userId,
      tokenType: 'cj',
      cloudJobId: authContext.cloudJobId,
    };
  }

  throw new McpProxyError(
    403,
    'Snowflake MCP requires a cloud job token for server-side credential access',
  );
}

async function resolveSnowflakeConnection() {
  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, 'snowflake'),
      isNull(mcpConnections.userId),
      eq(mcpConnections.enabled, true),
      eq(mcpConnections.authStatus, 'authenticated'),
    ),
  });

  if (!connection) {
    throw new McpProxyError(
      404,
      'No active Snowflake connection found for this workspace',
    );
  }

  if (!isMcpConnectionSnowflakeConfig(connection.authConfig)) {
    throw new McpProxyError(
      500,
      'Snowflake connection is missing a valid stored credential configuration',
    );
  }

  return connection.authConfig;
}

function createSnowflakeMcpServer(
  auth: McpAuthContext,
  config: Awaited<ReturnType<typeof resolveSnowflakeConnection>>,
) {
  const server = new McpServer(SNOWFLAKE_MCP_SERVER_INFO, {
    instructions:
      'Use these Snowflake tools to inspect accessible databases, schemas, tables, and execute SQL statements within the configured workspace connection.',
  });

  registerSnowflakeTools(server, auth, config);

  return server;
}

export const snowflakeMcp = new Hono<{ Variables: Variables }>();

snowflakeMcp.on(['POST', 'GET', 'DELETE'], '/', async (c) => {
  const transport = createSnowflakeTransport();

  try {
    const auth = await resolveSnowflakeMcpAuth(c.get('authContext'));
    const connectionConfig = await resolveSnowflakeConnection();
    const server = createSnowflakeMcpServer(auth, connectionConfig);

    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  } catch (error) {
    if (error instanceof McpProxyError) {
      return Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32000,
            message: error.message,
          },
        },
        { status: error.httpStatus },
      );
    }

    return Response.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message:
            error instanceof Error
              ? error.message
              : 'Unknown Snowflake MCP error',
        },
      },
      { status: 500 },
    );
  }
});
