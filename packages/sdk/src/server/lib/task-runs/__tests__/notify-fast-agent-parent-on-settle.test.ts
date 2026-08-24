import type { TaskRun } from '@roomote/db/server';
import { RunStatus, TaskRunErrorCode } from '@roomote/types';

const mocks = vi.hoisted(() => {
  class FastAgentParentEventDeliveryError extends Error {
    readonly replyPosted: boolean;
    readonly permanent: boolean;

    constructor(
      message: string,
      options: { replyPosted: boolean; permanent?: boolean },
    ) {
      super(message);
      this.replyPosted = options.replyPosted;
      this.permanent = options.permanent ?? false;
    }
  }

  return {
    claimReturning: vi.fn(),
    updateSet: vi.fn(),
    recordLifecycle: vi.fn(),
    recordAutomationChildOutcome: vi.fn(),
    countUnsettledAutomationChildren: vi.fn(),
    resumeAutomationRun: vi.fn(),
    recordAutomationOutcome: vi.fn(),
    runFastAutomation: vi.fn(),
    deliverParentEvent: vi.fn(),
    listPullRequests: vi.fn(),
    getTaskUrl: vi.fn(() => 'https://roomote.example/task/child-task'),
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
  recordAutomationRunChildOutcome: mocks.recordAutomationChildOutcome,
  countUnsettledAutomationRunChildren: mocks.countUnsettledAutomationChildren,
  resumeAutomationRunAfterChildren: mocks.resumeAutomationRun,
  recordAutomationRunOutcome: mocks.recordAutomationOutcome,
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  })),
  taskRuns: {
    id: 'task_runs.id',
    taskId: 'task_runs.task_id',
    sourceRunId: 'task_runs.source_run_id',
    result: 'task_runs.result',
  },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  canRetryFailedStart: mocks.canRetryFailedStart,
  enqueueTaskRelaunch: mocks.enqueueTaskRelaunch,
  getTaskUrl: mocks.getTaskUrl,
  runFastAutomationExecution: mocks.runFastAutomation,
}));

vi.mock('../../../automations/fast-automation-adapter', () => ({
  createFastAutomationExecutionAdapter: vi.fn(() => ({
    postReport: vi.fn(),
    launchTask: vi.fn(),
  })),
}));

vi.mock('../../fast-agent-parent-event', () => ({
  deliverFastAgentParentEvent: mocks.deliverParentEvent,
  listFastAgentPullRequestContexts: mocks.listPullRequests,
  FastAgentParentEventDeliveryError: mocks.FastAgentParentEventDeliveryError,
}));

import { notifyFastAgentParentOnSettle } from '../notify-fast-agent-parent-on-settle';

const fastParent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  conversation: {
    surface: 'slack' as const,
    workspaceId: 'T123',
    conversationId: '100.001',
    replyTarget: { channelId: 'C123', threadId: '100.001' },
  },
};

const discordFastParent = {
  sessionId: '22222222-2222-4222-8222-222222222222',
  conversation: {
    surface: 'discord' as const,
    workspaceId: 'guild-1',
    conversationId: 'interaction-1',
    replyTarget: { channelId: 'channel-1' },
  },
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
    mocks.recordAutomationChildOutcome.mockResolvedValue(true);
    mocks.countUnsettledAutomationChildren.mockResolvedValue(1);
    mocks.recordAutomationOutcome.mockResolvedValue(undefined);
    mocks.runFastAutomation.mockResolvedValue({ status: 'succeeded' });
    mocks.findTaskRun.mockResolvedValue(undefined);
    mocks.canRetryFailedStart.mockResolvedValue(false);
    mocks.enqueueTaskRelaunch.mockResolvedValue({ id: 201 });
  });

  it('passes child lifecycle state to the Fast orchestrator', async () => {
    await notifyFastAgentParentOnSettle(
      makeRun({ fastAgentParent: discordFastParent }),
      RunStatus.Idle,
      'Implement the fix',
    );

    expect(mocks.deliverParentEvent).toHaveBeenCalledWith({
      parent: discordFastParent,
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
    expect(mocks.getTaskUrl).toHaveBeenCalledWith({
      taskId: 'child-task',
      utm: {
        source: 'discord',
        campaign: 'fast-delegation-settle',
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

  it('records child settlement against an automation run parent', async () => {
    await notifyFastAgentParentOnSettle(
      makeRun({
        automationRunParent: {
          kind: 'automation_run',
          automationRunId: '33333333-3333-4333-8333-333333333333',
        },
      }),
      RunStatus.Completed,
    );

    expect(mocks.recordAutomationChildOutcome).toHaveBeenCalledWith({
      automationRunId: '33333333-3333-4333-8333-333333333333',
      taskId: 'child-task',
      terminalOutcome: RunStatus.Completed,
    });
    expect(mocks.deliverParentEvent).not.toHaveBeenCalled();
  });

  it('resumes the automation parent after its final child settles', async () => {
    mocks.countUnsettledAutomationChildren.mockResolvedValue(0);
    mocks.resumeAutomationRun.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      automationKey: 'sentry_triage',
      policyVersion: 1,
    });

    await notifyFastAgentParentOnSettle(
      makeRun({
        automationRunParent: {
          kind: 'automation_run',
          automationRunId: '33333333-3333-4333-8333-333333333333',
        },
      }),
      RunStatus.Completed,
      'Fix Sentry issue',
    );

    expect(mocks.runFastAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        automationRunId: '33333333-3333-4333-8333-333333333333',
        policyVersion: 1,
        prompt: expect.stringContaining('Fix Sentry issue'),
      }),
    );
    expect(mocks.recordAutomationOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: 'sentry_triage', status: 'succeeded' }),
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
    mocks.canRetryFailedStart.mockResolvedValue(true);
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
    mocks.canRetryFailedStart.mockResolvedValue(true);
    mocks.findTaskRun
      .mockResolvedValueOnce(undefined)
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
    mocks.canRetryFailedStart.mockResolvedValue(true);
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

  it('reuses an already-queued retry when the parent event is redelivered', async () => {
    mocks.canRetryFailedStart.mockResolvedValue(true);
    mocks.findTaskRun.mockResolvedValueOnce({ id: 201 });
    let retryResult: unknown;
    mocks.deliverParentEvent.mockImplementationOnce(
      async (input: { retryTaskStart?: () => Promise<unknown> }) => {
        retryResult = await input.retryTaskStart?.();
      },
    );

    await notifyFastAgentParentOnSettle(
      makeRun(
        { fastAgentParent: fastParent },
        { error: 'Sandbox startup timed out.' },
      ),
      RunStatus.Failed,
    );

    expect(retryResult).toEqual({ success: true, runId: 201 });
    expect(mocks.enqueueTaskRelaunch).not.toHaveBeenCalled();
  });

  it('does not offer retry control when failed-start eligibility rejects the run', async () => {
    mocks.canRetryFailedStart.mockResolvedValue(false);

    await notifyFastAgentParentOnSettle(
      makeRun(
        { fastAgentParent: fastParent },
        { error: 'The agent already produced output.' },
      ),
      RunStatus.Failed,
    );

    expect(mocks.deliverParentEvent).toHaveBeenCalledWith(
      expect.not.objectContaining({ retryTaskStart: expect.any(Function) }),
    );
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
        replyPosted: true,
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
