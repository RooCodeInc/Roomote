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
    inArray: vi.fn((...args: unknown[]) => args),
    not: vi.fn((...args: unknown[]) => args),
    recordLifecycle: vi.fn(),
    deliverParentEvent: vi.fn(),
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
  inArray: mocks.inArray,
  not: mocks.not,
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
    status: 'task_runs.status',
  },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  getTaskUrl: mocks.getTaskUrl,
}));

vi.mock('../../fast-agent-parent-event', () => ({
  deliverFastAgentParentEvent: mocks.deliverParentEvent,
  FastAgentParentEventDeliveryError: mocks.FastAgentParentEventDeliveryError,
}));

import { notifyFastAgentParentOnPullRequestOpened } from '../notify-fast-agent-parent-on-pull-request-opened';

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
  title: '[Fix] Keep the PR in the closeout',
  url: 'https://github.com/acme/web/pull/42',
  status: 'open' as const,
};

describe('notifyFastAgentParentOnPullRequestOpened', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimReturning.mockResolvedValue([{ id: 200 }]);
    mocks.findClaimRun.mockResolvedValue({ id: 200 });
    mocks.deliverParentEvent.mockResolvedValue(undefined);
    mocks.recordLifecycle.mockResolvedValue(undefined);
  });

  it('passes structured pull request context to the Fast parent', async () => {
    await notifyFastAgentParentOnPullRequestOpened({
      run: makeRun({ fastAgentParent: discordFastParent }),
      untrustedTaskGeneratedContext:
        'Fixed startup by treating absent local secrets as optional.',
      pullRequest,
    });

    expect(mocks.deliverParentEvent).toHaveBeenCalledWith({
      parent: discordFastParent,
      lockWaitMs: 30_000,
      event: {
        type: 'pull_request_opened',
        taskId: 'child-task',
        runId: 200,
        taskUrl: 'https://roomote.example/task/child-task',
        untrustedTaskGeneratedContext:
          'Fixed startup by treating absent local secrets as optional.',
        pullRequest,
      },
    });
    expect(mocks.getTaskUrl).toHaveBeenCalledWith({
      taskId: 'child-task',
      utm: {
        source: 'discord',
        campaign: 'fast-delegation-pr-opened',
      },
    });
    expect(mocks.inArray).toHaveBeenCalledWith(
      'task_runs.status',
      expect.arrayContaining(['completed', 'failed', 'canceled']),
    );
    expect(mocks.recordLifecycle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'fast_agent_parent_pr_opened_event',
          prUrl: pullRequest.url,
        }),
      }),
    );
  });

  it('omits blank task-generated context so metadata remains the fallback', async () => {
    await notifyFastAgentParentOnPullRequestOpened({
      run: makeRun({ fastAgentParent: fastParent }),
      untrustedTaskGeneratedContext: '   ',
      pullRequest,
    });

    expect(mocks.deliverParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.not.objectContaining({
          untrustedTaskGeneratedContext: expect.anything(),
        }),
      }),
    );
  });

  it('does nothing for a task without a Fast parent', async () => {
    await notifyFastAgentParentOnPullRequestOpened({
      run: makeRun({}),
      pullRequest,
    });

    expect(mocks.deliverParentEvent).not.toHaveBeenCalled();
  });
});
