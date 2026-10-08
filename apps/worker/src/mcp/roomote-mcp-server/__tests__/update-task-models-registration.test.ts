import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('roomote MCP task model selection', () => {
  const fetchMock = vi.fn();
  let client: Client;
  let server: typeof import('../index.js').roomoteMcpServer;

  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('ROOMOTE_CLOUD_TOKEN', 'test-task-token');
    vi.stubEnv('ROOMOTE_PLATFORM_API_URL', 'https://api.example.com');
    vi.stubEnv('ROOMOTE_AUTH_BYPASS_HEADER_NAME', '');
    vi.stubEnv('ROOMOTE_AUTH_BYPASS_VALUE', '');
    ({ roomoteMcpServer: server } = await import('../index.js'));
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'model-selection-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('accepts the audioVideo role and forwards the selection to the API', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, application: 'deferred' })),
    );
    const result = await client.callTool({
      name: 'manage_tasks',
      arguments: {
        action: 'update_models',
        taskId: '0123456789abc',
        role: 'audioVideo',
        model: 'openrouter/media-model',
        reasoningEffort: 'low',
      },
    });

    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://api.example.com/api/mcp/tasks/0123456789abc/model_selection',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          role: 'audioVideo',
          model: 'openrouter/media-model',
          reasoningEffort: 'low',
        }),
      }),
    );
  });

  it('rejects an unknown role before calling the API', async () => {
    const result = await client.callTool({
      name: 'manage_tasks',
      arguments: {
        action: 'update_models',
        taskId: '0123456789abc',
        role: 'unknown-role',
      },
    });

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
