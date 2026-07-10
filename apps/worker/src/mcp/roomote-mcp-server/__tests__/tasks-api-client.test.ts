import {
  describeVideo,
  searchTasks,
  getTaskComputeLogs,
  getTaskMessages,
  getTaskSummary,
  launchTask,
  cancelTask,
  stopTask,
  submitAutomationWorkItems,
  createEnvironment,
  updateEnvironment,
  submitTaskSuggestions,
} from '../tasks-api-client.js';
import type { RoomoteConfig } from '../types.js';

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://test-api.example.com',
};

describe('searchTasks', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should call the search endpoint and return results', async () => {
    const mockResponse = {
      tasks: [
        {
          id: 'task-1',
          title: 'Fix bug',
          mode: 'code',
          completed: false,
          repositoryName: 'owner/repo',
          harness: 'opencode-server',
          createdAt: 1700000000,
          lastMessageAt: 1700000000,
          cloudJobStatus: 'running',
          taskPhase: 'running',
          cloudJobError: null,
        },
      ],
      hasMore: false,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await searchTasks(config, { query: 'bug' });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.title).toBe('Fix bug');
    expect(result.hasMore).toBe(false);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall?.[0]).toContain('/api/mcp/tasks');
    expect(fetchCall?.[0]).toContain('query=bug');
  });

  it('should pass all filter params as query string', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ tasks: [], hasMore: false }),
    });

    await searchTasks(config, {
      query: 'test',
      pullRequest: 'owner/repo#42',
      status: 'active',
      limit: 10,
      cursor: '1700000000:task-abc',
    });

    const url = vi.mocked(fetch).mock.calls[0]?.[0] as string;
    expect(url).toContain('query=test');
    expect(url).toContain('pullRequest=owner%2Frepo%2342');
    expect(url).toContain('status=active');
    expect(url).toContain('limit=10');
    expect(url).toContain('cursor=1700000000%3Atask-abc');
  });

  it('adds the preview bypass header when configured', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ tasks: [], hasMore: false }),
    });

    await searchTasks(
      {
        ...config,
        authBypassHeaderName: 'x-custom-bypass',
        authBypassHeaderValue: 'bypass-token',
      },
      {},
    );

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'x-custom-bypass': 'bypass-token',
        }),
      }),
    );
  });

  it('should throw on non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: 'Server error' }),
    });

    await expect(searchTasks(config, {})).rejects.toThrow(
      'Failed to search tasks: 500 Server error',
    );
  });
});

describe('getTaskSummary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should call the summary endpoint and return result', async () => {
    const mockResponse = {
      id: 'task-1',
      title: 'Fix bug',
      mode: 'code',
      completed: true,
      repositoryName: 'owner/repo',
      harness: 'opencode-server',
      createdAt: 1700000000,
      cloudJobStatus: 'completed',
      taskPhase: null,
      cloudJobError: null,
      linkedEnvironmentId: 'env-1',
      linkedEnvironmentName: 'Roomote App',
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await getTaskSummary(config, 'task-1');

    expect(result.id).toBe('task-1');
    expect(result.completed).toBe(true);
    expect(result.cloudJobStatus).toBe('completed');
    expect(result.linkedEnvironmentId).toBe('env-1');
    expect(result.linkedEnvironmentName).toBe('Roomote App');

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall?.[0]).toContain('/api/mcp/tasks/task-1/summary');
  });

  it('should throw on non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'Task not found' }),
    });

    await expect(getTaskSummary(config, 'task-bad')).rejects.toThrow(
      'Failed to get task summary: 404 Task not found',
    );
  });
});

describe('describeVideo', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts the video payload to the describe endpoint', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ description: 'The UI opens a settings modal.' }),
    });

    const result = await describeVideo(config, 'task-1', {
      videoBytes: 'YmFzZTY0LXZpZGVv',
      mimeType: 'video/mp4',
      userTextContext: 'Look for the failure toast.',
    });

    expect(result.description).toBe('The UI opens a settings modal.');
    expect(fetch).toHaveBeenCalledWith(
      'https://test-api.example.com/api/mcp/tasks/task-1/describe_video',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          videoBytes: 'YmFzZTY0LXZpZGVv',
          mimeType: 'video/mp4',
          userTextContext: 'Look for the failure toast.',
        }),
      }),
    );
  });

  it('throws a prefixed error on failed describe requests', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 413,
      text: async () => JSON.stringify({ error: 'Video too large' }),
    });

    await expect(
      describeVideo(config, 'task-1', {
        videoBytes: 'YmFk',
        mimeType: 'video/mp4',
      }),
    ).rejects.toThrow('Failed to describe video: 413 Video too large');
  });
});

