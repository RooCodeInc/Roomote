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
    claimConversationDelivery: vi.fn(),
    completeConversationDelivery: vi.fn(),
    releaseConversationDelivery: vi.fn(),
    findReusableOwner: vi.fn(),
    findClaimRun: vi.fn(),
    updateSet: vi.fn(),
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
  claimFastAgentPrFeedbackDelivery: mocks.claimConversationDelivery,
  completeFastAgentPrFeedbackDelivery: mocks.completeConversationDelivery,
  releaseFastAgentPrFeedbackDelivery: mocks.releaseConversationDelivery,
  findReusableGitHubPrFollowUpOwner: mocks.findReusableOwner,
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

import { notifyFastAgentParentOnPrFeedback } from '../notify-fast-agent-parent-on-pr-feedback';

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
  overrides: Partial<Pick<TaskRun, 'id' | 'taskId'>> = {},
): TaskRun {
  return {
    id: 200,
    taskId: 'child-task',
    payload,
    result: null,
    error: null,
    ...overrides,
  } as TaskRun;
}

const input = {
  deliveryIds: ['delivery-2', 'delivery-1'],
  pullRequest: {
    provider: 'github' as const,
    host: 'github.com',
    repository: 'acme/web',
    number: 42,
    title: 'Fix review feedback',
    url: 'https://github.com/acme/web/pull/42',
    status: 'open' as const,
  },
  summary: 'Alice requested changes.',
  suggestedActionQuestion: 'Want me to resolve these issues?',
  suggestedActionPrompt: 'Address the requested changes.',
};

describe('notifyFastAgentParentOnPrFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimReturning.mockResolvedValue([{ id: 200 }]);
    mocks.claimConversationDelivery.mockResolvedValue({
      id: 'delivery-claim',
      leaseToken: 'lease-token',
    });
    mocks.completeConversationDelivery.mockResolvedValue(undefined);
    mocks.releaseConversationDelivery.mockResolvedValue(undefined);
    mocks.findReusableOwner.mockResolvedValue({ taskId: 'child-task' });
    mocks.findClaimRun.mockResolvedValue({ id: 200 });
    mocks.deliverParentEvent.mockResolvedValue('delivered');
    mocks.recordLifecycle.mockResolvedValue(undefined);
  });

  it('passes structured, actionable feedback to the Fast parent', async () => {
    await expect(
      notifyFastAgentParentOnPrFeedback({
        run: makeRun({ fastAgentParent: fastParent }),
        ...input,
      }),
    ).resolves.toBe(true);

    expect(mocks.deliverParentEvent).toHaveBeenCalledWith({
      parent: fastParent,
      lockWaitMs: 30_000,
      event: {
        type: 'pull_request_feedback',
        feedbackId: expect.stringMatching(/^[a-f0-9]{24}$/),
        taskId: 'child-task',
        runId: 200,
        taskUrl: 'https://roomote.example/task/child-task',
        pullRequest: input.pullRequest,
        summary: input.summary,
        suggestedActionQuestion: input.suggestedActionQuestion,
        suggestedActionPrompt: input.suggestedActionPrompt,
      },
    });
    expect(mocks.recordLifecycle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'fast_agent_parent_pr_feedback_event',
          prUrl: input.pullRequest.url,
        }),
      }),
    );
  });

  it('returns false when the task has no Fast parent', async () => {
    await expect(
      notifyFastAgentParentOnPrFeedback({
        run: makeRun({}),
        ...input,
      }),
    ).resolves.toBe(false);

    expect(mocks.deliverParentEvent).not.toHaveBeenCalled();
  });

  it('uses the same feedback identity regardless of delivery order', async () => {
    const run = makeRun({ fastAgentParent: fastParent });
    await notifyFastAgentParentOnPrFeedback({ run, ...input });
    await notifyFastAgentParentOnPrFeedback({
      run,
      ...input,
      deliveryIds: [...input.deliveryIds].reverse(),
    });

    const firstEvent = mocks.deliverParentEvent.mock.calls[0]?.[0]?.event;
    const secondEvent = mocks.deliverParentEvent.mock.calls[1]?.[0]?.event;
    expect(secondEvent.feedbackId).toBe(firstEvent.feedbackId);
  });

  it('uses stable source events instead of generated summary text for fallback identity', async () => {
    const run = makeRun({ fastAgentParent: fastParent });
    await notifyFastAgentParentOnPrFeedback({
      run,
      ...input,
      summary: 'First generated summary.',
      feedbackSourceIds: ['github-review:123'],
    });
    await notifyFastAgentParentOnPrFeedback({
      run,
      ...input,
      summary: 'Differently worded generated summary.',
      feedbackSourceIds: ['github-review:123'],
    });

    const firstEvent = mocks.deliverParentEvent.mock.calls[0]?.[0]?.event;
    const secondEvent = mocks.deliverParentEvent.mock.calls[1]?.[0]?.event;
    expect(secondEvent.feedbackId).toBe(firstEvent.feedbackId);
  });

  it('delivers once through the newest reusable task in a shared conversation', async () => {
    const olderRun = makeRun(
      { fastAgentParent: fastParent },
      { id: 100, taskId: 'older-task' },
    );
    const newerRun = makeRun(
      { fastAgentParent: fastParent },
      { id: 200, taskId: 'newer-task' },
    );
    mocks.findReusableOwner.mockResolvedValue({ taskId: 'newer-task' });

    await notifyFastAgentParentOnPrFeedback({ run: olderRun, ...input });
    await notifyFastAgentParentOnPrFeedback({ run: newerRun, ...input });

    expect(mocks.deliverParentEvent).toHaveBeenCalledOnce();
    expect(mocks.deliverParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          taskId: 'newer-task',
          runId: 200,
        }),
      }),
    );
    expect(mocks.claimConversationDelivery).toHaveBeenCalledOnce();
  });

  it('shares a feedback identity between direct review handoff and webhook delivery', async () => {
    const run = makeRun({ fastAgentParent: fastParent });
    await notifyFastAgentParentOnPrFeedback({
      run,
      ...input,
      deliveryIds: ['linked-review:review-task:abc123'],
      reviewTaskId: 'review-task',
      reviewHeadSha: 'abc123',
    });
    await notifyFastAgentParentOnPrFeedback({
      run,
      ...input,
      deliveryIds: ['durable-webhook-delivery'],
      reviewTaskId: 'review-task',
      reviewHeadSha: 'abc123',
    });

    const firstEvent = mocks.deliverParentEvent.mock.calls[0]?.[0]?.event;
    const secondEvent = mocks.deliverParentEvent.mock.calls[1]?.[0]?.event;
    expect(secondEvent.feedbackId).toBe(firstEvent.feedbackId);
  });

  it('preserves structured terminal review metadata in the Fast event', async () => {
    const reviewResult = {
      reviewKind: 'initial' as const,
      outcome: 'findings_remain',
      findingCount: 1,
      approvalStatus: null,
      headSha: 'abc123',
    };

    await notifyFastAgentParentOnPrFeedback({
      run: makeRun({ fastAgentParent: fastParent }),
      ...input,
      reviewResult,
    });

    expect(mocks.deliverParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ reviewResult }),
      }),
    );
  });

  it('does nothing for a task without a Fast parent', async () => {
    await notifyFastAgentParentOnPrFeedback({ run: makeRun({}), ...input });

    expect(mocks.deliverParentEvent).not.toHaveBeenCalled();
  });
});
