import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('roomote MCP custom skill registration', () => {
  const fetchMock = vi.fn();
  const input = {
    name: 'review-checklist',
    description: 'Review a change.',
    content: 'Check the tests.',
  };
  const confirmation = {
    success: true,
    persisted: true,
    skillId: 'skill-1',
    name: input.name,
    scope: 'instance',
  };
  let client: Client;
  let server: typeof import('../index.js').roomoteMcpServer;

  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('ROOMOTE_CLOUD_TOKEN', 'member-task-token');
    vi.stubEnv('ROOMOTE_PLATFORM_API_URL', 'https://api.example.com');
    vi.stubEnv('ROOMOTE_AUTH_BYPASS_HEADER_NAME', '');
    vi.stubEnv('ROOMOTE_AUTH_BYPASS_VALUE', '');
    ({ roomoteMcpServer: server } = await import('../index.js'));
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'custom-skill-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('advertises only required name, description, and content fields', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find(({ name }) => name === 'create_custom_skill');
    expect(tool).toBeDefined();
    expect(Object.keys(tool!.inputSchema.properties!).sort()).toEqual([
      'content',
      'description',
      'name',
    ]);
    expect(tool!.inputSchema.required?.slice().sort()).toEqual([
      'content',
      'description',
      'name',
    ]);
    expect(tool!.inputSchema.additionalProperties).toBe(false);
  });

  it.each([
    { environmentIds: ['legacy-environment'] },
    { actorUserId: 'another-user' },
  ])(
    'rejects unadvertised arguments before fetching (case %#)',
    async (extra) => {
      const result = await client.callTool({
        name: 'create_custom_skill',
        arguments: { ...input, ...extra },
      });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('forwards parsed member input and returns only instance persistence confirmation', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...confirmation, token: 'private' })),
    );
    const result = await client.callTool({
      name: 'create_custom_skill',
      arguments: input,
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://api.example.com/api/mcp/custom-skills',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer member-task-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...input, content: `${input.content}\n` }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(confirmation, null, 2) },
    ]);
  });
});
