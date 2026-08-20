import type { TaskRun } from '@roomote/db/server';

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
    deliverParentEvent: vi.fn(),
    getTaskUrl: vi.fn(() => 'https://roomote.example/task/child-task'),
    FastAgentParentEventDeliveryError,
  };
});

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
  taskRuns: {
    id: 'task_runs.id',
    result: 'task_runs.result',
  },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  getTaskUrl: mocks.getTaskUrl,
}));

vi.mock('../../fast-agent-parent-event', () => ({
  deliverFastAgentParentEvent: mocks.deliverParentEvent,
  FastAgentParentEventDeliveryError: mocks.FastAgentParentEventDeliveryError,
}));

import { notifyFastAgentParentOnPullRequestStatusChanged } from '../notify-fast-agent-parent-on-pull-request-status-changed';

const fastParent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  conversation: {
    surface: 'slack' as const,
    workspaceId: 'T123',
    conversationId: '100.001',
    replyTarget: { channelId: 'C123', threadId: '100.001' },
  },
};

function makeRun(payload: Record<string, unknown>): TaskRun {
  return {
    id: 200,
    taskId: 'child-task',
    payload,
    result: null,
    error: null,
  } as TaskRun;
}

const pullRequest = {
  provider: 'github' as const,
  host: 'github.com',
  repository: 'acme/web',
  number: 42,
  title: 'Fix review feedback',
  url: 'https://github.com/acme/web/pull/42',
  status: 'merged' as const,
};

describe('notifyFastAgentParentOnPullRequestStatusChanged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimReturning.mockResolvedValue([{ id: 200 }]);
    mocks.deliverParentEvent.mockResolvedValue('delivered');
    mocks.recordLifecycle.mockResolvedValue(undefined);
  });

  it.each(['merged', 'closed'] as const)(
    'passes a %s pull request status to the Fast parent',
    async (status) => {
      const statusPullRequest = { ...pullRequest, status };

      await notifyFastAgentParentOnPullRequestStatusChanged({
        run: makeRun({ fastAgentParent: fastParent }),
        pullRequest: statusPullRequest,
        actorLogin: 'alice',
      });

      expect(mocks.deliverParentEvent).toHaveBeenCalledWith({
        parent: fastParent,
        lockWaitMs: 30_000,
        event: {
          type: 'pull_request_status_changed',
          taskId: 'child-task',
          runId: 200,
          taskUrl: 'https://roomote.example/task/child-task',
          pullRequest: statusPullRequest,
          status,
          actorLogin: 'alice',
        },
      });
      expect(mocks.getTaskUrl).toHaveBeenCalledWith({
        taskId: 'child-task',
        utm: {
          source: 'slack',
          campaign: 'fast-delegation-pr-status',
        },
      });
      expect(mocks.recordLifecycle).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          details: expect.objectContaining({
            reason: 'fast_agent_parent_pr_status_event',
            status,
            actorLogin: 'alice',
          }),
        }),
      );
    },
  );

  it('does not redeliver a settled status claim', async () => {
    mocks.claimReturning.mockResolvedValue([]);

    await notifyFastAgentParentOnPullRequestStatusChanged({
      run: makeRun({ fastAgentParent: fastParent }),
      pullRequest,
      actorLogin: 'alice',
    });

    expect(mocks.deliverParentEvent).not.toHaveBeenCalled();
  });

  it('releases a transiently failed claim for webhook retry', async () => {
    mocks.deliverParentEvent.mockRejectedValue(new Error('model offline'));

    await expect(
      notifyFastAgentParentOnPullRequestStatusChanged({
        run: makeRun({ fastAgentParent: fastParent }),
        pullRequest: { ...pullRequest, status: 'closed' },
        actorLogin: 'alice',
      }),
    ).rejects.toThrow('model offline');

    expect(
      mocks.updateSet.mock.calls.some(([values]) => {
        const result = (values as { result?: { strings?: string[] } }).result;
        return result?.strings?.join('').includes(' - ') === true;
      }),
    ).toBe(true);
  });

  it('does nothing for a task without a Fast parent', async () => {
    await notifyFastAgentParentOnPullRequestStatusChanged({
      run: makeRun({}),
      pullRequest,
      actorLogin: 'alice',
    });

    expect(mocks.deliverParentEvent).not.toHaveBeenCalled();
  });
});