describe('submitAutomationWorkItems', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts automation work items to the automation_work_items endpoint', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        workItemCount: 1,
        suggestionCount: 0,
        actedCount: 1,
        launchedCount: 1,
      }),
    });

    const result = await submitAutomationWorkItems(config, 'task-1', {
      workItems: [
        {
          title: 'Fix parser nil access',
          brief: 'Nil access is driving a production Sentry issue.',
          category: 'bug',
          priority: 'P1',
          actionKind: 'code_change_pr',
          disposition: 'act',
          investigationContext: '$sentry-triage\nIssue: SENTRY-123',
          executionPrompt:
            'Reproduce the nil access, fix it, add regression coverage, and open a PR.',
          targetRepositoryFullName: 'owner/repo',
        },
      ],
    });

    expect(result.workItemCount).toBe(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://test-api.example.com/api/mcp/tasks/task-1/automation_work_items',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          workItems: [
            {
              title: 'Fix parser nil access',
              brief: 'Nil access is driving a production Sentry issue.',
              category: 'bug',
              priority: 'P1',
              actionKind: 'code_change_pr',
              disposition: 'act',
              investigationContext: '$sentry-triage\nIssue: SENTRY-123',
              executionPrompt:
                'Reproduce the nil access, fix it, add regression coverage, and open a PR.',
              targetRepositoryFullName: 'owner/repo',
            },
          ],
        }),
      }),
    );
  });
});

describe('getTaskComputeLogs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should call the cloud job logs endpoint and return result', async () => {
    const mockResponse = {
      taskId: 'task-1',
      returned: 1,
      cloudJobs: [
        {
          id: 101,
          status: 'failed',
          vendor: 'modal',
          machineId: 'sandbox-1',
          sandboxCmdId: 'cmd-1',
          output: 'boot output',
          skippedReason: null,
          error: null,
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await getTaskComputeLogs(config, 'task-1');

    expect(result.taskId).toBe('task-1');
    expect(result.returned).toBe(1);
    expect(result.cloudJobs[0]?.output).toBe('boot output');

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall?.[0]).toContain('/api/mcp/tasks/task-1/compute_logs');
  });

  it('should throw on non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'Task not found' }),
    });

    await expect(getTaskComputeLogs(config, 'task-bad')).rejects.toThrow(
      'Failed to get task compute logs: 404 Task not found',
    );
  });
});

describe('getTaskMessages', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should call the messages endpoint and return result', async () => {
    const mockResponse = {
      messages: [
        {
          id: 'msg-1',
          taskId: 'task-1',
          ts: 1700000000,
          eventType: 'roomote_runtime.assistant_text',
          role: 'assistant',
          text: 'hello',
          images: [],
          metadata: {},
        },
      ],
      returned: 1,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await getTaskMessages(config, 'task-1', {
      limit: 5,
      order: 'desc',
    });

    expect(result.returned).toBe(1);
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall?.[0]).toContain('/api/mcp/tasks/task-1/messages');
    expect(fetchCall?.[0]).toContain('limit=5');
    expect(fetchCall?.[0]).toContain('order=desc');
  });

  it('should throw on non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'Task not found' }),
    });

    await expect(getTaskMessages(config, 'task-bad')).rejects.toThrow(
      'Failed to get task messages: 404 Task not found',
    );
  });
});

