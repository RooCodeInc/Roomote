import { ALL_REPOSITORIES } from '@roomote/types';

import { handleLaunchTask } from '../launch-task.js';
import * as tasksApiClient from '../tasks-api-client.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../tasks-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://test-api.example.com',
};

describe('handleLaunchTask', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should return success result with job and task IDs', async () => {
    vi.mocked(tasksApiClient.launchTask).mockResolvedValueOnce({
      success: true,
      runId: 99,
      taskId: 'task-new',
    });

    const result = await handleLaunchTask(
      {
        prompt: 'Fix the tests',
        environmentId: '10b031ec-b728-4d8f-a9a0-1ed4aa500511',
      },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(true);
    expect(parsed.runId).toBe(99);
    expect(parsed.taskId).toBe('task-new');
    expect(vi.mocked(tasksApiClient.launchTask)).toHaveBeenCalledWith(config, {
      prompt: 'Fix the tests',
      repo: ALL_REPOSITORIES,
      branch: undefined,
      environmentId: '10b031ec-b728-4d8f-a9a0-1ed4aa500511',
      type: 'standard',
    });
  });

  it('uses the implicit Generalist path for standard launches', async () => {
    vi.mocked(tasksApiClient.launchTask).mockResolvedValueOnce({
      success: true,
      runId: 100,
      taskId: 'task-generalist',
    });

    const result = await handleLaunchTask(
      {
        prompt: 'Investigate this',
        environmentId: '10b031ec-b728-4d8f-a9a0-1ed4aa500511',
      },
      config,
    );

    expect(tasksApiClient.launchTask).toHaveBeenCalledWith(config, {
      branch: undefined,
      environmentId: '10b031ec-b728-4d8f-a9a0-1ed4aa500511',
      prompt: 'Investigate this',
      repo: ALL_REPOSITORIES,
      type: 'standard',
    });

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(true);
    expect(parsed.taskId).toBe('task-generalist');
  });

  it('should return error when API returns success=false', async () => {
    vi.mocked(tasksApiClient.launchTask).mockResolvedValueOnce({
      success: false,
      error: 'Agent not found',
    });

    const result = await handleLaunchTask(
      {
        prompt: 'test',
        environmentId: '10b031ec-b728-4d8f-a9a0-1ed4aa500511',
      },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Agent not found');
  });

  it('should return error on exception', async () => {
    vi.mocked(tasksApiClient.launchTask).mockRejectedValueOnce(
      new Error('Connection refused'),
    );

    const result = await handleLaunchTask(
      { prompt: 'b', environmentId: '10b031ec-b728-4d8f-a9a0-1ed4aa500511' },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Connection refused');
  });

  it('maps the all-repositories sentinel to an org-wide launch', async () => {
    vi.mocked(tasksApiClient.launchTask).mockResolvedValueOnce({
      success: true,
      runId: 42,
      taskId: 'task-org-wide',
    });

    await handleLaunchTask(
      { prompt: 'Run this everywhere', environmentId: ALL_REPOSITORIES },
      config,
    );

    expect(vi.mocked(tasksApiClient.launchTask)).toHaveBeenCalledWith(config, {
      prompt: 'Run this everywhere',
      repo: ALL_REPOSITORIES,
      branch: undefined,
      environmentId: undefined,
      type: 'standard',
    });
  });
});
