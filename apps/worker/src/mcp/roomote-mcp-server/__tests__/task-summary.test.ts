import { handleGetTaskSummary } from '../task-summary.js';
import * as tasksApiClient from '../tasks-api-client.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../tasks-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://test-api.example.com',
};

describe('handleGetTaskSummary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns a cleaned-up task summary', async () => {
    vi.mocked(tasksApiClient.getTaskSummary).mockResolvedValueOnce({
      id: 'task-1',
      title: 'Fix bug',
      mode: 'code',
      completed: false,
      repositoryName: 'owner/repo',
      harness: 'opencode-server',
      createdAt: 1700000000,
      taskRunStatus: 'running',
      taskPhase: 'waiting_for_prompt',
      taskRunError: null,
      linkedEnvironmentId: null,
      linkedEnvironmentName: null,
    });

    const result = await handleGetTaskSummary({ taskId: 'task-1' }, config);

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Task: Fix bug');
    expect(text).toContain('ID: task-1');
    expect(text).toContain('Status: Ready');
    expect(text).toContain('Mode: code');
    expect(text).toContain('Harness: OpenCode');
    expect(text).toContain('Repository: owner/repo');
    expect(text).not.toContain('Task Run Status:');
    expect(text).not.toContain('Task Run ID:');
    expect(text).not.toContain('Model:');
    expect(text).not.toContain('Cost:');
    expect(text).not.toContain('Tokens:');
    expect(text).not.toContain('Agent ID:');
  });

  it('includes linked environment fields when the API response provides them', async () => {
    vi.mocked(tasksApiClient.getTaskSummary).mockResolvedValueOnce({
      id: 'task-4',
      title: 'Environment setup',
      mode: 'standard',
      completed: false,
      repositoryName: 'owner/repo',
      harness: 'opencode-server',
      createdAt: 1700000000,
      taskRunStatus: 'running',
      taskPhase: 'executing',
      taskRunError: null,
      linkedEnvironmentId: 'env-123',
      linkedEnvironmentName: 'Onboarding Sandbox',
    });

    const result = await handleGetTaskSummary({ taskId: 'task-4' }, config);

    expect(result.content[0]?.text).toContain(
      'Linked Environment: Onboarding Sandbox',
    );
    expect(result.content[0]?.text).toContain('Linked Environment ID: env-123');
  });

  it('falls back to completed/active when no task run data is present', async () => {
    vi.mocked(tasksApiClient.getTaskSummary).mockResolvedValueOnce({
      id: 'task-2',
      title: 'Done task',
      mode: null,
      completed: true,
      repositoryName: null,
      harness: 'opencode-server',
      createdAt: null,
      taskRunStatus: null,
      taskPhase: null,
      taskRunError: null,
      linkedEnvironmentId: null,
      linkedEnvironmentName: null,
    });

    const result = await handleGetTaskSummary({ taskId: 'task-2' }, config);

    expect(result.content[0]?.text).toContain('Status: Completed');
  });

  it('includes the latest task run error when present', async () => {
    vi.mocked(tasksApiClient.getTaskSummary).mockResolvedValueOnce({
      id: 'task-3',
      title: 'Broken startup',
      mode: 'standard',
      completed: false,
      repositoryName: 'owner/repo',
      harness: 'opencode-server',
      createdAt: 1700000000,
      taskRunStatus: 'failed',
      taskPhase: null,
      taskRunError: 'Sandbox failed to boot worker process',
      linkedEnvironmentId: null,
      linkedEnvironmentName: null,
    });

    const result = await handleGetTaskSummary({ taskId: 'task-3' }, config);

    expect(result.content[0]?.text).toContain('Status: Failed');
    expect(result.content[0]?.text).toContain(
      'Error: Sandbox failed to boot worker process',
    );
  });

  it('returns error on failure', async () => {
    vi.mocked(tasksApiClient.getTaskSummary).mockRejectedValueOnce(
      new Error('Not found'),
    );

    const result = await handleGetTaskSummary({ taskId: 'bad' }, config);

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Not found');
    expect(text).toContain('"success":false');
  });
});
