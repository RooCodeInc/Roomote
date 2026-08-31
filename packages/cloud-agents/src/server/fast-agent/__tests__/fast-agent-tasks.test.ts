import {
  sendFastAgentTaskMessage,
  sendFastAgentTaskMessageOnce,
} from '../fast-agent-tasks';

describe('fast-agent task operations', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('steers messages with images through a reverse-proxy pathname', async () => {
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
      {
        taskId: 'task-42',
        message: 'Also add a test.',
        images: [
          'data:image/png;base64,c2NyZWVuc2hvdC0x',
          'data:image/webp;base64,c2NyZWVuc2hvdC0y',
        ],
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://app.example.test/_roomote-api/api/mcp/tasks/task-42/steer_message',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer auth-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          message: 'Also add a test.',
          images: [
            'data:image/png;base64,c2NyZWVuc2hvdC0x',
            'data:image/webp;base64,c2NyZWVuc2hvdC0y',
          ],
          senderMode: 'fast_agent',
        }),
      }),
    );
  });

  it('sends retry-safe task messages with a stable client id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await sendFastAgentTaskMessageOnce(
      {
        userId: 'user-1',
        apiBaseUrl: 'https://app.example.test/_roomote-api',
        getAuthToken: async () => 'auth-token',
      },
      {
        taskId: 'task-42',
        message: 'Resolve the review feedback.',
        clientMessageId: 'pr-review-delivery:delivery-1',
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://app.example.test/_roomote-api/api/mcp/tasks/task-42/send_message',
      expect.objectContaining({
        body: JSON.stringify({
          message: 'Resolve the review feedback.',
          clientMessageId: 'pr-review-delivery:delivery-1',
        }),
      }),
    );
  });
});
