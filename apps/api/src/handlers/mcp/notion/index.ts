import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  and,
  db,
  deploymentMcpEnablements,
  eq,
  isNull,
  mcpConnections,
  taskRuns,
} from '@roomote/db/server';
import { isMcpConnectionNotionConfig } from '@roomote/types';

import type { Variables } from '../../../types';

import {
  isRunTokenContext,
  McpProxyError,
  type McpAuthContext,
} from '../proxy-utils';
import { registerNotionTools } from './tools';

const NOTION_MCP_SERVER_INFO = {
  name: 'roomote-notion-mcp',
  version: '1.0.0',
} as const;

async function resolveNotionMcpAuth(
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
    'Notion MCP requires a user auth token or task run token for server-side credential access',
  );
}

async function resolveNotionConnection() {
  const [connection, enablement] = await Promise.all([
    db.query.mcpConnections.findFirst({
      where: and(
        eq(mcpConnections.mcpId, 'notion'),
        isNull(mcpConnections.userId),
        eq(mcpConnections.enabled, true),
        eq(mcpConnections.authStatus, 'authenticated'),
      ),
    }),
    db.query.deploymentMcpEnablements.findFirst({
      where: and(
        eq(deploymentMcpEnablements.mcpId, 'notion'),
        eq(deploymentMcpEnablements.enabled, true),
      ),
      columns: { mcpId: true },
    }),
  ]);

  if (!connection || !enablement) {
    throw new McpProxyError(
      404,
      'No active Notion connection found for this workspace',
    );
  }

  if (!isMcpConnectionNotionConfig(connection.authConfig)) {
    throw new McpProxyError(
      500,
      'Notion connection is missing a valid internal integration configuration',
    );
  }

  return connection.authConfig;
}

function createNotionMcpServer(
  config: Awaited<ReturnType<typeof resolveNotionConnection>>,
) {
  const server = new McpServer(NOTION_MCP_SERVER_INFO, {
    instructions:
      'Use these Notion tools only for content explicitly shared with the deployment internal integration. Unshared pages, including private pages, are inaccessible to the stored token.',
  });

  registerNotionTools(server, config);
  return server;
}

export const notionMcp = new Hono<{ Variables: Variables }>();

notionMcp.on(['POST', 'GET', 'DELETE'], '/', async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  try {
    await resolveNotionMcpAuth(c.get('authContext'));
    const connection = await resolveNotionConnection();
    const server = createNotionMcpServer(connection);

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
            error instanceof Error ? error.message : 'Unknown Notion MCP error',
        },
      },
      { status: 500 },
    );
  }
});
