const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  enqueueParentEvent: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: { taskRuns: { findFirst: mocks.findRun } } },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  taskRuns: { id: 'task_runs.id', taskId: 'task_runs.task_id' },
}));

vi.mock('../fast-agent-parent-event-queue', () => ({
  enqueueFastAgentParentEvent: mocks.enqueueParentEvent,
}));

import { TaskPayloadKind } from '@roomote/types';

import { reportToParentSession } from './report-to-parent-session';

const parent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  conversation: {
    surface: 'slack' as const,
    workspaceId: 'T123',
    conversationId: '100.001',
    replyTarget: { channelId: 'C123', threadId: '100.001' },
  },
};

describe('reportToParentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findRun.mockResolvedValue({
      id: 42,
      taskId: 'task-1',
      payload: { fastAgentParent: parent },
    });
    mocks.enqueueParentEvent.mockResolvedValue({ queued: true });
  });

  it('durably queues the child update without waiting on the Fast parent', async () => {
    await expect(
      reportToParentSession({
        runId: 42,
        taskId: 'task-1',
        deliverySignature: 'a'.repeat(64),
        purpose: 'progress',
        message: 'The targeted tests are running.',
        imageArtifactIds: ['artifact-1', 'artifact-1'],
      }),
    ).resolves.toEqual({ relayed: true });

    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith({
      parent,
      event: {
        type: 'child_message',
        taskId: 'task-1',
        runId: 42,
        messageId: expect.stringMatching(/^[a-f0-9]{64}$/),
        purpose: 'progress',
        message: 'The targeted tests are running.',
        imageArtifactIds: ['artifact-1'],
      },
    });
  });

  it('drops narration from a review child so the PR feedback relay stays the only signal', async () => {
    mocks.findRun.mockResolvedValueOnce({
      id: 42,
      taskId: 'task-1',
      payload: { fastAgentParent: parent, fastParentRequestedReview: true },
      payloadKind: TaskPayloadKind.GithubPrReview,
    });

    await expect(
      reportToParentSession({
        runId: 42,
        taskId: 'task-1',
        deliverySignature: 'a'.repeat(64),
        purpose: 'closeout',
        message: 'Reviewed the PR and found no issues.',
      }),
    ).resolves.toEqual({ relayed: false });

    expect(mocks.enqueueParentEvent).not.toHaveBeenCalled();
  });

  it('rejects runs that are not owned by a Fast parent', async () => {
    mocks.findRun.mockResolvedValueOnce({
      id: 42,
      taskId: 'task-1',
      payload: {},
    });

    await expect(
      reportToParentSession({
        runId: 42,
        taskId: 'task-1',
        deliverySignature: 'a'.repeat(64),
        purpose: 'progress',
        message: 'Still working.',
      }),
    ).resolves.toEqual({ relayed: false });
    expect(mocks.enqueueParentEvent).not.toHaveBeenCalled();
  });

  it('scopes the deterministic message id to the Fast parent session', async () => {
    const input = {
      runId: 42,
      taskId: 'task-1',
      deliverySignature: 'a'.repeat(64),
      purpose: 'progress' as const,
      message: 'Still working.',
    };
    await reportToParentSession(input);
    const firstMessageId = mocks.enqueueParentEvent.mock.calls[0]?.[0]?.event
      ?.messageId as string;

    mocks.findRun.mockResolvedValueOnce({
      id: 42,
      taskId: 'task-1',
      payload: {
        fastAgentParent: {
          ...parent,
          sessionId: '33333333-3333-4333-8333-333333333333',
        },
      },
    });
    await reportToParentSession(input);

    expect(firstMessageId).toMatch(/^[a-f0-9]{64}$/);
    expect(
      mocks.enqueueParentEvent.mock.calls[1]?.[0]?.event?.messageId,
    ).not.toBe(firstMessageId);
  });
});
