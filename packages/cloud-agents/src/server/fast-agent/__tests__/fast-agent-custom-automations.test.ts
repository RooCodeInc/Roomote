import { manageFastAgentCustomAutomations } from '../fast-agent-custom-automations';

describe('Fast custom automation operations', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the current Fast user token to list deployment automations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ automations: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      manageFastAgentCustomAutomations(
        {
          userId: 'user-1',
          apiBaseUrl: 'https://app.example.test/_roomote-api',
          getAuthToken: async () => 'user-auth-token',
        },
        { action: 'list' },
      ),
    ).resolves.toEqual({ automations: [] });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'https://app.example.test/_roomote-api/api/mcp/custom-automations',
      ),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer user-auth-token',
        }),
      }),
    );
  });

  it('forwards partial updates without changing omitted fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ automation: { id: 'automation-1', enabled: false } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await manageFastAgentCustomAutomations(
      {
        userId: 'user-1',
        apiBaseUrl: 'https://api.example.test',
        getAuthToken: async () => 'user-auth-token',
      },
      {
        action: 'update',
        automationId: 'automation/1',
        enabled: false,
        targetProvider: null,
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'https://api.example.test/api/mcp/custom-automations/automation%2F1',
      ),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ enabled: false, targetProvider: null }),
      }),
    );
  });

  it.each([
    {
      action: 'list_models' as const,
      expectedPath: '/api/mcp/custom-automations/models',
      expectedMethod: 'GET',
    },
    {
      action: 'resolve_schedule' as const,
      schedule: 'every weekday morning',
      expectedPath: '/api/mcp/custom-automations/resolve-schedule',
      expectedMethod: 'POST',
      expectedBody: { schedule: 'every weekday morning' },
    },
    {
      action: 'create' as const,
      name: 'Morning scan',
      prompt: 'Review recent failures.',
      schedule: 'daily',
      environmentId: 'environment-1',
      expectedPath: '/api/mcp/custom-automations',
      expectedMethod: 'POST',
      expectedBody: {
        name: 'Morning scan',
        prompt: 'Review recent failures.',
        schedule: 'daily',
        environmentId: 'environment-1',
      },
    },
    {
      action: 'delete' as const,
      automationId: 'automation-1',
      expectedPath: '/api/mcp/custom-automations/automation-1',
      expectedMethod: 'DELETE',
    },
    {
      action: 'run_now' as const,
      automationId: 'automation-1',
      expectedPath: '/api/mcp/custom-automations/automation-1/run',
      expectedMethod: 'POST',
    },
  ])(
    'routes $action through the existing custom automation API',
    async ({ expectedPath, expectedMethod, expectedBody, ...args }) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await manageFastAgentCustomAutomations(
        {
          userId: 'user-1',
          apiBaseUrl: 'https://api.example.test',
          getAuthToken: async () => 'user-auth-token',
        },
        args,
      );

      const [url, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.pathname).toBe(expectedPath);
      expect(request.method).toBe(expectedMethod);
      expect(request.body).toBe(
        expectedBody === undefined ? undefined : JSON.stringify(expectedBody),
      );
    },
  );

  it('preserves API authorization errors for non-admin Fast users', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Admin access required' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(
      manageFastAgentCustomAutomations(
        {
          userId: 'non-admin-user',
          apiBaseUrl: 'https://api.example.test',
          getAuthToken: async () => 'non-admin-token',
        },
        { action: 'list' },
      ),
    ).resolves.toEqual({ error: 'Admin access required' });
  });

  it('rejects ID-based actions before calling the API when the ID is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      manageFastAgentCustomAutomations(
        {
          userId: 'user-1',
          apiBaseUrl: 'https://api.example.test',
          getAuthToken: async () => 'user-auth-token',
        },
        { action: 'run_now' },
      ),
    ).resolves.toEqual({
      success: false,
      error: 'automationId is required for run_now',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
