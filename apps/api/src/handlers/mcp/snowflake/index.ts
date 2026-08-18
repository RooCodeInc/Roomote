import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { and, db, eq, isNull, mcpConnections } from '@roomote/db/server';
import { isMcpConnectionSnowflakeConfig } from '@roomote/types';

import type { Variables } from '../../../types';

import { resolveDeploymentMcpAuth } from '../deployment-mcp-auth';
import { McpProxyError, type McpAuthContext } from '../proxy-utils';
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
    const auth = await resolveDeploymentMcpAuth(
      c.get('authContext'),
      'Snowflake',
    );
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
