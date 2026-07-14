import {
  awaitTaskSettlement,
  classifySettledSummary,
  handleAwaitTask,
  isTaskActiveForAwait,
} from '../await-task.js';
import type { RoomoteConfig, TaskSummaryResponse } from '../types.js';

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://test-api.example.com',
};

function summary(
  overrides: Partial<TaskSummaryResponse> = {},
): TaskSummaryResponse {
  return {
    id: 'task-1',
    title: 'Verify environment',
    mode: 'standard',
    completed: false,
    repositoryName: 'owner/repo',
    harness: 'opencode-server',
    createdAt: 1700000000,
    taskRunStatus: 'running',
    taskPhase: 'running',
    taskRunError: null,
    linkedEnvironmentId: 'env-1',
    linkedEnvironmentName: 'Demo',
    ...overrides,
  };
}

describe('isTaskActiveForAwait', () => {
  it('keeps stopped/shutting_down running phases active', () => {
    expect(
      isTaskActiveForAwait(
        summary({
          taskRunStatus: 'running',
          taskPhase: 'stopped',
        }),
      ),
    ).toBe(true);
    expect(
      isTaskActiveForAwait(
        summary({
          taskRunStatus: 'running',
          taskPhase: 'shutting_down',
        }),
      ),
    ).toBe(true);
  });

  it('prioritizes latest failed/canceled status over aggregate completed', () => {
    expect(
      isTaskActiveForAwait(
        summary({
          completed: true,
          taskRunStatus: 'failed',
          taskPhase: null,
        }),
      ),
    ).toBe(false);
    expect(
      isTaskActiveForAwait(
        summary({
          completed: true,
          taskRunStatus: 'canceled',
          taskPhase: null,
        }),
      ),
    ).toBe(false);
  });

  it('treats completed and exited runs as settled', () => {
    expect(isTaskActiveForAwait(summary({ completed: true }))).toBe(false);
    expect(
      isTaskActiveForAwait(
        summary({ taskRunStatus: 'failed', taskPhase: null }),
      ),
    ).toBe(false);
    expect(
      isTaskActiveForAwait(
        summary({ taskRunStatus: 'canceled', taskPhase: null }),
      ),
    ).toBe(false);
  });

  it('treats Ready/Idle post-turn states as settled', () => {
    expect(
      isTaskActiveForAwait(
        summary({
          taskRunStatus: 'running',
          taskPhase: 'waiting_for_prompt',
        }),
      ),
    ).toBe(false);
    expect(
      isTaskActiveForAwait(
        summary({ taskRunStatus: 'idle', taskPhase: 'waiting_for_prompt' }),
      ),
    ).toBe(false);
    expect(
      isTaskActiveForAwait(summary({ taskRunStatus: 'idle', taskPhase: null })),
    ).toBe(false);
  });

  it('keeps booting and working phases active', () => {
    expect(
      isTaskActiveForAwait(
        summary({ taskRunStatus: 'preparing', taskPhase: null }),
      ),
    ).toBe(true);
    expect(
      isTaskActiveForAwait(
        summary({ taskRunStatus: 'running', taskPhase: 'running' }),
      ),
    ).toBe(true);
    expect(
      isTaskActiveForAwait(
        summary({ taskRunStatus: 'idle', taskPhase: 'running' }),
      ),
    ).toBe(true);
  });

  it('treats needs-input as settled', () => {
    expect(
      isTaskActiveForAwait(
        summary({
          taskRunStatus: 'running',
          taskPhase: 'waiting_for_user_input',
        }),
      ),
    ).toBe(false);
  });
});

