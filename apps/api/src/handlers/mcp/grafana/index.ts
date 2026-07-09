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
import { isMcpConnectionGrafanaConfig } from '@roomote/types';

import type { Variables } from '../../../types';

import {
  isJobTokenContext,
  McpProxyError,
  type McpAuthContext,
} from '../proxy-utils';
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

async function resolveGrafanaMcpAuth(
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
      columns: { id: true, actingUserId: true },
      where: eq(taskRuns.id, authContext.cloudJobId),
    });

    if (!cloudJob) {
      throw new McpProxyError(404, 'Cloud job not found for this MCP token');
    }

    // The token principal must match the run's acting user: a user token must
    // carry the run's acting user, and a deployment-service-principal token is
    // only valid for a run with no acting user (null === null). Grafana
    // credentials come from a deployment-scoped connection, so
    // deployment-principal jobs are fully supported.
    if ((cloudJob.actingUserId ?? null) !== authContext.userId) {
      throw new McpProxyError(
        403,
        'MCP token principal does not match cloud job',
      );
    }

    return {
      userId: authContext.userId,
      tokenType: 'cj',
      cloudJobId: authContext.cloudJobId,
    };
  }

  throw new McpProxyError(
    403,
    'Grafana MCP requires a cloud job token for server-side credential access',
  );
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
    await resolveGrafanaMcpAuth(c.get('authContext'));
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
