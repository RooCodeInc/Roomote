import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const { manage, createCaller } = vi.hoisted(() => {
  const manage = vi.fn();
  return {
    manage,
    createCaller: vi.fn(() => ({
      mcpConnections: { manageConnection: manage },
    })),
  };
});

vi.mock('@roomote/sdk/server', async () => {
  const { buildIntegrationConnectionPreparation } =
    await import('@roomote/types');
  return {
    appRouter: { createCaller },
    prepareIntegrationConnection: (input: { provider: string }) =>
      buildIntegrationConnectionPreparation(input, 'https://roomote.example'),
  };
});

import { registerRoomoteIntegrationConnectionTool } from '../roomote-integration-connection-tool';

it('registers and calls the read-only provider-only preparation tool', async () => {
  const server = new McpServer({ name: 'test', version: '1' });
  registerRoomoteIntegrationConnectionTool(server, {
    userId: 'admin',
    authContext: { userId: 'admin', tokenType: 'auth', version: 1 },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const management = tools.find(
      (tool) => tool.name === 'manage_integration_connection',
    );
    expect(management).toMatchObject({
      annotations: { readOnlyHint: false },
      inputSchema: { required: ['action'], additionalProperties: false },
    });
    expect(Object.keys(management!.inputSchema.properties!)).toEqual([
      'action',
      'integrationId',
      'name',
      'url',
      'authType',
      'enabled',
      'disabledTools',
    ]);
    manage.mockResolvedValueOnce({ state: 'saved', integrations: [] });
    await client.callTool({
      name: 'manage_integration_connection',
      arguments: { action: 'list' },
    });
    expect(createCaller).toHaveBeenCalledWith({
      auth: { userId: 'admin', tokenType: 'auth', version: 1 },
    });
    expect(manage).toHaveBeenCalledWith({ action: 'list' });
    manage.mockRejectedValueOnce(new Error('secret upstream URL'));
    const failed = await client.callTool({
      name: 'manage_integration_connection',
      arguments: { action: 'list' },
    });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('secret upstream URL');
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
