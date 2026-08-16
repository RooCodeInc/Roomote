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
import { isMcpConnectionAsanaConfig } from '@roomote/types';

import type { Variables } from '../../../types';

import {
  isRunTokenContext,
  McpProxyError,
  type McpAuthContext,
} from '../proxy-utils';
import { registerAsanaTools } from './tools';

const ASANA_MCP_SERVER_INFO = {
  name: 'roomote-asana-mcp',
  version: '1.0.0',
} as const;

function createAsanaTransport() {
  return new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
}

async function resolveAsanaMcpAuth(
  authContext: Variables['authContext'],
): Promise<McpAuthContext> {
  if (!authContext) {
    throw new McpProxyError(
      401,
      'Unauthorized: missing or invalid bearer token',
    );
  }

  if (isRunTokenContext(authContext)) {
    const taskRun = await db.query.taskRuns.findFirst({
      columns: { id: true },
      where: eq(taskRuns.id, authContext.runId),
    });

    if (!taskRun) {
      throw new McpProxyError(404, 'Task run not found for this MCP token');
    }

    // No principal equality check: the run-scoped token IS the authorization
    // (only this run's sandbox holds it), and Asana credentials come from a
    // deployment-scoped connection, so the token's userId plays no role in
    // credential selection. The token's userId is mint-time attribution while
    // task_runs.actingUserId is current-steering attribution — they
    // legitimately diverge once a web steer or follow-up switches the acting
    // user mid-run.

    return {
      userId: authContext.userId,
      tokenType: 'run',
      runId: authContext.runId,
    };
  }

  if (authContext.tokenType === 'auth') {
    return { userId: authContext.userId, tokenType: 'auth' };
  }

  throw new McpProxyError(
    403,
    'Asana MCP requires a user auth token or task run token for server-side credential access',
  );
}

async function resolveAsanaConnection() {
  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, 'asana'),
      isNull(mcpConnections.userId),
      eq(mcpConnections.enabled, true),
      eq(mcpConnections.authStatus, 'authenticated'),
    ),
  });

  if (!connection) {
    throw new McpProxyError(
      404,
      'No active Asana connection found for this workspace',
    );
  }

  if (!isMcpConnectionAsanaConfig(connection.authConfig)) {
    throw new McpProxyError(
      500,
      'Asana connection is missing a valid stored credential configuration',
    );
  }

  return connection.authConfig;
}

function createAsanaMcpServer(
  config: Awaited<ReturnType<typeof resolveAsanaConnection>>,
) {
  const server = new McpServer(ASANA_MCP_SERVER_INFO, {
    instructions:
      'Use these Asana tools to inspect workspaces, projects, tasks, teams, comments, and users through the configured workspace token.',
  });

  registerAsanaTools(server, config);

  return server;
}

export const asanaMcp = new Hono<{ Variables: Variables }>();

asanaMcp.on(['POST', 'GET', 'DELETE'], '/', async (c) => {
  const transport = createAsanaTransport();

  try {
    await resolveAsanaMcpAuth(c.get('authContext'));
    const connectionConfig = await resolveAsanaConnection();
    const server = createAsanaMcpServer(connectionConfig);

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
            error instanceof Error ? error.message : 'Unknown Asana MCP error',
        },
      },
      { status: 500 },
    );
  }
});