describe('launchTask', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should call POST /api/mcp/tasks and return result', async () => {
    const mockResponse = {
      success: true,
      cloudJobId: 99,
      taskId: 'task-new',
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await launchTask(config, {
      prompt: 'Fix the tests',
      repo: '__all_repositories__',
      environmentId: '10b031ec-b728-4d8f-a9a0-1ed4aa500511',
      type: 'standard',
    });

    expect(result.success).toBe(true);
    expect(result.cloudJobId).toBe(99);
    expect(result.taskId).toBe('task-new');

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall?.[0]).toBe('https://test-api.example.com/api/mcp/tasks');
    expect(fetchCall?.[1]?.method).toBe('POST');

    const body = JSON.parse(fetchCall?.[1]?.body as string);
    expect(body.prompt).toBe('Fix the tests');
    expect(body.repo).toBe('__all_repositories__');
    expect(body.environmentId).toBe('10b031ec-b728-4d8f-a9a0-1ed4aa500511');
    expect(body.type).toBe('standard');
  });

  it('sends a minimal standard launch payload for implicit Generalist tasks', async () => {
    const mockResponse = {
      success: true,
      cloudJobId: 100,
      taskId: 'task-generalist',
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await launchTask(config, {
      prompt: 'Investigate this',
      type: 'standard',
    });

    expect(result.success).toBe(true);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall?.[1]?.body as string);
    expect(body.prompt).toBe('Investigate this');
    expect(body.type).toBe('standard');
  });

  it('passes extended programmatic launch fields through unchanged', async () => {
    const mockResponse = {
      success: true,
      cloudJobId: 101,
      taskId: 'task-env-def',
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    await launchTask(config, {
      type: 'environment-definition',
      repositoryFullNames: ['acme/web', 'acme/api'],
      setupGuidance: 'Start the API and worker services.',
      hidden: true,
      computeProvider: 'modal',
      harness: 'opencode-server',
      bootstrap: {
        skill: 'plan-repo-implementation',
        interactiveMode: true,
      },
    });

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall?.[1]?.body as string);
    expect(body).toMatchObject({
      type: 'environment-definition',
      repositoryFullNames: ['acme/web', 'acme/api'],
      setupGuidance: 'Start the API and worker services.',
      hidden: true,
      computeProvider: 'modal',
      harness: 'opencode-server',
      bootstrap: {
        skill: 'plan-repo-implementation',
        interactiveMode: true,
      },
    });
  });

  it('should throw on non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: 'Forbidden' }),
    });

    await expect(launchTask(config, { prompt: 'b' })).rejects.toThrow(
      'Failed to launch task: 403 Forbidden',
    );
  });
});

describe('submitTaskSuggestions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should POST task suggestions including hidden investigation context', async () => {
    const mockResponse = {
      success: true,
      suggestionCount: 1,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await submitTaskSuggestions(config, 'task-123', {
      suggestions: [
        {
          title: 'Fix cron retries',
          brief: 'Retry metadata is dropped when rebuilding the payload.',
          priority: 'P1',
          investigationContext:
            'apps/api/src/jobs/retry.ts:92 drops the persisted retry delay.',
          targetRepositoryFullName: 'acme/app',
          targetEnvironmentId: '10b031ec-b728-4d8f-a9a0-1ed4aa500511',
          workspaceReadiness: 'environment_backed',
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.suggestionCount).toBe(1);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall?.[0]).toBe(
      'https://test-api.example.com/api/mcp/tasks/task-123/task_suggestions',
    );
    expect(fetchCall?.[1]?.method).toBe('POST');

    const body = JSON.parse(fetchCall?.[1]?.body as string);
    expect(body).toEqual({
      suggestions: [
        {
          title: 'Fix cron retries',
          brief: 'Retry metadata is dropped when rebuilding the payload.',
          priority: 'P1',
          investigationContext:
            'apps/api/src/jobs/retry.ts:92 drops the persisted retry delay.',
          targetRepositoryFullName: 'acme/app',
          targetEnvironmentId: '10b031ec-b728-4d8f-a9a0-1ed4aa500511',
          workspaceReadiness: 'environment_backed',
        },
      ],
    });
  });
});

describe('cancelTask', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should call POST /api/mcp/tasks/:taskId/cancel and return result', async () => {
    const mockResponse = { success: true };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await cancelTask(config, 'task-123');

    expect(result.success).toBe(true);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall?.[0]).toBe(
      'https://test-api.example.com/api/mcp/tasks/task-123/cancel',
    );
    expect(fetchCall?.[1]?.method).toBe('POST');
  });

  it('should throw on non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'Task not found' }),
    });

    await expect(cancelTask(config, 'task-bad')).rejects.toThrow(
      'Failed to cancel task: 404 Task not found',
    );
  });
});

