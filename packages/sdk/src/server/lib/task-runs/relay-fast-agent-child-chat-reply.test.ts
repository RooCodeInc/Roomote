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

  it('sends the child update only to the Fast parent event path', async () => {
    await expect(
      relayFastAgentChildChatReply({
        runId: 42,
        taskId: 'task-1',
        messageId: '22222222-2222-4222-8222-222222222222',
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
        messageId: '22222222-2222-4222-8222-222222222222',
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
        messageId: '22222222-2222-4222-8222-222222222222',
        purpose: 'progress',
        message: 'Still working.',
      }),
    ).resolves.toEqual({ relayed: false });
    expect(mocks.deliverParentEvent).not.toHaveBeenCalled();
  });
});
