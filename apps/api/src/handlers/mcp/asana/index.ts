import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { resolveCredentialUserIdForCloudJob } from '@roomote/cloud-agents/server';
import {
  and,
  cloudJobs,
  db,
  eq,
  isNull,
  mcpConnections,
} from '@roomote/db/server';
import { isMcpConnectionAsanaConfig } from '@roomote/types';

import type { Variables } from '../../../types';

import {
  isJobTokenContext,
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

  if (isJobTokenContext(authContext)) {
    const cloudJob = await db.query.cloudJobs.findFirst({
      columns: { id: true, userId: true },
      where: eq(cloudJobs.id, authContext.cloudJobId),
    });

    if (!cloudJob) {
      throw new McpProxyError(404, 'Cloud job not found for this MCP token');
    }

    const resolvedUserId = await resolveCredentialUserIdForCloudJob(cloudJob);
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
    'Asana MCP requires a cloud job token for server-side credential access',
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
