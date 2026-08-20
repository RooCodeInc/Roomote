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
        body: JSON.stringify({ message: 'Also add a test.' }),
      }),
    );
  });

  it('uses the existing task API with a hidden conversation task filter', async () => {
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
      { action: 'search', query: 'checkout', status: 'active' },
      new Set(['task-1', 'task-2']),
    );

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.pathname).toBe('/_roomote-api/api/mcp/tasks');
    expect(calledUrl.searchParams.get('query')).toBe('checkout');
    expect(calledUrl.searchParams.get('status')).toBe('active');
    expect(calledUrl.searchParams.get('taskIds')).toBe('task-1,task-2');
  });

  it('merges bounded scoped searches in global activity order', async () => {
    const allowedTaskIds = new Set(
      Array.from({ length: 101 }, (_, index) => `task-${index}`),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tasks: [
              { id: 'task-1', lastMessageAt: 10 },
              { id: 'task-2', lastMessageAt: 30 },
            ],
            hasMore: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tasks: [{ id: 'task-100', lastMessageAt: 20 }],
            hasMore: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      inspectFastAgentTasks(
        {
          userId: 'user-1',
          apiBaseUrl: 'https://api.example.test',
          getAuthToken: async () => 'auth-token',
        },
        { action: 'search', limit: 2 },
        allowedTaskIds,
      ),
    ).resolves.toEqual({
      tasks: [
        { id: 'task-2', lastMessageAt: 30 },
        { id: 'task-100', lastMessageAt: 20 },
      ],
      hasMore: true,
      nextCursor: '20:task-100',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('searches conversations with more than 1,000 delegated tasks in bounded chunks', async () => {
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
        apiBaseUrl: 'https://api.example.test',
        getAuthToken: async () => 'auth-token',
      },
      { action: 'search' },
      new Set(Array.from({ length: 1001 }, (_, index) => `task-${index}`)),
    );

    expect(fetchMock).toHaveBeenCalledTimes(11);
    for (const [url] of fetchMock.mock.calls) {
      expect(
        new URL(url as string).searchParams.get('taskIds')!.split(',').length,
      ).toBeLessThanOrEqual(100);
    }
  });

  it.each(['get_summary', 'get_messages', 'get_compute_logs'] as const)(
    'rejects unlinked %s inspection before calling the task API',
    async (action) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        inspectFastAgentTasks(
          {
            userId: 'user-1',
            apiBaseUrl: 'https://api.example.test',
            getAuthToken: async () => 'auth-token',
          },
          { action, taskId: 'task-from-other-thread' },
          new Set(['task-1']),
        ),
      ).resolves.toEqual({
        success: false,
        error: 'That task was not delegated by this Fast conversation.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
