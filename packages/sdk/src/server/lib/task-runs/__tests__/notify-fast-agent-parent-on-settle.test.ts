import type { TaskRun } from '@roomote/db/server';
import { RunStatus, TaskRunErrorCode } from '@roomote/types';

const mocks = vi.hoisted(() => ({
  claimReturning: vi.fn(),
  updateSet: vi.fn(),
  recordLifecycle: vi.fn(),
  enqueueParentEvent: vi.fn(),
  listPullRequests: vi.fn(),
  getTaskUrl: vi.fn(() => 'https://roomote.example/task/child-task'),
  canRetryFailedStart: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
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
  getTaskUrl: mocks.getTaskUrl,
}));

vi.mock('../../fast-agent-parent-event', () => ({
  listFastAgentPullRequestContexts: mocks.listPullRequests,
}));

vi.mock('../../fast-agent-parent-event-queue', () => ({
  enqueueFastAgentParentEvent: mocks.enqueueParentEvent,
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
    mocks.enqueueParentEvent.mockResolvedValue({ queued: true });
    mocks.listPullRequests.mockResolvedValue([]);
    mocks.recordLifecycle.mockResolvedValue(undefined);
    mocks.canRetryFailedStart.mockResolvedValue(false);
  });

  it('queues child lifecycle state and settles the source claim immediately', async () => {
    await notifyFastAgentParentOnSettle(
      makeRun({ fastAgentParent: fastParent }),
      RunStatus.Idle,
      'Implement the fix',
    );

    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith({
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
    expect(
      mocks.updateSet.mock.calls.some(([values]) => {
        const result = (values as { result?: { strings?: string[] } }).result;
        return result?.strings?.join('').includes('to_jsonb(now())') === true;
      }),
    ).toBe(true);
    expect(mocks.recordLifecycle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        message: expect.stringContaining('Queued'),
        details: expect.objectContaining({
          reason: 'fast_agent_parent_settle_event',
        }),
      }),
    );
  });

  it('carries custom automation identity into the settlement event', async () => {
    await notifyFastAgentParentOnSettle(
      makeRun({
        fastAgentParent: fastParent,
        customAutomationId: 'automation-1',
      }),
      RunStatus.Completed,
    );

    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'task_settled',
          customAutomationId: 'automation-1',
        }),
      }),
    );
  });

  it('preserves pull request context in queue order', async () => {
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
    );

    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          pullRequests: [
            expect.objectContaining({ repository: 'acme/web', number: 42 }),
          ],
        }),
      }),
    );
  });

  it('stores failed-start retry capability as durable queue data', async () => {
    mocks.canRetryFailedStart.mockResolvedValue(true);
    await notifyFastAgentParentOnSettle(
      makeRun(
        { fastAgentParent: fastParent },
        {
          error:
            'Invalid credential xoxb-1234567890-abcdefghijklmnop while starting.',
          errorCode: TaskRunErrorCode.DockerWorkerStartTimeout,
        },
      ),
      RunStatus.Failed,
    );

    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        retryTaskStartRunId: 200,
        event: expect.objectContaining({
          error: 'Invalid credential [redacted] while starting.',
          errorCode: TaskRunErrorCode.DockerWorkerStartTimeout,
        }),
      }),
    );
  });

  it('omits retry capability when failed-start eligibility rejects the run', async () => {
    await notifyFastAgentParentOnSettle(
      makeRun(
        { fastAgentParent: fastParent },
        { error: 'The agent already produced output.' },
      ),
      RunStatus.Failed,
    );

    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith(
      expect.not.objectContaining({ retryTaskStartRunId: expect.any(Number) }),
    );
  });

  it('does nothing for independently launched tasks', async () => {
    await notifyFastAgentParentOnSettle(makeRun({}), RunStatus.Completed);
    expect(mocks.enqueueParentEvent).not.toHaveBeenCalled();
  });

  it('does not enqueue twice when settlement is already claimed', async () => {
    mocks.claimReturning.mockResolvedValueOnce([]);
    await notifyFastAgentParentOnSettle(
      makeRun({ fastAgentParent: fastParent }),
      RunStatus.Completed,
    );
    expect(mocks.enqueueParentEvent).not.toHaveBeenCalled();
  });

  it('releases the source claim only when durable admission fails', async () => {
    mocks.enqueueParentEvent.mockRejectedValueOnce(new Error('database down'));
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
});
