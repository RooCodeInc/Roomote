import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('create_skill MCP serialization', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('serializes required fields and dispatches parsed arguments over the shared server', async () => {
    const { roomoteMcpServer } = await import('../index.js');
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'create-skill-test', version: '1.0.0' });
    await roomoteMcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tool = (await client.listTools()).tools.find(
        ({ name }) => name === 'create_skill',
      );
      expect(tool?.inputSchema.required).toEqual([
        'name',
        'description',
        'content',
        'environmentIds',
      ]);
      expect(tool?.inputSchema.properties).toMatchObject({
        name: { type: 'string' },
        description: { type: 'string' },
        content: { type: 'string' },
        environmentIds: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', format: 'uuid' },
        },
      });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const invalid = await client.callTool({
        name: 'create_skill',
        arguments: {
          name: 'notes',
          description: 'Notes',
          content: 'Read notes',
          environmentIds: [],
        },
      });
      expect(invalid.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      vi.stubEnv('ROOMOTE_CLOUD_TOKEN', 'test-token');
      vi.stubEnv('ROOMOTE_PLATFORM_API_URL', 'https://api.example.com');
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ success: true, skillId: 'created' }), {
          status: 201,
        }),
      );
      const args = {
        name: 'notes',
        description: ' Notes ',
        content: ' Read notes ',
        environmentIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      };
      const result = await client.callTool({
        name: 'create_skill',
        arguments: args,
      });
      expect(result.isError).not.toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.example.com/api/mcp/custom-skills',
        expect.objectContaining({
          body: JSON.stringify({
            ...args,
            description: 'Notes',
            content: 'Read notes\n',
          }),
        }),
      );
    } finally {
      await client.close();
      await roomoteMcpServer.close();
    }
  });
});
