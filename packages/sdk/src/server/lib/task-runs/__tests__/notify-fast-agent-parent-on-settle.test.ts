import type { TaskRun } from '@roomote/db/server';
import { RunStatus } from '@roomote/types';

const mocks = vi.hoisted(() => {
  class FastAgentParentEventDeliveryError extends Error {
    readonly slackPosted: boolean;
    readonly permanent: boolean;

    constructor(
      message: string,
      options: { slackPosted: boolean; permanent?: boolean },
    ) {
      super(message);
      this.slackPosted = options.slackPosted;
      this.permanent = options.permanent ?? false;
    }
  }

  return {
    claimReturning: vi.fn(),
    updateSet: vi.fn(),
    recordLifecycle: vi.fn(),
    deliverParentEvent: vi.fn(),
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
  taskRuns: { id: 'task_runs.id', result: 'task_runs.result' },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  getTaskUrl: vi.fn(() => 'https://roomote.example/task/child-task'),
}));

vi.mock('../../fast-agent-parent-event', () => ({
  deliverFastAgentParentEvent: mocks.deliverParentEvent,
  FastAgentParentEventDeliveryError: mocks.FastAgentParentEventDeliveryError,
}));

import { notifyFastAgentParentOnSettle } from '../notify-fast-agent-parent-on-settle';

const fastParent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  slackTeamId: 'T123',
  slackChannel: 'C123',
  slackThreadTs: '100.001',
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

describe('notifyFastAgentParentOnSettle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimReturning.mockResolvedValue([{ id: 200 }]);
    mocks.deliverParentEvent.mockResolvedValue(undefined);
    mocks.recordLifecycle.mockResolvedValue(undefined);
  });

  it('passes child lifecycle state to the Fast orchestrator', async () => {
    await notifyFastAgentParentOnSettle(
      makeRun({ fastAgentParent: fastParent }),
      RunStatus.Idle,
      'Implement the fix',
    );

    expect(mocks.deliverParentEvent).toHaveBeenCalledWith({
      parent: fastParent,
      event: {
        type: 'task_settled',
        taskId: 'child-task',
        runId: 200,
        title: 'Implement the fix',
        status: RunStatus.Idle,
        taskUrl: 'https://roomote.example/task/child-task',
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
        slackPosted: true,
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
