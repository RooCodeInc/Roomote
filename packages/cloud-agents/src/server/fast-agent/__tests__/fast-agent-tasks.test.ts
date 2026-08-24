import {
  inspectFastAgentTasks,
  sendFastAgentTaskMessage,
} from '../fast-agent-tasks';

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
        body: JSON.stringify({
          message: 'Also add a test.',
          senderMode: 'fast_agent',
        }),
      }),
    );
  });

  it('searches deployment tasks through the existing task API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tasks: [], hasMore: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await inspectFastAgentTasks(
      {
        userId: 'user-1',
        apiBaseUrl: 'https://app.example.test/_roomote-api',
        getAuthToken: async () => 'auth-token',
      },
      {
        action: 'search',
        query: 'checkout',
        status: 'active',
        pullRequest: 'acme/app#42',
        limit: 25,
        cursor: '100:task-1',
      },
    );

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.pathname).toBe('/_roomote-api/api/mcp/tasks');
    expect(calledUrl.searchParams.get('query')).toBe('checkout');
    expect(calledUrl.searchParams.get('status')).toBe('active');
    expect(calledUrl.searchParams.get('pullRequest')).toBe('acme/app#42');
    expect(calledUrl.searchParams.get('limit')).toBe('25');
    expect(calledUrl.searchParams.get('cursor')).toBe('100:task-1');
    expect(calledUrl.searchParams.has('taskIds')).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['get_summary', 'summary'],
    ['get_messages', 'messages'],
    ['get_compute_logs', 'compute_logs'],
  ] as const)(
    'passes deployment task %s reads through to the existing API',
    async (action, path) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'task-from-another-conversation' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await inspectFastAgentTasks(
        {
          userId: 'user-1',
          apiBaseUrl: 'https://api.example.test',
          getAuthToken: async () => 'auth-token',
        },
        { action, taskId: 'task-from-another-conversation', limit: 5 },
      );

      const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
      expect(calledUrl.pathname).toBe(
        `/api/mcp/tasks/task-from-another-conversation/${path}`,
      );
      if (action === 'get_messages') {
        expect(calledUrl.searchParams.get('limit')).toBe('5');
        expect(calledUrl.searchParams.get('order')).toBe('desc');
      } else {
        expect(calledUrl.search).toBe('');
      }
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('returns normal task API authorization errors unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      inspectFastAgentTasks(
        {
          userId: 'user-1',
          apiBaseUrl: 'https://api.example.test',
          getAuthToken: async () => 'auth-token',
        },
        { action: 'get_summary', taskId: 'hidden-task' },
      ),
    ).resolves.toEqual({ error: 'Task not found' });
  });
});
