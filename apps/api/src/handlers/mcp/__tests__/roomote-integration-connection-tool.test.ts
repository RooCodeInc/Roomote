import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('@roomote/sdk/server', async () => {
  const { buildIntegrationConnectionPreparation } =
    await import('@roomote/types');
  return {
    prepareIntegrationConnection: (input: { provider: string }) =>
      buildIntegrationConnectionPreparation(input, 'https://roomote.example'),
  };
});

import { registerRoomoteIntegrationConnectionTool } from '../roomote-integration-connection-tool';

it('registers and calls the read-only provider-only preparation tool', async () => {
  const server = new McpServer({ name: 'test', version: '1' });
  registerRoomoteIntegrationConnectionTool(server);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    expect(tools[0]).toMatchObject({
      name: 'prepare_integration_connection',
      annotations: { readOnlyHint: true },
      inputSchema: { required: ['provider'], additionalProperties: false },
    });
    expect(Object.keys(tools[0]!.inputSchema.properties!)).toEqual([
      'provider',
    ]);
    const result = await client.callTool({
      name: 'prepare_integration_connection',
      arguments: { provider: 'twitter' },
    });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining(
          'https://roomote.example/settings/integrations?highlight=x',
        ),
      },
    ]);
    const invalid = await client.callTool({
      name: 'prepare_integration_connection',
      arguments: { provider: 'Example', apiKey: 'secret' },
    });
    expect(invalid.isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});
