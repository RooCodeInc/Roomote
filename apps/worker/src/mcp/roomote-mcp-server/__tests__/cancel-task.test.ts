import { handleCancelTask } from '../cancel-task.js';
import * as tasksApiClient from '../tasks-api-client.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../tasks-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://test-api.example.com',
};

describe('handleCancelTask', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should return success when task is canceled', async () => {
    vi.mocked(tasksApiClient.cancelTask).mockResolvedValueOnce({
      success: true,
    });

    const result = await handleCancelTask({ taskId: 'task-1' }, config);

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toContain('task-1');
  });

  it('should return error when API returns success=false', async () => {
    vi.mocked(tasksApiClient.cancelTask).mockResolvedValueOnce({
      success: false,
      error: 'Task is already completed',
    });

    const result = await handleCancelTask({ taskId: 'task-1' }, config);

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Task is already completed');
  });

  it('should return error on exception', async () => {
    vi.mocked(tasksApiClient.cancelTask).mockRejectedValueOnce(
      new Error('Connection refused'),
    );

    const result = await handleCancelTask({ taskId: 'task-1' }, config);

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Connection refused');
  });
});
