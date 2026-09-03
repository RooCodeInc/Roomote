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
    enqueueParentEventAndWait: vi.fn(),
    getTaskUrl: vi.fn(
      ({ taskId }: { taskId: string }) =>
        `https://roomote.example/task/${taskId}`,
    ),
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
  FastAgentParentEventDeliveryError: mocks.FastAgentParentEventDeliveryError,
}));

vi.mock('../../fast-agent-parent-event-queue', () => ({
  enqueueFastAgentParentEventAndWait: mocks.enqueueParentEventAndWait,
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

function claimedFeedbackIds(): string[] {
  return mocks.claimConversationDelivery.mock.calls.map(
    (call: unknown[]) => (call[0] as { feedbackId: string }).feedbackId,
  );
}

describe('notifyFastAgentParentOnPrFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimReturning.mockResolvedValue([{ id: 200 }]);
    const claimed = new Set<string>();
    mocks.claimConversationDelivery.mockImplementation(
      async ({ feedbackId }: { feedbackId: string }) => {
        if (claimed.has(feedbackId)) {
          return { status: 'already_claimed' as const };
        }
        claimed.add(feedbackId);
        return {
          status: 'claimed' as const,
          claim: { id: `claim-${feedbackId}`, leaseToken: 'lease-token' },
        };
      },
    );
    mocks.completeConversationDelivery.mockResolvedValue(undefined);
    mocks.releaseConversationDelivery.mockResolvedValue(undefined);
    mocks.findReusableOwner.mockResolvedValue({
      taskId: 'child-task',
      runId: 200,
    });
    mocks.findClaimRun.mockResolvedValue({ id: 200 });
    mocks.enqueueParentEventAndWait.mockResolvedValue('delivered');
    mocks.recordLifecycle.mockResolvedValue(undefined);
  });

  it('passes structured, actionable feedback to the Fast parent', async () => {
    await expect(
      notifyFastAgentParentOnPrFeedback({
        run: makeRun({ fastAgentParent: fastParent }),
        ...input,
      }),
    ).resolves.toBe(true);

    expect(mocks.enqueueParentEventAndWait).toHaveBeenCalledWith(
      {
        parent: fastParent,
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
      },
      { timeoutMs: 30_000 },
    );
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

    expect(mocks.enqueueParentEventAndWait).not.toHaveBeenCalled();
  });

  it('uses the same feedback identity regardless of source event order', async () => {
    const run = makeRun({ fastAgentParent: fastParent });
    await notifyFastAgentParentOnPrFeedback({
      run,
      ...input,
      feedbackSourceIds: ['delivery-2', 'delivery-1'],
    });
    await notifyFastAgentParentOnPrFeedback({
      run,
      ...input,
      feedbackSourceIds: ['delivery-1', 'delivery-2'],
    });

    expect(claimedFeedbackIds()[1]).toBe(claimedFeedbackIds()[0]);
    expect(mocks.enqueueParentEventAndWait).toHaveBeenCalledOnce();
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

    expect(claimedFeedbackIds()[1]).toBe(claimedFeedbackIds()[0]);
    expect(mocks.enqueueParentEventAndWait).toHaveBeenCalledOnce();
  });

  it('delivers once across linked tasks sharing a conversation', async () => {
    const olderRun = makeRun(
      { fastAgentParent: fastParent },
      { id: 100, taskId: 'older-task' },
    );
    const newerRun = makeRun(
      { fastAgentParent: fastParent },
      { id: 200, taskId: 'newer-task' },
    );
    mocks.findReusableOwner.mockResolvedValue({
      taskId: 'newer-task',
      runId: 200,
    });

    await notifyFastAgentParentOnPrFeedback({ run: olderRun, ...input });
    await notifyFastAgentParentOnPrFeedback({ run: newerRun, ...input });

    expect(mocks.enqueueParentEventAndWait).toHaveBeenCalledOnce();
    expect(mocks.claimConversationDelivery).toHaveBeenCalledTimes(2);
  });

  it('still delivers when a different task is the reusable owner', async () => {
    // The owner is not guaranteed to reach its own delivery path, so a
    // non-owner must deliver rather than reporting success and dropping it.
    mocks.findReusableOwner.mockResolvedValue({
      taskId: 'newer-task',
      runId: 900,
    });

    await expect(
      notifyFastAgentParentOnPrFeedback({
        run: makeRun(
          { fastAgentParent: fastParent },
          { id: 100, taskId: 'older-task' },
        ),
        ...input,
      }),
    ).resolves.toBe(true);

    expect(mocks.enqueueParentEventAndWait).toHaveBeenCalledOnce();
    expect(mocks.enqueueParentEventAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          taskId: 'newer-task',
          runId: 900,
          taskUrl: 'https://roomote.example/task/newer-task',
        }),
      }),
      { timeoutMs: 30_000 },
    );
  });

  it('falls back to the task-scoped claim when the conversation row is missing', async () => {
    mocks.claimConversationDelivery.mockResolvedValue({
      status: 'no_conversation' as const,
    });

    await notifyFastAgentParentOnPrFeedback({
      run: makeRun({ fastAgentParent: fastParent }),
      ...input,
    });

    expect(mocks.enqueueParentEventAndWait).toHaveBeenCalledOnce();
    expect(mocks.completeConversationDelivery).not.toHaveBeenCalled();
  });

  it('shares a feedback identity between direct review handoff and webhook delivery', async () => {
    const run = makeRun({ fastAgentParent: fastParent });
    await notifyFastAgentParentOnPrFeedback({
      run,
      ...input,
      feedbackSourceIds: ['linked-review:review-task:abc123'],
      reviewTaskId: 'review-task',
      reviewHeadSha: 'abc123',
    });
    await notifyFastAgentParentOnPrFeedback({
      run,
      ...input,
      feedbackSourceIds: ['durable-webhook-delivery'],
      reviewTaskId: 'review-task',
      reviewHeadSha: 'abc123',
    });

    expect(claimedFeedbackIds()[1]).toBe(claimedFeedbackIds()[0]);
    expect(mocks.enqueueParentEventAndWait).toHaveBeenCalledOnce();
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

    expect(mocks.enqueueParentEventAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ reviewResult }),
      }),
      { timeoutMs: 30_000 },
    );
  });

  it('does nothing for a task without a Fast parent', async () => {
    await notifyFastAgentParentOnPrFeedback({ run: makeRun({}), ...input });

    expect(mocks.enqueueParentEventAndWait).not.toHaveBeenCalled();
  });
});
