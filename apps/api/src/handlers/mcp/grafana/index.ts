import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { and, db, eq, isNull, mcpConnections } from '@roomote/db/server';
import { isMcpConnectionGrafanaConfig } from '@roomote/types';

import type { Variables } from '../../../types';

import { resolveDeploymentMcpAuth } from '../deployment-mcp-auth';
import { McpProxyError } from '../proxy-utils';
import { registerGrafanaTools } from './tools';

const GRAFANA_MCP_SERVER_INFO = {
  name: 'roomote-grafana-mcp',
  version: '1.0.0',
} as const;

function createGrafanaTransport() {
  return new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
}

async function resolveGrafanaConnection() {
  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, 'grafana'),
      isNull(mcpConnections.userId),
      eq(mcpConnections.enabled, true),
      eq(mcpConnections.authStatus, 'authenticated'),
    ),
  });

  if (!connection) {
    throw new McpProxyError(
      404,
      'No active Grafana connection found for this workspace',
    );
  }

  if (!isMcpConnectionGrafanaConfig(connection.authConfig)) {
    throw new McpProxyError(
      500,
      'Grafana connection is missing a valid stored credential configuration',
    );
  }

  return connection.authConfig;
}

function createGrafanaMcpServer(
  config: Awaited<ReturnType<typeof resolveGrafanaConnection>>,
) {
  const server = new McpServer(GRAFANA_MCP_SERVER_INFO, {
    instructions:
      'Use these read-only Grafana tools to inspect dashboards, alerting state, annotations, and data sources through the configured workspace service account.',
  });

  registerGrafanaTools(server, config);

  return server;
}

export const grafanaMcp = new Hono<{ Variables: Variables }>();

grafanaMcp.on(['POST', 'GET', 'DELETE'], '/', async (c) => {
  const transport = createGrafanaTransport();

  try {
    await resolveDeploymentMcpAuth(c.get('authContext'), 'Grafana');
    const connectionConfig = await resolveGrafanaConnection();
    const server = createGrafanaMcpServer(connectionConfig);

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
              : 'Unknown Grafana MCP error',
        },
      },
      { status: 500 },
    );
  }
});
