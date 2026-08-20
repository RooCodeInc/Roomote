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

function makeRun(payload: Record<string, unknown>): TaskRun {
  return {
    id: 200,
    taskId: 'child-task',
    payload,
    result: null,
    error: null,
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
  suggestedActionPrompt: 'Address the requested changes.',
};

describe('notifyFastAgentParentOnPrFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimReturning.mockResolvedValue([{ id: 200 }]);
    mocks.deliverParentEvent.mockResolvedValue('delivered');
    mocks.recordLifecycle.mockResolvedValue(undefined);
  });

  it('passes structured, actionable feedback to the Fast parent', async () => {
    await notifyFastAgentParentOnPrFeedback({
      run: makeRun({ fastAgentParent: fastParent }),
      ...input,
    });

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

  it('does nothing for a task without a Fast parent', async () => {
    await notifyFastAgentParentOnPrFeedback({ run: makeRun({}), ...input });

    expect(mocks.deliverParentEvent).not.toHaveBeenCalled();
  });

  it('does not redeliver feedback when its claim is already settled', async () => {
    mocks.claimReturning.mockResolvedValue([]);

    await notifyFastAgentParentOnPrFeedback({
      run: makeRun({ fastAgentParent: fastParent }),
      ...input,
    });

    expect(mocks.deliverParentEvent).not.toHaveBeenCalled();
  });
});
