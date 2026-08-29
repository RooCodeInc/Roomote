const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  deliverParentEvent: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: { taskRuns: { findFirst: mocks.findRun } } },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  taskRuns: { id: 'task_runs.id', taskId: 'task_runs.task_id' },
}));

vi.mock('../fast-agent-parent-event', () => ({
  deliverFastAgentParentEvent: mocks.deliverParentEvent,
}));

import { relayFastAgentChildChatReply } from './relay-fast-agent-child-chat-reply';

const parent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  conversation: {
    surface: 'slack' as const,
    workspaceId: 'T123',
    conversationId: '100.001',
    replyTarget: { channelId: 'C123', threadId: '100.001' },
  },
};

describe('relayFastAgentChildChatReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findRun.mockResolvedValue({
      id: 42,
      taskId: 'task-1',
      payload: { fastAgentParent: parent },
    });
    mocks.deliverParentEvent.mockResolvedValue('delivered');
  });

  it.each([
    ['ack', 'The child started investigating.'],
    ['progress', 'The child is running targeted tests.'],
    ['closeout', 'The child completed the requested fix.'],
    ['clarification', 'The child needs a decision.'],
  ] as const)(
    'routes child %s messages through the Fast parent',
    async (purpose, message) => {
      await expect(
        relayFastAgentChildChatReply({
          runId: 42,
          taskId: 'task-1',
          deliverySignature: purpose.repeat(16),
          purpose,
          message,
        }),
      ).resolves.toEqual({ relayed: true });

      expect(mocks.deliverParentEvent).toHaveBeenCalledWith({
        parent,
        event: {
          type: 'child_message',
          taskId: 'task-1',
          runId: 42,
          messageId: expect.stringMatching(/^[a-f0-9]{64}$/),
          purpose,
          message,
        },
      });
    },
  );

  it('sends the child update only to the Fast parent event path', async () => {
    await expect(
      relayFastAgentChildChatReply({
        runId: 42,
        taskId: 'task-1',
        deliverySignature: 'a'.repeat(64),
        purpose: 'progress',
        message: 'The targeted tests are running.',
        imageArtifactIds: ['artifact-1', 'artifact-1'],
      }),
    ).resolves.toEqual({ relayed: true });

    expect(mocks.deliverParentEvent).toHaveBeenCalledWith({
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

  it('rejects runs that are not owned by a Fast parent', async () => {
    mocks.findRun.mockResolvedValueOnce({
      id: 42,
      taskId: 'task-1',
      payload: {},
    });

    await expect(
      relayFastAgentChildChatReply({
        runId: 42,
        taskId: 'task-1',
        deliverySignature: 'a'.repeat(64),
        purpose: 'progress',
        message: 'Still working.',
      }),
    ).resolves.toEqual({ relayed: false });
    expect(mocks.deliverParentEvent).not.toHaveBeenCalled();
  });

  it('scopes the deterministic message id to the Fast parent session', async () => {
    const input = {
      runId: 42,
      taskId: 'task-1',
      deliverySignature: 'a'.repeat(64),
      purpose: 'progress' as const,
      message: 'Still working.',
    };
    await relayFastAgentChildChatReply(input);
    const firstMessageId = mocks.deliverParentEvent.mock.calls[0]?.[0]?.event
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
    await relayFastAgentChildChatReply(input);

    expect(firstMessageId).toMatch(/^[a-f0-9]{64}$/);
    expect(
      mocks.deliverParentEvent.mock.calls[1]?.[0]?.event?.messageId,
    ).not.toBe(firstMessageId);
  });
});
