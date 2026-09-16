import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { NullableOptionalsMcpServer } from '@roomote/cloud-agents/mcp-nullable-optionals';
import { Env } from '@roomote/env';

import type { Variables } from '../../types';

const serverInfo = {
  name: 'roomote-development-fixtures',
  version: '1.0.0',
} as const;

function createDevelopmentFixturesServer() {
  const server = new NullableOptionalsMcpServer(serverInfo, {
    instructions:
      'Read deterministic local development records. This adapter never accesses external systems.',
  });

  server.registerTool(
    'list_fixture_records',
    {
      title: 'List Fixture Records',
      description:
        'Return deterministic local records for development integration journeys.',
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            records: [
              { id: 'fixture-alpha', status: 'ready' },
              { id: 'fixture-beta', status: 'needs_input' },
            ],
          }),
        },
      ],
    }),
  );

  return server;
}

export const developmentFixturesMcp = new Hono<{ Variables: Variables }>();

developmentFixturesMcp.on(['POST', 'GET', 'DELETE'], '/', async (c) => {
  if (Env.APP_ENV !== 'development') return c.notFound();

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  const server = createDevelopmentFixturesServer();
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});
