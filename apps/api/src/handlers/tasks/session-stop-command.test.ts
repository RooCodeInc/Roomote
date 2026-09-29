const mocks = vi.hoisted(() => ({
  findSession: vi.fn(),
  stopSessionTaskRuns: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  findFastAgentSessionForProviderConversation: mocks.findSession,
  stopSessionTaskRuns: mocks.stopSessionTaskRuns,
}));

import { stopChatSessionTasks } from './session-stop-command';

describe('stopChatSessionTasks', () => {
  beforeEach(() => {
    mocks.findSession.mockReset();
    mocks.stopSessionTaskRuns.mockReset();
  });

  it('soft-stops the linked owner session and confirms later messages can resume it', async () => {
    mocks.findSession.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      owner: { kind: 'user', userId: 'user-1' },
    });
    mocks.stopSessionTaskRuns.mockResolvedValue({
      success: true,
      stoppedCount: 2,
    });

    await expect(
      stopChatSessionTasks({
        provider: 'slack',
        workspaceId: 'team-1',
        channelId: 'channel-1',
        threadId: 'thread-1',
        conversationId: 'thread-1',
        replyToMessageId: 'message-1',
        userId: 'user-1',
        displayName: 'Ada Lovelace',
      }),
    ).resolves.toEqual({
      kind: 'stopped',
      stoppedCount: 2,
      text: 'Stopped 2 active tasks. The work remains resumable; send another message here to continue.',
    });
    expect(mocks.findSession).toHaveBeenCalledWith({
      provider: 'slack',
      workspaceId: 'team-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      conversationId: 'thread-1',
      replyToMessageId: 'message-1',
      userId: 'user-1',
    });
    expect(mocks.stopSessionTaskRuns).toHaveBeenCalledWith({
      sessionId: 'session-1',
      authUserId: 'user-1',
      cancelledBy: { name: 'Ada Lovelace', source: 'slack' },
    });
  });

  it('does not stop a missing, foreign, or non-user-owned session', async () => {
    mocks.findSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'session-foreign-owner',
        userId: 'user-1',
        owner: { kind: 'user', userId: 'other-user' },
      })
      .mockResolvedValueOnce({
        id: 'session-automation',
        userId: 'user-1',
        owner: { kind: 'automation', automationKey: 'daily-brief' },
      });

    const input = {
      provider: 'telegram' as const,
      workspaceId: 'chat-1',
      channelId: 'chat-1',
      conversationId: 'chat-1:user:user-1',
      userId: 'user-1',
    };

    await expect(stopChatSessionTasks(input)).resolves.toMatchObject({
      kind: 'unavailable',
    });
    await expect(stopChatSessionTasks(input)).resolves.toMatchObject({
      kind: 'unavailable',
    });
    await expect(stopChatSessionTasks(input)).resolves.toMatchObject({
      kind: 'unavailable',
    });
    expect(mocks.stopSessionTaskRuns).not.toHaveBeenCalled();
  });

  it('reports an empty session and partial failures without claiming every stop succeeded', async () => {
    mocks.findSession.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      owner: { kind: 'user', userId: 'user-1' },
    });
    mocks.stopSessionTaskRuns
      .mockResolvedValueOnce({ success: true, stoppedCount: 0 })
      .mockResolvedValueOnce({
        success: false,
        stoppedCount: 1,
        failedCount: 1,
      });

    const input = {
      provider: 'discord' as const,
      workspaceId: 'guild-1',
      channelId: 'thread-1',
      threadId: 'thread-1',
      conversationId: 'thread-1',
      userId: 'user-1',
    };

    await expect(stopChatSessionTasks(input)).resolves.toMatchObject({
      kind: 'stopped',
      stoppedCount: 0,
      text: 'There are no active tasks in this session to stop.',
    });
    await expect(stopChatSessionTasks(input)).resolves.toMatchObject({
      kind: 'partial',
      stoppedCount: 1,
      failedCount: 1,
      text: 'Stopped 1 active task, but 1 could not be stopped. The stopped tasks remain resumable; some work may still be running.',
    });
  });
});
