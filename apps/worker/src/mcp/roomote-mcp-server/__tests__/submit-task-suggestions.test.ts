import { handleSubmitTaskSuggestions } from '../submit-task-suggestions.js';
import * as tasksApiClient from '../tasks-api-client.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../tasks-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://test-api.example.com',
};

describe('handleSubmitTaskSuggestions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('forwards investigation context to the platform API client', async () => {
    vi.mocked(tasksApiClient.submitTaskSuggestions).mockResolvedValueOnce({
      success: true,
      suggestionCount: 1,
    });

    const result = await handleSubmitTaskSuggestions(
      {
        taskId: 'task-123',
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
      },
      config,
    );

    expect(tasksApiClient.submitTaskSuggestions).toHaveBeenCalledWith(
      config,
      'task-123',
      {
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
      },
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(true);
    expect(parsed.suggestionCount).toBe(1);
  });
});
