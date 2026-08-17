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
    findRun: vi.fn(),
    claimReturning: vi.fn(),
    updateSet: vi.fn(),
    recordLifecycle: vi.fn(),
    deliverParentEvent: vi.fn(),
    FastAgentParentEventDeliveryError,
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {
    query: { taskRuns: { findFirst: mocks.findRun } },
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
    taskId: 'task_runs.task_id',
    result: 'task_runs.result',
  },
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://roomote.example' },
}));

vi.mock('../../fast-agent-parent-event', () => ({
  deliverFastAgentParentEvent: mocks.deliverParentEvent,
  FastAgentParentEventDeliveryError: mocks.FastAgentParentEventDeliveryError,
}));

import { notifyFastAgentParentOnArtifact } from '../notify-fast-agent-parent';

const fastParent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  slackTeamId: 'T123',
  slackChannel: 'C123',
  slackThreadTs: '100.001',
};

function artifact(
  overrides: Partial<
    Parameters<typeof notifyFastAgentParentOnArtifact>[0]
  > = {},
) {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    taskId: 'child-task',
    runId: 200,
    path: 'proof/result.png',
    version: 1,
    contentType: 'image/png',
    uploaded: true,
    ...overrides,
  };
}

describe('notifyFastAgentParentOnArtifact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findRun.mockResolvedValue({
      id: 200,
      taskId: 'child-task',
      payload: { fastAgentParent: fastParent },
      result: {},
    });
    mocks.claimReturning.mockResolvedValue([{ id: 200 }]);
    mocks.deliverParentEvent.mockResolvedValue(undefined);
    mocks.recordLifecycle.mockResolvedValue(undefined);
  });

  it('passes structured artifact metadata to the Fast orchestrator', async () => {
    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'delivered',
    );

    expect(mocks.deliverParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: fastParent,
        lockWaitMs: expect.any(Number),
        event: expect.objectContaining({
          type: 'artifact_published',
          taskId: 'child-task',
          runId: 200,
          artifact: expect.objectContaining({
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            path: 'proof/result.png',
            contentType: 'image/png',
            viewUrl:
              'https://roomote.example/task/child-task/artifacts/proof/result.png?v=1',
          }),
        }),
      }),
    );
    expect(mocks.recordLifecycle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'fast_agent_parent_artifact_event',
        }),
      }),
    );
  });

  it('deduplicates an event already claimed by another delivery', async () => {
    mocks.claimReturning.mockResolvedValueOnce([]);

    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'already_delivered',
    );
    expect(mocks.deliverParentEvent).not.toHaveBeenCalled();
  });

  it('releases a failed orchestrator delivery for retry', async () => {
    mocks.deliverParentEvent.mockRejectedValueOnce(new Error('model offline'));

    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'failed',
    );
    expect(
      mocks.updateSet.mock.calls.some(([values]) => {
        const result = (values as { result?: { strings?: string[] } }).result;
        return result?.strings?.join('').includes(' - ') === true;
      }),
    ).toBe(true);
  });

  it('reports an in-flight delivery as in_progress instead of delivered', async () => {
    mocks.claimReturning.mockResolvedValueOnce([]);
    mocks.findRun.mockResolvedValue({
      id: 200,
      taskId: 'child-task',
      payload: { fastAgentParent: fastParent },
      result: {
        'fastAgentArtifact:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': `delivering:${Date.now()}`,
      },
    });

    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'in_progress',
    );
    expect(mocks.deliverParentEvent).not.toHaveBeenCalled();
  });

  it('keeps the claim when the failure happened after the Slack post', async () => {
    mocks.deliverParentEvent.mockRejectedValueOnce(
      new mocks.FastAgentParentEventDeliveryError('lifecycle write failed', {
        slackPosted: true,
      }),
    );

    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'delivered',
    );
    expect(
      mocks.updateSet.mock.calls.some(([values]) => {
        const result = (values as { result?: { strings?: string[] } }).result;
        return result?.strings?.join('').includes(' - ') === true;
      }),
    ).toBe(false);
  });

  it('settles the claim as skipped when no retry can ever succeed', async () => {
    mocks.deliverParentEvent.mockRejectedValueOnce(
      new mocks.FastAgentParentEventDeliveryError('parent session gone', {
        slackPosted: false,
        permanent: true,
      }),
    );

    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'skipped',
    );
    expect(
      mocks.updateSet.mock.calls.some(([values]) => {
        const result = (values as { result?: { values?: unknown[] } }).result;
        return result?.values?.includes('skipped') === true;
      }),
    ).toBe(true);
  });

  it('uses inherited Fast parent metadata on resumed runs', async () => {
    mocks.findRun.mockResolvedValueOnce({
      id: 200,
      taskId: 'child-task',
      payload: {
        sourceSnapshotId: 'snap-1',
        communicationContextInherited: true,
        fastAgentParent: fastParent,
      },
      result: {},
    });

    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'delivered',
    );
    expect(mocks.deliverParentEvent).toHaveBeenCalledOnce();
  });

  it('does nothing for standalone artifacts', async () => {
    mocks.findRun.mockResolvedValueOnce({
      id: 200,
      taskId: 'child-task',
      payload: {},
      result: {},
    });

    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'not_applicable',
    );
    expect(mocks.deliverParentEvent).not.toHaveBeenCalled();
  });
});
