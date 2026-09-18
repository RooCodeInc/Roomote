import { Hono } from 'hono';
import { NullableOptionalsMcpServer } from '@roomote/cloud-agents/mcp-nullable-optionals';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { and, db, eq, isNull, mcpConnections } from '@roomote/db/server';
import { isMcpConnectionVercelConfig } from '@roomote/types';

import type { Variables } from '../../../types';

import { resolveDeploymentMcpAuth } from '../deployment-mcp-auth';
import { McpProxyError } from '../proxy-utils';
import { registerVercelTools } from './tools';

const VERCEL_MCP_SERVER_INFO = {
  name: 'roomote-vercel-mcp',
  version: '1.0.0',
} as const;

function createVercelTransport() {
  return new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
}

async function resolveVercelConnection() {
  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, 'vercel'),
      isNull(mcpConnections.userId),
      eq(mcpConnections.enabled, true),
      eq(mcpConnections.authStatus, 'authenticated'),
    ),
  });

  if (!connection) {
    throw new McpProxyError(
      404,
      'No active Vercel connection found for this workspace',
    );
  }

  if (!isMcpConnectionVercelConfig(connection.authConfig)) {
    throw new McpProxyError(
      500,
      'Vercel connection is missing a valid stored credential configuration',
    );
  }

  return connection.authConfig;
}

function createVercelMcpServer(
  config: Awaited<ReturnType<typeof resolveVercelConnection>>,
) {
  const server = new NullableOptionalsMcpServer(VERCEL_MCP_SERVER_INFO, {
    instructions:
      'Use these Vercel tools to inspect teams, projects, deployments, logs, and domain availability through the configured workspace token. This Roomote-hosted surface is intentionally read-only.',
  });

  registerVercelTools(server, config);

  return server;
}

export const vercelMcp = new Hono<{ Variables: Variables }>();

vercelMcp.on(['POST', 'GET', 'DELETE'], '/', async (c) => {
  const transport = createVercelTransport();

  try {
    await resolveDeploymentMcpAuth(c.get('authContext'), 'Vercel');
    const connectionConfig = await resolveVercelConnection();
    const server = createVercelMcpServer(connectionConfig);

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
            error instanceof Error ? error.message : 'Unknown Vercel MCP error',
        },
      },
      { status: 500 },
    );
  }
});
