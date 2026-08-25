import {
  fastAgentTaskSearchArgsSchema,
  searchFastAgentTasks,
  sendFastAgentTaskMessage,
} from '../fast-agent-tasks';

describe('fast-agent task operations', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('validates native task search filters and pagination', () => {
    expect(
      fastAgentTaskSearchArgsSchema.parse({
        query: '  checkout  ',
        status: 'all',
        pullRequest: '__has_pr__',
        limit: 100,
        cursor: '  next-page  ',
      }),
    ).toEqual({
      query: 'checkout',
      status: 'all',
      pullRequest: '__has_pr__',
      limit: 100,
      cursor: 'next-page',
    });
    expect(() => fastAgentTaskSearchArgsSchema.parse({ limit: 101 })).toThrow();
    expect(() =>
      fastAgentTaskSearchArgsSchema.parse({ query: '   ' }),
    ).toThrow();
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
      {
        taskId: 'task-42',
        message: 'Also add a test.',
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
          senderMode: 'fast_agent',
        }),
      }),
    );
  });

  it('searches tasks with member authorization and forwards all filters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          tasks: [{ id: 'task-42', title: 'Fix checkout' }],
          hasMore: true,
          nextCursor: 'next-page',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      searchFastAgentTasks(
        {
          userId: 'user-1',
          apiBaseUrl: 'https://app.example.test/_roomote-api',
          getAuthToken: async () => 'auth-token',
        },
        {
          query: 'checkout',
          status: 'active',
          pullRequest: 'acme/app#42',
          limit: 10,
          cursor: 'current-page',
        },
      ),
    ).resolves.toEqual({
      tasks: [{ id: 'task-42', title: 'Fix checkout' }],
      hasMore: true,
      nextCursor: 'next-page',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(url)).toMatchObject({
      origin: 'https://app.example.test',
      pathname: '/_roomote-api/api/mcp/tasks',
    });
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({
      query: 'checkout',
      status: 'active',
      pullRequest: 'acme/app#42',
      limit: '10',
      cursor: 'current-page',
    });
    expect(init).toMatchObject({
      method: 'GET',
      headers: { Authorization: 'Bearer auth-token' },
    });
  });
});