describe('stopTask', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should call POST /api/mcp/tasks/:taskId/stop and return result', async () => {
    const mockResponse = { success: true };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await stopTask(config, 'task-123');

    expect(result.success).toBe(true);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall?.[0]).toBe(
      'https://test-api.example.com/api/mcp/tasks/task-123/stop',
    );
    expect(fetchCall?.[1]?.method).toBe('POST');
  });

  it('should throw on non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'Task not found' }),
    });

    await expect(stopTask(config, 'task-bad')).rejects.toThrow(
      'Failed to stop task: 404 Task not found',
    );
  });
});

describe('createEnvironment', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should call POST /api/mcp/environments and return result', async () => {
    const mockResponse = {
      success: true,
      environmentId: 'env-123',
      name: 'My Project',
      missingRepositories: [],
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await createEnvironment(config, {
      config: {
        name: 'My Project',
        repositories: [{ repository: 'owner/repo' }],
      },
    });

    expect(result.success).toBe(true);
    expect(result.environmentId).toBe('env-123');
    expect(result.name).toBe('My Project');
    expect(result.missingRepositories).toEqual([]);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall?.[0]).toBe(
      'https://test-api.example.com/api/mcp/environments',
    );
    expect(fetchCall?.[1]?.method).toBe('POST');

    const body = JSON.parse(fetchCall?.[1]?.body as string);
    expect(body).toEqual({
      config: {
        name: 'My Project',
        repositories: [{ repository: 'owner/repo' }],
      },
    });
  });

  it('should throw on non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: 'Environment already exists' }),
    });

    await expect(
      createEnvironment(config, {
        config: {
          name: 'My Project',
          repositories: [{ repository: 'owner/repo' }],
        },
      }),
    ).rejects.toThrow(
      'Failed to create environment: 409 Environment already exists',
    );
  });
});

describe('updateEnvironment', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should call PATCH /api/mcp/environments/:id and return result', async () => {
    const mockResponse = {
      success: true,
      environmentId: 'env-123',
      name: 'Updated Project',
      missingRepositories: [],
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await updateEnvironment(config, {
      environmentId: 'env-123',
      config: {
        name: 'Updated Project',
        repositories: [{ repository: 'owner/repo' }],
      },
    });

    expect(result.success).toBe(true);
    expect(result.environmentId).toBe('env-123');
    expect(result.name).toBe('Updated Project');

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall?.[0]).toBe(
      'https://test-api.example.com/api/mcp/environments/env-123',
    );
    expect(fetchCall?.[1]?.method).toBe('PATCH');

    const body = JSON.parse(fetchCall?.[1]?.body as string);
    expect(body).toEqual({
      config: {
        name: 'Updated Project',
        repositories: [{ repository: 'owner/repo' }],
      },
    });
  });

  it('should throw on non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'Environment not found' }),
    });

    await expect(
      updateEnvironment(config, {
        environmentId: 'env-missing',
        config: {
          name: 'Updated Project',
          repositories: [{ repository: 'owner/repo' }],
        },
      }),
    ).rejects.toThrow(
      'Failed to update environment: 404 Environment not found',
    );
  });
});

describe('manageSourceControl timeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ROOMOTE_MCP_PLATFORM_API_TIMEOUT_MS;
  });

  it('fails as a retryable tool error instead of hanging when the API stalls', async () => {
    // Regression: create_or_update_pull_request calls hung for over an hour
    // when the API stopped responding mid-request; the bare fetch had no
    // deadline, so the MCP tool call — and with it the whole task turn —
    // wedged until a human stopped the task.
    process.env.ROOMOTE_MCP_PLATFORM_API_TIMEOUT_MS = '25';
    global.fetch = vi.fn((_url: unknown, options?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () =>
          reject((options.signal as AbortSignal).reason),
        );
      });
    }) as unknown as typeof fetch;

    const { manageSourceControl } = await import('../tasks-api-client.js');

    await expect(
      manageSourceControl(config, 'task-1', {
        action: 'create_or_update_pull_request',
        repositoryFullName: 'owner/repo',
        sourceBranch: 'feature/x',
        targetBranch: 'develop',
        title: 'Test PR',
        body: 'Body',
      }),
    ).rejects.toThrow(
      'Failed to manage source control: no response from the Roomote API within 25ms; the request was aborted and is safe to retry.',
    );
  });
});
