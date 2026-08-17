import type { TaskRun } from '@roomote/db/server';
import { RunStatus, TaskRunErrorCode } from '@roomote/types';

const mocks = vi.hoisted(() => {
  class FastAgentParentEventDeliveryError extends Error {
    readonly slackPosted: boolean;
    readonly permanent: boolean;

    constructor(
      message: string,
      options: { slackPosted: boolean; permanent?: boolean },
    ) {
      super(message);
      this.slackPosted = options.slackPosted;
      this.permanent = options.permanent ?? false;
    }
  }

  return {
    claimReturning: vi.fn(),
    updateSet: vi.fn(),
    recordLifecycle: vi.fn(),
    deliverParentEvent: vi.fn(),
    listPullRequests: vi.fn(),
    findTaskRun: vi.fn(),
    canRetryFailedStart: vi.fn(),
    enqueueTaskRelaunch: vi.fn(),
    FastAgentParentEventDeliveryError,
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mocks.findTaskRun },
    },
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        mocks.updateSet(values);
        return {
          where: vi.fn(() => ({ returning: mocks.claimReturning })),
        };
      }),
    })),
  },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  recordTaskRunLifecycleEvent: mocks.recordLifecycle,
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  })),
  taskRuns: { id: 'task_runs.id', result: 'task_runs.result' },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  canRetryFailedStart: mocks.canRetryFailedStart,
  enqueueTaskRelaunch: mocks.enqueueTaskRelaunch,
  getTaskUrl: vi.fn(() => 'https://roomote.example/task/child-task'),
}));

vi.mock('../../fast-agent-parent-event', () => ({
  deliverFastAgentParentEvent: mocks.deliverParentEvent,
  listFastAgentPullRequestContexts: mocks.listPullRequests,
  FastAgentParentEventDeliveryError: mocks.FastAgentParentEventDeliveryError,
}));

import { notifyFastAgentParentOnSettle } from '../notify-fast-agent-parent-on-settle';

const fastParent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  slackTeamId: 'T123',
  slackChannel: 'C123',
  slackThreadTs: '100.001',
};

function makeRun(
  payload: Record<string, unknown>,
  overrides: Partial<TaskRun> = {},
): TaskRun {
  return {
    id: 200,
    taskId: 'child-task',
    payload,
    result: null,
    error: null,
    sourceRunId: null,
    actingUserId: 'user-1',
    ...overrides,
  } as TaskRun;
}

