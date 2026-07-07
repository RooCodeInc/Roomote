import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { resolveUserIdForCloudJob } from '@roomote/cloud-agents/server';
import {
  and,
  cloudJobs,
  db,
  eq,
  isNull,
  mcpConnections,
} from '@roomote/db/server';
import { isMcpConnectionVercelConfig } from '@roomote/types';

import type { Variables } from '../../../types';

import {
  isJobTokenContext,
  McpProxyError,
  type McpAuthContext,
} from '../proxy-utils';
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

async function resolveVercelMcpAuth(
  authContext: Variables['authContext'],
): Promise<McpAuthContext> {
  if (!authContext) {
    throw new McpProxyError(
      401,
      'Unauthorized: missing or invalid bearer token',
    );
  }

  if (isJobTokenContext(authContext)) {
    const cloudJob = await db.query.cloudJobs.findFirst({
      columns: { id: true, userId: true },
      where: eq(cloudJobs.id, authContext.cloudJobId),
    });

    if (!cloudJob) {
      throw new McpProxyError(404, 'Cloud job not found for this MCP token');
    }

    const resolvedUserId = await resolveUserIdForCloudJob(cloudJob);
    if (!resolvedUserId) {
      throw new McpProxyError(
        403,
        'MCP proxy requires a cloud job associated with a real user',
      );
    }

    if (resolvedUserId !== authContext.userId) {
      throw new McpProxyError(
        403,
        'MCP token user does not match cloud job user',
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
    'Vercel MCP requires a cloud job token for server-side credential access',
  );
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
  const server = new McpServer(VERCEL_MCP_SERVER_INFO, {
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
    await resolveVercelMcpAuth(c.get('authContext'));
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
