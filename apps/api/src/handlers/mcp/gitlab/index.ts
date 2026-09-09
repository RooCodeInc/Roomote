import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import type { Variables } from '../../../types';
import { authorizeGitLabMcp, GitLabOperationError } from './operations';
import { gitLabToolSchemas } from './schemas';
import { registerGitLabTools } from './tools';

const GITLAB_MCP_SERVER_INFO = {
  name: 'roomote-gitlab',
  version: '1.0.0',
} as const;

export const schemas = gitLabToolSchemas;

export function createGitlabMcp() {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', bodyLimit({ maxSize: 65536 }));
  app.on(['POST', 'GET', 'DELETE'], '/', async (c) => {
    try {
      const context = await authorizeGitLabMcp(c.get('authContext'));
      const server = new McpServer(GITLAB_MCP_SERVER_INFO);
      registerGitLabTools(server, context);
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } catch (error) {
      return Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32000,
            message:
              error instanceof GitLabOperationError
                ? error.message
                : 'GitLab MCP unavailable',
          },
        },
        { status: error instanceof GitLabOperationError ? 403 : 400 },
      );
    }
  });
  return app;
}
