const mocks = vi.hoisted(() => {
  return {
    findRun: vi.fn(),
    recordLifecycle: vi.fn(),
    enqueueParentEvent: vi.fn(),
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {
    query: { taskRuns: { findFirst: mocks.findRun } },
  },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  recordTaskRunLifecycleEvent: mocks.recordLifecycle,
  taskRuns: {
    id: 'task_runs.id',
    taskId: 'task_runs.task_id',
    result: 'task_runs.result',
  },
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://roomote.example' },
}));

vi.mock('../../fast-agent-parent-event-queue', () => ({
  enqueueFastAgentParentEvent: mocks.enqueueParentEvent,
}));

import { notifyFastAgentParentOnArtifact } from '../notify-fast-agent-parent';

const fastParent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  conversation: {
    surface: 'slack' as const,
    workspaceId: 'T123',
    conversationId: '100.001',
    replyTarget: { channelId: 'C123', threadId: '100.001' },
  },
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
    mocks.enqueueParentEvent.mockResolvedValue({
      eventKey: 'artifact-event',
      queued: true,
    });
    mocks.recordLifecycle.mockResolvedValue(undefined);
  });

  it('passes structured artifact metadata to the Fast orchestrator', async () => {
    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'queued',
    );

    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith({
      parent: fastParent,
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
    });
    expect(mocks.recordLifecycle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'fast_agent_parent_artifact_event',
        }),
      }),
    );
  });

  it('reports a durable enqueue failure for retry', async () => {
    mocks.enqueueParentEvent.mockRejectedValueOnce(
      new Error('database offline'),
    );

    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'failed',
    );
    expect(mocks.recordLifecycle).not.toHaveBeenCalled();
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
      'queued',
    );
    expect(mocks.enqueueParentEvent).toHaveBeenCalledOnce();
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
    expect(mocks.enqueueParentEvent).not.toHaveBeenCalled();
  });
});