describe('notifyFastAgentParentOnSettle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimReturning.mockResolvedValue([{ id: 200 }]);
    mocks.deliverParentEvent.mockResolvedValue(undefined);
    mocks.listPullRequests.mockResolvedValue([]);
    mocks.recordLifecycle.mockResolvedValue(undefined);
    mocks.findTaskRun.mockResolvedValue(undefined);
    mocks.canRetryFailedStart.mockResolvedValue(false);
    mocks.enqueueTaskRelaunch.mockResolvedValue({ id: 201 });
  });

  it('passes child lifecycle state to the Fast orchestrator', async () => {
    await notifyFastAgentParentOnSettle(
      makeRun({ fastAgentParent: fastParent }),
      RunStatus.Idle,
      'Implement the fix',
    );

    expect(mocks.deliverParentEvent).toHaveBeenCalledWith({
      parent: fastParent,
      event: {
        type: 'task_settled',
        taskId: 'child-task',
        runId: 200,
        title: 'Implement the fix',
        status: RunStatus.Idle,
        taskUrl: 'https://roomote.example/task/child-task',
        pullRequests: [],
      },
    });
    expect(mocks.recordLifecycle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'fast_agent_parent_settle_event',
        }),
      }),
    );
  });

  it('passes current pull request context with the completion event', async () => {
    mocks.listPullRequests.mockResolvedValueOnce([
      {
        provider: 'github',
        host: 'github.com',
        repository: 'acme/web',
        number: 42,
        title: '[Fix] Keep the PR in the closeout',
        url: 'https://github.com/acme/web/pull/42',
        status: 'merged',
      },
    ]);

    await notifyFastAgentParentOnSettle(
      makeRun({ fastAgentParent: fastParent }),
      RunStatus.Completed,
      'Implement the fix',
    );

    expect(mocks.listPullRequests).toHaveBeenCalledWith('child-task');
    expect(mocks.deliverParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'task_settled',
          pullRequests: [
            expect.objectContaining({
              repository: 'acme/web',
              number: 42,
              title: '[Fix] Keep the PR in the closeout',
              url: 'https://github.com/acme/web/pull/42',
              status: 'merged',
            }),
          ],
        }),
      }),
    );
  });

  it('lets the Fast parent retry an eligible failed startup', async () => {
    vi.useFakeTimers();
    mocks.canRetryFailedStart.mockResolvedValueOnce(true);
    let retryResult: unknown;
    mocks.deliverParentEvent.mockImplementationOnce(
      async (input: { retryTaskStart?: () => Promise<unknown> }) => {
        retryResult = await input.retryTaskStart?.();
      },
    );

    try {
      const pending = notifyFastAgentParentOnSettle(
        makeRun(
          { fastAgentParent: fastParent },
          {
            error: 'Sandbox startup timed out while contacting the provider.',
            errorCode: TaskRunErrorCode.DockerWorkerStartTimeout,
          },
        ),
        RunStatus.Failed,
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await pending;

      expect(mocks.enqueueTaskRelaunch).toHaveBeenCalledWith({
        sourceRunId: 200,
        actingUserId: 'user-1',
      });
      expect(mocks.canRetryFailedStart).toHaveBeenCalledWith(
        expect.objectContaining({ status: RunStatus.Failed }),
      );
      expect(retryResult).toEqual({ success: true, runId: 201 });
      expect(mocks.deliverParentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          retryTaskStart: expect.any(Function),
          event: expect.objectContaining({
            error: 'Sandbox startup timed out while contacting the provider.',
            errorCode: TaskRunErrorCode.DockerWorkerStartTimeout,
          }),
        }),
      );
      expect(mocks.recordLifecycle).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          details: expect.objectContaining({
            reason: 'fast_agent_parent_startup_retry',
            retryNumber: 1,
            delayMs: 1_000,
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the bounded startup retry budget to the Fast parent', async () => {
    mocks.canRetryFailedStart.mockResolvedValueOnce(true);
    mocks.findTaskRun
      .mockResolvedValueOnce({
        sourceRunId: 100,
        payload: { fastAgentParent: fastParent },
      })
      .mockResolvedValueOnce({
        sourceRunId: null,
        payload: { fastAgentParent: fastParent },
      });
    let retryResult: unknown;
    mocks.deliverParentEvent.mockImplementationOnce(
      async (input: { retryTaskStart?: () => Promise<unknown> }) => {
        retryResult = await input.retryTaskStart?.();
      },
    );

    await notifyFastAgentParentOnSettle(
      makeRun(
        { fastAgentParent: fastParent },
        {
          sourceRunId: 150,
          error: 'HTTP 503 while starting the sandbox.',
        },
      ),
      RunStatus.Failed,
    );

    expect(mocks.enqueueTaskRelaunch).not.toHaveBeenCalled();
    expect(retryResult).toEqual({
      success: false,
      error: 'The failed-start retry limit has been reached.',
    });
  });

  it('gives the Fast parent the full redacted error and error code', async () => {
    await notifyFastAgentParentOnSettle(
      makeRun(
        { fastAgentParent: fastParent },
        {
          error:
            'Invalid credential xoxb-1234567890-abcdefghijklmnop while loading https://provider.example/setup\nProvider configuration must be updated.',
          errorCode: TaskRunErrorCode.DockerWorkerStartTimeout,
        },
      ),
      RunStatus.Failed,
    );

    expect(mocks.enqueueTaskRelaunch).not.toHaveBeenCalled();
    expect(mocks.deliverParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          status: RunStatus.Failed,
          error:
            'Invalid credential [redacted] while loading https://provider.example/setup\nProvider configuration must be updated.',
          errorCode: TaskRunErrorCode.DockerWorkerStartTimeout,
        }),
        retryTaskStart: expect.any(Function),
      }),
    );
    expect(mocks.enqueueTaskRelaunch).not.toHaveBeenCalled();
  });

  it('passes terminal cancellation errors to the Fast parent', async () => {
    await notifyFastAgentParentOnSettle(
      makeRun(
        { fastAgentParent: fastParent },
        { error: 'The task was stopped because its sandbox was deleted.' },
      ),
      RunStatus.Canceled,
    );

    expect(mocks.deliverParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          status: RunStatus.Canceled,
          error: 'The task was stopped because its sandbox was deleted.',
        }),
      }),
    );
  });

  it('does nothing for independently launched tasks', async () => {
    await notifyFastAgentParentOnSettle(makeRun({}), RunStatus.Completed);
    expect(mocks.deliverParentEvent).not.toHaveBeenCalled();
  });

  it('does not deliver twice when settlement is already claimed', async () => {
    mocks.claimReturning.mockResolvedValueOnce([]);
    await notifyFastAgentParentOnSettle(
      makeRun({ fastAgentParent: fastParent }),
      RunStatus.Completed,
    );
    expect(mocks.deliverParentEvent).not.toHaveBeenCalled();
  });

  it('releases the claim when orchestrator delivery fails', async () => {
    mocks.deliverParentEvent.mockRejectedValueOnce(new Error('model offline'));
    await notifyFastAgentParentOnSettle(
      makeRun({ fastAgentParent: fastParent }),
      RunStatus.Completed,
    );
    expect(
      mocks.updateSet.mock.calls.some(([values]) => {
        const result = (values as { result?: { strings?: string[] } }).result;
        return result?.strings?.join('').includes(' - ') === true;
      }),
    ).toBe(true);
  });

  it('keeps the claim when the failure happened after the Slack post', async () => {
    mocks.deliverParentEvent.mockRejectedValueOnce(
      new mocks.FastAgentParentEventDeliveryError('lifecycle write failed', {
        slackPosted: true,
      }),
    );

    await notifyFastAgentParentOnSettle(
      makeRun({ fastAgentParent: fastParent }),
      RunStatus.Completed,
    );

    expect(
      mocks.updateSet.mock.calls.some(([values]) => {
        const result = (values as { result?: { strings?: string[] } }).result;
        return result?.strings?.join('').includes(' - ') === true;
      }),
    ).toBe(false);
    expect(
      mocks.updateSet.mock.calls.some(([values]) => {
        const result = (values as { result?: { strings?: string[] } }).result;
        return result?.strings?.join('').includes('to_jsonb(now())') === true;
      }),
    ).toBe(true);
  });
});
