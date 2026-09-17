const mocks = vi.hoisted(() => ({
  queueFast: vi.fn(),
  resolveFast: vi.fn(),
  continueTask: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  queueFastAgentSurfaceReply: mocks.queueFast,
  resolveSessionAttentionFastConversation: mocks.resolveFast,
  continueDirectTaskAttentionReply: mocks.continueTask,
}));

import { continueSessionAttentionReply } from './continue-session-attention-reply';

const deliveryConversation = {
  surface: 'telegram' as const,
  workspaceId: 'chat-1',
  conversationId: 'notification:chat-1:user:user-1',
  replyTarget: { channelId: 'chat-1' },
};

describe('continueSessionAttentionReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.continueTask.mockResolvedValue(true);
    mocks.resolveFast.mockResolvedValue('fast-1');
    mocks.queueFast.mockResolvedValue(true);
  });

  it('routes direct-task input back to the task without binding a Fast conversation', async () => {
    await expect(
      continueSessionAttentionReply({
        attention: {
          sessionId: 'session-1',
          taskId: 'task-1',
          runId: 42,
          kind: 'input_needed',
        },
        userId: 'user-1',
        senderDisplayName: 'Ada',
        question: 'Use TypeScript',
        currentMessageId: 'message-1',
        deliveryConversation,
      }),
    ).resolves.toBe(true);

    expect(mocks.continueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        runId: 42,
        kind: 'input_needed',
      }),
    );
    expect(mocks.resolveFast).not.toHaveBeenCalled();
    expect(mocks.queueFast).not.toHaveBeenCalled();
  });

  it('uses only the Session-bound Fast conversation for cross-surface replies', async () => {
    await continueSessionAttentionReply({
      attention: {
        sessionId: 'session-1',
        taskId: null,
        runId: null,
        kind: 'result_ready',
      },
      userId: 'user-1',
      senderDisplayName: 'Ada',
      question: 'Continue',
      currentMessageId: 'message-2',
      deliveryConversation,
    });

    expect(mocks.resolveFast).toHaveBeenCalledWith({
      sessionId: 'session-1',
      userId: 'user-1',
    });
    expect(mocks.queueFast).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'fast-1',
        deliveryConversation,
      }),
    );
  });
});
