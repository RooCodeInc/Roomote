const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  refreshFast: vi.fn(),
  refreshTask: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = mocks.add;
  },
}));
vi.mock('@roomote/redis', () => ({ getRedis: () => ({}) }));
vi.mock('../fast-agent-title', () => ({
  refreshFastAgentSessionTitle: mocks.refreshFast,
  refreshTaskSessionTitle: mocks.refreshTask,
}));

import {
  SESSION_TITLE_REFRESH_JOB,
  processSessionTitleRefreshJob,
  refreshFastAgentSessionTitleWithRetry,
  refreshTaskSessionTitleWithRetry,
} from '../session-title-refresh-job';

describe('session title refresh retry job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.add.mockResolvedValue(undefined);
  });

  it.each([
    ['transient provider', true, 'rate_limited'],
    ['credential', false, 'invalid_credentials'],
  ])(
    'enqueues bounded retries for a %s failure',
    async (_label, retryable, reason) => {
      mocks.refreshFast.mockResolvedValue({
        status: 'failed',
        checkpoint: 1,
        message: 'provider failed',
        reason,
        retryable,
      });

      await refreshFastAgentSessionTitleWithRetry({
        sessionId: '11111111-1111-4111-8111-111111111111',
        userId: 'user-1',
      });

      expect(mocks.add).toHaveBeenCalledWith(
        SESSION_TITLE_REFRESH_JOB,
        {
          kind: 'fast',
          fastConversationId: '11111111-1111-4111-8111-111111111111',
          userId: 'user-1',
          checkpoint: 1,
        },
        expect.objectContaining({
          jobId:
            'session-title-refresh-fast-11111111-1111-4111-8111-111111111111-1',
          attempts: 5,
          backoff: { type: 'exponential', delay: 15_000 },
        }),
      );
    },
  );

  it('does not enqueue a completed or guarded no-op refresh', async () => {
    mocks.refreshFast.mockResolvedValue({
      status: 'noop',
      checkpoint: 1,
      reason: 'manual_rename',
    });

    await refreshFastAgentSessionTitleWithRetry({
      sessionId: '11111111-1111-4111-8111-111111111111',
      userId: 'user-1',
    });

    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('retries task-only final refreshes with a checkpoint-specific job', async () => {
    mocks.refreshTask.mockResolvedValue({
      status: 'failed',
      checkpoint: 1000,
      message: 'provider failed',
      reason: 'invalid_credentials',
      retryable: false,
    });

    await refreshTaskSessionTitleWithRetry({
      taskId: 'task-1',
      userId: 'user-1',
      mode: 'final',
    });

    expect(mocks.add).toHaveBeenCalledWith(
      SESSION_TITLE_REFRESH_JOB,
      {
        kind: 'task',
        taskId: 'task-1',
        userId: 'user-1',
        mode: 'final',
        checkpoint: 1000,
      },
      expect.objectContaining({
        jobId: 'session-title-refresh-task-task-1-final-1000',
      }),
    );
  });

  it('retries failures that happen before a checkpoint can be read', async () => {
    mocks.refreshFast.mockResolvedValue({
      status: 'failed',
      checkpoint: null,
      message: 'database unavailable',
      reason: 'provider_error',
      retryable: true,
    });

    await refreshFastAgentSessionTitleWithRetry({
      sessionId: '11111111-1111-4111-8111-111111111111',
      userId: 'user-1',
    });

    expect(mocks.add).toHaveBeenCalledWith(
      SESSION_TITLE_REFRESH_JOB,
      expect.objectContaining({ checkpoint: 0 }),
      expect.objectContaining({
        jobId:
          'session-title-refresh-fast-11111111-1111-4111-8111-111111111111-0',
      }),
    );
  });

  it('throws from the processor so BullMQ applies its backoff', async () => {
    mocks.refreshFast.mockResolvedValue({
      status: 'failed',
      checkpoint: 1,
      message: 'temporary outage',
      reason: 'endpoint_unreachable',
      retryable: true,
    });

    await expect(
      processSessionTitleRefreshJob({
        kind: 'fast',
        fastConversationId: '11111111-1111-4111-8111-111111111111',
        userId: 'user-1',
        checkpoint: 1,
      }),
    ).rejects.toThrow(
      'Session title refresh failed (endpoint_unreachable): temporary outage',
    );
  });
});
