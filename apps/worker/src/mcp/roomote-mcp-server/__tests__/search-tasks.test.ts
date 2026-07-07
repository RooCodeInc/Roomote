import { handleSearchTasks } from '../search-tasks.js';
import * as tasksApiClient from '../tasks-api-client.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../tasks-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://test-api.example.com',
};

describe('handleSearchTasks', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns formatted text when tasks are found', async () => {
    vi.mocked(tasksApiClient.searchTasks).mockResolvedValueOnce({
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
    });

    const result = await handleSearchTasks({ query: 'bug' }, config);

    expect(result.content[0]?.type).toBe('text');
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Found 1 task(s)');
    expect(text).toContain('Fix bug');
    expect(text).toContain('[Working]');
    expect(text).toContain('task-1');
    expect(text).toContain('repo: owner/repo');
    expect(text).toContain('harness: OpenCode');
    expect(text).not.toContain('cost:');
  });

  it('returns a message when no tasks found', async () => {
    vi.mocked(tasksApiClient.searchTasks).mockResolvedValueOnce({
      tasks: [],
      hasMore: false,
    });

    const result = await handleSearchTasks({}, config);

    expect(result.content[0]?.text).toContain('No tasks found');
  });

  it('includes next cursor when more results are available', async () => {
    vi.mocked(tasksApiClient.searchTasks).mockResolvedValueOnce({
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
          cloudJobStatus: 'pending',
          taskPhase: null,
          cloudJobError: null,
        },
      ],
      hasMore: true,
      nextCursor: '1699999999:task-2',
    });

    const result = await handleSearchTasks(
      {
        pullRequest: 'owner/repo#42',
        cursor: '1700000000:task-1',
      },
      config,
    );

    expect(vi.mocked(tasksApiClient.searchTasks)).toHaveBeenCalledWith(config, {
      query: undefined,
      pullRequest: 'owner/repo#42',
      status: undefined,
      limit: undefined,
      cursor: '1700000000:task-1',
    });
    expect(result.content[0]?.text).toContain('more available');
    expect(result.content[0]?.text).toContain('Next cursor: 1699999999');
    expect(result.content[0]?.text).toContain('[Pending]');
  });

  it('includes startup failures in the formatted output', async () => {
    vi.mocked(tasksApiClient.searchTasks).mockResolvedValueOnce({
      tasks: [
        {
          id: 'task-2',
          title: 'Inspect environment',
          mode: 'standard',
          completed: false,
          repositoryName: 'owner/repo',
          harness: 'opencode-server',
          createdAt: 1700001000,
          lastMessageAt: 1700001000,
          cloudJobStatus: 'failed',
          taskPhase: null,
          cloudJobError: 'Sandbox startup timed out',
        },
      ],
      hasMore: false,
    });

    const result = await handleSearchTasks({ status: 'active' }, config);

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('[Failed]');
    expect(text).toContain('error: Sandbox startup timed out');
  });

  it('returns error on failure', async () => {
    vi.mocked(tasksApiClient.searchTasks).mockRejectedValueOnce(
      new Error('Network error'),
    );

    const result = await handleSearchTasks({}, config);

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Network error');
    expect(text).toContain('"success":false');
  });
});
