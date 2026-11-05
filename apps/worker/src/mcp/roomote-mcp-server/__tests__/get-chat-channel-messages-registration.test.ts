import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('sandbox channel history continuation', () => {
  const fetchMock = vi.fn();
  let client: Client;
  let server: typeof import('../index.js').roomoteMcpServer;

  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('ROOMOTE_CLOUD_TOKEN', 'test-task-token');
    vi.stubEnv('ROOMOTE_FAST_AGENT_CHILD', 'false');
    vi.stubEnv('ROOMOTE_PLATFORM_API_URL', 'https://api.example.com');
    vi.stubEnv('ROOMOTE_AUTH_BYPASS_HEADER_NAME', '');
    vi.stubEnv('ROOMOTE_AUTH_BYPASS_VALUE', '');
    ({ roomoteMcpServer: server } = await import('../index.js'));
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'channel-history-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('advertises the root-history bound on the actual sandbox tool', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find(({ name }) => name === 'get_chat_channel_messages');
    expect(tool?.inputSchema.properties).toHaveProperty('historyLatest');
  });

  it('round-trips a history continuation to the API without narrowing the reply upper bound', async () => {
    const firstPage = {
      provider: 'slack',
      channelId: 'C123',
      messageCount: 0,
      messages: [],
      truncated: true,
      historyContinuation: {
        oldest: '100',
        latest: '300',
        historyLatest: '200',
      },
      note: 'Continue reading older roots with the original reply window.',
    };
    const nextPage = {
      provider: 'slack',
      channelId: 'C123',
      messageCount: 1,
      messages: [
        {
          provider: 'slack',
          id: '250',
          threadId: '150',
          user: 'U1',
          text: 'reply on an older root',
          channelId: 'C123',
          fileCount: 0,
        },
      ],
    };
    fetchMock
      .mockResolvedValueOnce(Response.json(firstPage))
      .mockResolvedValueOnce(Response.json(nextPage));

    const first = await client.callTool({
      name: 'get_chat_channel_messages',
      arguments: { channel: 'C123', oldest: '100', latest: '300' },
    });
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toEqual(firstPage);
    const continuation = (first.structuredContent as typeof firstPage)
      .historyContinuation;
    const next = await client.callTool({
      name: 'get_chat_channel_messages',
      arguments: { channel: ' C123 ', ...continuation },
    });

    expect(next.isError, JSON.stringify(next.content)).not.toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.example.com/api/mcp/communication/channel_messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          channel: 'C123',
          oldest: '100',
          latest: '300',
          historyLatest: '200',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(next.structuredContent).toEqual(nextPage);
  });

  it.each([' 200 ', '', null])(
    'normalizes optional historyLatest=%j before the HTTP boundary',
    async (historyLatest) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          provider: 'slack',
          channelId: 'C123',
          messageCount: 0,
          messages: [],
        }),
      );
      const result = await client.callTool({
        name: 'get_chat_channel_messages',
        arguments: { oldest: '100', latest: '300', historyLatest },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        'https://api.example.com/api/mcp/communication/channel_messages',
        expect.objectContaining({
          body: JSON.stringify({
            oldest: '100',
            latest: '300',
            ...(historyLatest?.trim() ? { historyLatest: '200' } : {}),
          }),
        }),
      );
    },
  );
});
