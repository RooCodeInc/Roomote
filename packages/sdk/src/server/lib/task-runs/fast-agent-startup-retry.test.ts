import type { TaskRun } from '@roomote/db/server';

const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  canRetry: vi.fn(),
  enqueueRelaunch: vi.fn(),
  recordLifecycle: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: { taskRuns: { findFirst: mocks.findRun } } },
  and: vi.fn((...values: unknown[]) => values),
  eq: vi.fn((...values: unknown[]) => values),
  recordTaskRunLifecycleEvent: mocks.recordLifecycle,
  taskRuns: {
    id: 'id',
    taskId: 'task_id',
    sourceRunId: 'source_run_id',
  },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  canRetryFailedStart: mocks.canRetry,
  enqueueTaskRelaunch: mocks.enqueueRelaunch,
}));

import { retryFastAgentStartup } from './fast-agent-startup-retry';

const parent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  conversation: {
    surface: 'slack' as const,
    workspaceId: 'T123',
    conversationId: '100.001',
    replyTarget: { channelId: 'C123', threadId: '100.001' },
  },
};

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 200,
    taskId: 'child-task',
    payload: { fastAgentParent: parent },
    sourceRunId: null,
    actingUserId: 'user-1',
    ...overrides,
  } as TaskRun;
}

describe('retryFastAgentStartup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.canRetry.mockResolvedValue(true);
    mocks.enqueueRelaunch.mockResolvedValue({ id: 201 });
    mocks.recordLifecycle.mockResolvedValue(undefined);
  });

  it('reuses an already-queued retry idempotently', async () => {
    mocks.findRun.mockResolvedValueOnce({ id: 201 });
    await expect(retryFastAgentStartup(makeRun(), parent)).resolves.toEqual({
      success: true,
      runId: 201,
    });
    expect(mocks.enqueueRelaunch).not.toHaveBeenCalled();
  });

  it('queues an eligible first retry after the bounded backoff', async () => {
    vi.useFakeTimers();
    try {
      mocks.findRun.mockResolvedValueOnce(undefined);
      const result = retryFastAgentStartup(makeRun(), parent);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(result).resolves.toEqual({ success: true, runId: 201 });
      expect(mocks.enqueueRelaunch).toHaveBeenCalledWith({
        sourceRunId: 200,
        actingUserId: 'user-1',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the retry limit without launching again', async () => {
    mocks.findRun
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        sourceRunId: 100,
        payload: { fastAgentParent: parent },
      })
      .mockResolvedValueOnce({
        sourceRunId: null,
        payload: { fastAgentParent: parent },
      });

    await expect(
      retryFastAgentStartup(makeRun({ sourceRunId: 150 }), parent),
    ).resolves.toEqual({
      success: false,
      error: 'The failed-start retry limit has been reached.',
    });
    expect(mocks.enqueueRelaunch).not.toHaveBeenCalled();
  });
});