describe('classifySettledSummary', () => {
  it('classifies completed ready success', () => {
    expect(
      classifySettledSummary(summary({ completed: true, taskRunError: null })),
    ).toEqual({
      terminalLabel: 'Completed',
      ready: true,
      errorSummary: null,
    });
  });

  it('classifies failed/canceled above aggregate completed', () => {
    expect(
      classifySettledSummary(
        summary({
          completed: true,
          taskRunStatus: 'failed',
          taskPhase: null,
          taskRunError: 'boot failed after resume',
        }),
      ),
    ).toEqual({
      terminalLabel: 'Failed',
      ready: false,
      errorSummary: 'boot failed after resume',
    });

    expect(
      classifySettledSummary(
        summary({
          completed: true,
          taskRunStatus: 'canceled',
          taskPhase: null,
          taskRunError: null,
        }),
      ),
    ).toEqual({
      terminalLabel: 'Canceled',
      ready: false,
      errorSummary: 'Task was canceled',
    });
  });

  it('classifies failed runs', () => {
    expect(
      classifySettledSummary(
        summary({
          completed: false,
          taskRunStatus: 'failed',
          taskRunError: 'boot failed',
        }),
      ),
    ).toEqual({
      terminalLabel: 'Failed',
      ready: false,
      errorSummary: 'boot failed',
    });
  });

  it('classifies needs input', () => {
    expect(
      classifySettledSummary(
        summary({
          taskRunStatus: 'running',
          taskPhase: 'waiting_for_user_input',
        }),
      ),
    ).toMatchObject({
      terminalLabel: 'NeedsInput',
      ready: false,
    });
  });

  it('classifies status completed even when completed flag is false', () => {
    expect(
      classifySettledSummary(
        summary({
          completed: false,
          taskRunStatus: 'completed',
          taskPhase: null,
          taskRunError: null,
        }),
      ),
    ).toEqual({
      terminalLabel: 'Completed',
      ready: true,
      errorSummary: null,
    });
  });

  it('classifies Ready and Idle settled labels', () => {
    expect(
      classifySettledSummary(
        summary({
          taskRunStatus: 'running',
          taskPhase: 'waiting_for_prompt',
        }),
      ),
    ).toMatchObject({ terminalLabel: 'Ready', ready: true });

    expect(
      classifySettledSummary(
        summary({
          taskRunStatus: 'idle',
          taskPhase: null,
        }),
      ),
    ).toMatchObject({ terminalLabel: 'Idle', ready: true });
  });

  it('classifies canceled runs', () => {
    expect(
      classifySettledSummary(
        summary({
          taskRunStatus: 'canceled',
          taskPhase: null,
          taskRunError: null,
        }),
      ),
    ).toEqual({
      terminalLabel: 'Canceled',
      ready: false,
      errorSummary: 'Task was canceled',
    });
  });
});

describe('awaitTaskSettlement', () => {
  it('polls until the task settles and returns ready', async () => {
    const getTaskSummary = vi
      .fn()
      .mockResolvedValueOnce(
        summary({ taskRunStatus: 'preparing', taskPhase: null }),
      )
      .mockResolvedValueOnce(
        summary({ taskRunStatus: 'running', taskPhase: 'running' }),
      )
      .mockResolvedValueOnce(
        summary({
          completed: true,
          taskRunStatus: 'completed',
          taskPhase: null,
        }),
      );

    const sleep = vi.fn().mockResolvedValue(undefined);
    let now = 1_000;
    const result = await awaitTaskSettlement(
      { taskId: 'task-1', timeoutMs: 60_000, pollIntervalMs: 1_000 },
      config,
      {
        getTaskSummary,
        sleep,
        now: () => {
          now += 1_000;
          return now;
        },
      },
    );

    expect(getTaskSummary).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(result.terminalLabel).toBe('Completed');
    expect(result.ready).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.linkedEnvironmentId).toBe('env-1');
  });

  it('returns TimedOut when still active after timeout', async () => {
    const getTaskSummary = vi
      .fn()
      .mockResolvedValue(
        summary({ taskRunStatus: 'running', taskPhase: 'running' }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    let now = 0;

    const result = await awaitTaskSettlement(
      { taskId: 'task-1', timeoutMs: 5_000, pollIntervalMs: 1_000 },
      config,
      {
        getTaskSummary,
        sleep,
        now: () => {
          const value = now;
          now += 2_000;
          return value;
        },
      },
    );

    expect(result.terminalLabel).toBe('TimedOut');
    expect(result.ready).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.errorSummary).toMatch(/Timed out after 5000ms/);
  });

  it('returns Failed when summary settles failed', async () => {
    const getTaskSummary = vi.fn().mockResolvedValue(
      summary({
        taskRunStatus: 'failed',
        taskPhase: null,
        taskRunError: 'Sandbox failed to boot worker process',
      }),
    );

    const result = await awaitTaskSettlement({ taskId: 'task-1' }, config, {
      getTaskSummary,
      sleep: vi.fn(),
      now: () => 0,
    });

    expect(result.terminalLabel).toBe('Failed');
    expect(result.ready).toBe(false);
    expect(result.errorSummary).toBe('Sandbox failed to boot worker process');
    expect(result.status).toBe('Failed');
  });
});

describe('handleAwaitTask', () => {
  it('formats a text summary for the settled await result', async () => {
    const result = await handleAwaitTask({ taskId: 'task-1' }, config, {
      getTaskSummary: vi.fn().mockResolvedValue(
        summary({
          completed: true,
          taskRunStatus: 'completed',
          taskPhase: null,
        }),
      ),
      sleep: vi.fn(),
      now: () => 1000,
    });

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Task: Verify environment');
    expect(text).toContain('ID: task-1');
    expect(text).toContain('Terminal: Completed');
    expect(text).toContain('Ready: yes');
    expect(text).toContain('Timed out: no');
    expect(text).toContain('Linked Environment: Demo');
  });

  it('surfaces API errors', async () => {
    const failed = await handleAwaitTask({ taskId: 'missing' }, config, {
      getTaskSummary: vi.fn().mockRejectedValue(new Error('Not found')),
      sleep: vi.fn(),
      now: () => 0,
    });
    expect(failed.content[0]?.text).toContain('Not found');
    expect(failed.content[0]?.text).toContain('"success":false');
  });
});
