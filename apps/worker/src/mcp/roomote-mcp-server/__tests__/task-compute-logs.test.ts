import { handleGetTaskComputeLogs } from '../task-compute-logs.js';
import * as tasksApiClient from '../tasks-api-client.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../tasks-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://test-api.example.com',
};

describe('handleGetTaskComputeLogs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns structured cloud job log data on success', async () => {
    vi.mocked(tasksApiClient.getTaskComputeLogs).mockResolvedValueOnce({
      taskId: 'task-1',
      returned: 2,
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
        {
          id: 102,
          status: 'completed',
          vendor: 'modal',
          machineId: null,
          sandboxCmdId: null,
          output: null,
          skippedReason: 'missing_machine_id_and_sandbox_cmd_id',
          error: null,
        },
      ],
    });

    const result = await handleGetTaskComputeLogs({ taskId: 'task-1' }, config);
    const text = result.content[0]?.text ?? '';
    const payload = JSON.parse(text) as {
      success: boolean;
      taskId: string;
      returned: number;
      cloudJobs: Array<{ id: number; output: string | null }>;
    };

    expect(payload.success).toBe(true);
    expect(payload.taskId).toBe('task-1');
    expect(payload.returned).toBe(2);
    expect(payload.cloudJobs[0]?.output).toBe('boot output');
  });

  it('returns an error payload on failure', async () => {
    vi.mocked(tasksApiClient.getTaskComputeLogs).mockRejectedValueOnce(
      new Error('Task not found'),
    );

    const result = await handleGetTaskComputeLogs(
      { taskId: 'missing' },
      config,
    );
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('"success":false');
    expect(text).toContain('Task not found');
  });
});
