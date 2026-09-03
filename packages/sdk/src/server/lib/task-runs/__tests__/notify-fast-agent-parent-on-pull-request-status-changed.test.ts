import type { TaskRun } from '@roomote/db/server';

const mocks = vi.hoisted(() => ({
  recordLifecycle: vi.fn(),
  enqueueParentEvent: vi.fn(),
  getTaskUrl: vi.fn(() => 'https://roomote.example/task/child-task'),
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  recordTaskRunLifecycleEvent: mocks.recordLifecycle,
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  getTaskUrl: mocks.getTaskUrl,
}));

vi.mock('@roomote/types', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/types')>()),
  getFastAgentParentFromPayload: (payload: Record<string, unknown>) =>
    payload.fastAgentParent,
  isPrReviewPayload: (payload: { type?: string }) =>
    payload.type === 'github_pr_review' ||
    payload.type === 'github_pr_review_sync',
}));

vi.mock('../../fast-agent-parent-event-queue', () => ({
  enqueueFastAgentParentEvent: mocks.enqueueParentEvent,
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
    mocks.enqueueParentEvent.mockResolvedValue({
      eventKey: 'pr-status-event',
      queued: true,
    });
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

    expect(mocks.enqueueParentEvent).not.toHaveBeenCalled();
  });
});

describe('notifyFastAgentParentOnPullRequestConflict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueParentEvent.mockResolvedValue({
      eventKey: 'pr-conflict-event',
      queued: true,
    });
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
    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith({
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
    });
  });

  it('suppresses conflict notifications from review-pipeline runs', async () => {
    await expect(
      notifyFastAgentParentOnPullRequestConflict({
        run: makeRun({
          type: 'github_pr_review_sync',
          fastAgentParent: fastParent,
        }),
        pullRequest: {
          provider: pullRequest.provider,
          host: pullRequest.host,
          repository: pullRequest.repository,
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
        },
        conflictDetectedAt: new Date('2026-08-24T23:00:00.000Z'),
      }),
    ).resolves.toBe(false);

    expect(mocks.enqueueParentEvent).not.toHaveBeenCalled();
  });

  it('surfaces durable conflict admission failures', async () => {
    mocks.enqueueParentEvent.mockRejectedValueOnce(
      new Error('database offline'),
    );

    await expect(
      notifyFastAgentParentOnPullRequestConflict({
        run: makeRun({ fastAgentParent: fastParent }),
        pullRequest: {
          provider: pullRequest.provider,
          host: pullRequest.host,
          repository: pullRequest.repository,
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
        },
        conflictDetectedAt: new Date('2026-08-24T23:00:00.000Z'),
      }),
    ).rejects.toThrow('database offline');
    expect(mocks.recordLifecycle).not.toHaveBeenCalled();
  });
});
