import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { and, db, eq, isNull, mcpConnections } from '@roomote/db/server';
import { isMcpConnectionGranolaConfig } from '@roomote/types';

import type { Variables } from '../../../types';

import { resolveDeploymentMcpAuth } from '../deployment-mcp-auth';
import { McpProxyError } from '../proxy-utils';
import { registerGranolaTools } from './tools';

const GRANOLA_MCP_SERVER_INFO = {
  name: 'roomote-granola-mcp',
  version: '1.0.0',
} as const;

async function resolveGranolaConnection() {
  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, 'granola'),
      isNull(mcpConnections.userId),
      eq(mcpConnections.enabled, true),
      eq(mcpConnections.authStatus, 'authenticated'),
    ),
  });

  if (!connection) {
    throw new McpProxyError(
      404,
      'No active Granola connection found for this workspace',
    );
  }

  if (!isMcpConnectionGranolaConfig(connection.authConfig)) {
    throw new McpProxyError(
      500,
      'Granola connection is missing a valid stored credential configuration',
    );
  }

  return connection.authConfig;
}

function createGranolaMcpServer(
  config: Awaited<ReturnType<typeof resolveGranolaConnection>>,
) {
  const server = new McpServer(GRANOLA_MCP_SERVER_INFO, {
    instructions:
      'Use these read-only Granola tools to inspect notes, transcripts, and folders through the configured workspace API key.',
  });

  registerGranolaTools(server, config);
  return server;
}

export const granolaMcp = new Hono<{ Variables: Variables }>();

granolaMcp.on(['POST', 'GET', 'DELETE'], '/', async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  try {
    await resolveDeploymentMcpAuth(c.get('authContext'), 'Granola');
    const connectionConfig = await resolveGranolaConnection();
    const server = createGranolaMcpServer(connectionConfig);

    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  } catch (error) {
    if (error instanceof McpProxyError) {
      return Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: error.message },
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
              : 'Unknown Granola MCP error',
        },
      },
      { status: 500 },
    );
  }
});
