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
    findClaimRun: vi.fn(),
    updateSet: vi.fn(),
    recordLifecycle: vi.fn(),
    deliverParentEvent: vi.fn(),
    enqueueParentEvent: vi.fn(),
    enqueueParentEventAndWait: vi.fn(),
    getTaskUrl: vi.fn(() => 'https://roomote.example/task/child-task'),
    FastAgentParentEventDeliveryError,
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mocks.findClaimRun },
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
  asc: vi.fn((value: unknown) => value),
  desc: vi.fn((value: unknown) => value),
  eq: vi.fn((...args: unknown[]) => args),
  recordTaskRunLifecycleEvent: mocks.recordLifecycle,
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  })),
  taskRuns: {
    id: 'task_runs.id',
    taskId: 'task_runs.task_id',
    createdAt: 'task_runs.created_at',
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

vi.mock('../../fast-agent-parent-event-queue', () => ({
  enqueueFastAgentParentEvent: mocks.enqueueParentEvent,
  enqueueFastAgentParentEventAndWait: mocks.enqueueParentEventAndWait,
}));

import { notifyFastAgentParentOnPullRequestStatusChanged } from '../notify-fast-agent-parent-on-pull-request-status-changed';
import { notifyFastAgentParentOnPullRequestConflict } from '../notify-fast-agent-parent-on-pull-request-conflict';

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
  targetBranch: 'develop',
  status: 'merged' as const,
};

describe('notifyFastAgentParentOnPullRequestStatusChanged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimReturning.mockResolvedValue([{ id: 200 }]);
    mocks.findClaimRun.mockResolvedValue({ id: 200 });
    mocks.deliverParentEvent.mockResolvedValue('delivered');
    mocks.enqueueParentEvent.mockResolvedValue({
      eventKey: 'pr-status-event',
      queued: true,
    });
    mocks.enqueueParentEventAndWait.mockResolvedValue('delivered');
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

      expect(mocks.enqueueParentEvent).toHaveBeenCalledWith({
        parent: fastParent,
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

  it('does nothing for a task without a Fast parent', async () => {
    await notifyFastAgentParentOnPullRequestStatusChanged({
      run: makeRun({}),
      pullRequest,
      actorLogin: 'alice',
    });

    expect(mocks.deliverParentEvent).not.toHaveBeenCalled();
  });
});

describe('notifyFastAgentParentOnPullRequestConflict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimReturning.mockResolvedValue([{ id: 200 }]);
    mocks.findClaimRun.mockResolvedValue({ id: 200 });
    mocks.enqueueParentEventAndWait.mockResolvedValue('delivered');
    mocks.recordLifecycle.mockResolvedValue(undefined);
  });

  it('passes a conflict generation to the Fast parent', async () => {
    const conflictDetectedAt = new Date('2026-08-24T23:00:00.000Z');
    const delivered = await notifyFastAgentParentOnPullRequestConflict({
      run: makeRun({ fastAgentParent: fastParent }),
      pullRequest: {
        provider: pullRequest.provider,
        host: pullRequest.host,
        repository: pullRequest.repository,
        number: pullRequest.number,
        title: pullRequest.title,
        url: pullRequest.url,
      },
      conflictDetectedAt,
    });

    expect(delivered).toBe(true);
    expect(mocks.enqueueParentEventAndWait).toHaveBeenCalledWith(
      {
        parent: fastParent,
        event: expect.objectContaining({
          type: 'pull_request_conflict_detected',
          taskId: 'child-task',
          runId: 200,
          conflictDetectedAt: conflictDetectedAt.toISOString(),
          message:
            '[Fix review feedback](https://github.com/acme/web/pull/42) now has merge conflicts. Update the branch or ask Roomote to resolve them.',
          pullRequest: expect.objectContaining({
            repository: 'acme/web',
            number: 42,
          }),
        }),
      },
      { timeoutMs: 30_000 },
    );
  });
});
