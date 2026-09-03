import type { TaskRun } from '@roomote/db/server';

const mocks = vi.hoisted(() => {
  return {
    findReusableOwner: vi.fn(),
    recordLifecycle: vi.fn(),
    enqueueParentEvent: vi.fn(),
    getTaskUrl: vi.fn(
      ({ taskId }: { taskId: string }) =>
        `https://roomote.example/task/${taskId}`,
    ),
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {},
  findReusableGitHubPrFollowUpOwner: mocks.findReusableOwner,
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

function enqueuedFeedbackIds(): string[] {
  return mocks.enqueueParentEvent.mock.calls.map(
    (call: unknown[]) =>
      (call[0] as { event: { feedbackId: string } }).event.feedbackId,
  );
}

describe('notifyFastAgentParentOnPrFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findReusableOwner.mockResolvedValue({
      taskId: 'child-task',
      runId: 200,
    });
    mocks.enqueueParentEvent.mockResolvedValue({
      eventKey: 'feedback-event',
      queued: true,
    });
    mocks.recordLifecycle.mockResolvedValue(undefined);
  });

  it('passes structured, actionable feedback to the Fast parent', async () => {
    await expect(
      notifyFastAgentParentOnPrFeedback({
        run: makeRun({ fastAgentParent: fastParent }),
        ...input,
      }),
    ).resolves.toBe(true);

    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith({
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

    expect(mocks.enqueueParentEvent).not.toHaveBeenCalled();
  });

  it('suppresses review-pipeline runs inherited from the parent Session', async () => {
    await expect(
      notifyFastAgentParentOnPrFeedback({
        run: makeRun({
          type: 'github_pr_review',
          fastAgentParent: fastParent,
        }),
        ...input,
      }),
    ).resolves.toBe(false);

    expect(mocks.enqueueParentEvent).not.toHaveBeenCalled();
  });

  it('surfaces durable admission failures to the caller', async () => {
    mocks.enqueueParentEvent.mockRejectedValueOnce(
      new Error('database offline'),
    );

    await expect(
      notifyFastAgentParentOnPrFeedback({
        run: makeRun({ fastAgentParent: fastParent }),
        ...input,
      }),
    ).rejects.toThrow('database offline');
    expect(mocks.recordLifecycle).not.toHaveBeenCalled();
  });

  it('keeps successful admission when lifecycle logging fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.recordLifecycle.mockRejectedValueOnce(new Error('logging offline'));

    await expect(
      notifyFastAgentParentOnPrFeedback({
        run: makeRun({ fastAgentParent: fastParent }),
        ...input,
      }),
    ).resolves.toBe(true);
    expect(mocks.enqueueParentEvent).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
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

    expect(enqueuedFeedbackIds()[1]).toBe(enqueuedFeedbackIds()[0]);
    expect(mocks.enqueueParentEvent).toHaveBeenCalledTimes(2);
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

    expect(enqueuedFeedbackIds()[1]).toBe(enqueuedFeedbackIds()[0]);
    expect(mocks.enqueueParentEvent).toHaveBeenCalledTimes(2);
  });

  it('uses one stable queue identity across linked tasks sharing a conversation', async () => {
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

    expect(enqueuedFeedbackIds()[1]).toBe(enqueuedFeedbackIds()[0]);
    expect(mocks.enqueueParentEvent).toHaveBeenCalledTimes(2);
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

    expect(mocks.enqueueParentEvent).toHaveBeenCalledOnce();
    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          taskId: 'newer-task',
          runId: 900,
          taskUrl: 'https://roomote.example/task/newer-task',
        }),
      }),
    );
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

    expect(enqueuedFeedbackIds()[1]).toBe(enqueuedFeedbackIds()[0]);
    expect(mocks.enqueueParentEvent).toHaveBeenCalledTimes(2);
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

    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ reviewResult }),
      }),
    );
  });

  it('does nothing for a task without a Fast parent', async () => {
    await notifyFastAgentParentOnPrFeedback({ run: makeRun({}), ...input });

    expect(mocks.enqueueParentEvent).not.toHaveBeenCalled();
  });
});
