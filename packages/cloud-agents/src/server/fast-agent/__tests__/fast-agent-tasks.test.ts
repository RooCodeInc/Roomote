import { sendFastAgentTaskMessage } from '../fast-agent-tasks';

describe('fast-agent task operations', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('steers messages to active tasks through a reverse-proxy pathname', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await sendFastAgentTaskMessage(
      {
        userId: 'user-1',
        apiBaseUrl: 'https://app.example.test/_roomote-api',
        getAuthToken: async () => 'auth-token',
      },
      { taskId: 'task-42', message: 'Also add a test.' },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://app.example.test/_roomote-api/api/mcp/tasks/task-42/steer_message',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer auth-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ message: 'Also add a test.' }),
      }),
    );
  });
});
