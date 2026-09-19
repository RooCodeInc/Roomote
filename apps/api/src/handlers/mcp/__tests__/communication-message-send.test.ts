const {
  hasUserDirectMessageIdentityMock,
  sendCommunicationChannelPostMock,
  sendUserDirectMessageWithReceiptMock,
} = vi.hoisted(() => ({
  hasUserDirectMessageIdentityMock: vi.fn(),
  sendCommunicationChannelPostMock: vi.fn(),
  sendUserDirectMessageWithReceiptMock: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  hasUserDirectMessageIdentity: hasUserDirectMessageIdentityMock,
  sendUserDirectMessageWithReceipt: sendUserDirectMessageWithReceiptMock,
}));

vi.mock('../communication-channel-posts', () => ({
  sendCommunicationChannelPost: sendCommunicationChannelPostMock,
}));

import { sendCommunicationMessage } from '../communication-message-send';

describe('sendCommunicationMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasUserDirectMessageIdentityMock.mockResolvedValue(true);
    sendUserDirectMessageWithReceiptMock.mockResolvedValue({
      delivered: true,
      receipt: {
        provider: 'telegram',
        workspaceId: 'workspace-1',
        channelId: 'channel-1',
        messageId: 'message-1',
      },
    });
    sendCommunicationChannelPostMock.mockResolvedValue(
      Response.json({ channelId: 'C1', messageTs: '100.1' }),
    );
  });

  it.each(['slack', 'telegram'] as const)(
    'resolves %s:me only from the authenticated member',
    async (provider) => {
      const response = await sendCommunicationMessage({
        actingUserId: 'user-1',
        destination: `${provider}:me`,
        message: 'Keep this exact.',
      });

      expect(response.ok).toBe(true);
      expect(hasUserDirectMessageIdentityMock).toHaveBeenCalledWith(
        provider,
        'user-1',
      );
      expect(sendUserDirectMessageWithReceiptMock).toHaveBeenCalledWith({
        provider,
        userId: 'user-1',
        text: 'Keep this exact.',
        logContext: 'roomote-mcp-chat-message',
      });
      await expect(response.json()).resolves.toMatchObject({
        delivered: true,
        receipt: {
          channelId: 'channel-1',
          messageId: 'message-1',
        },
      });
    },
  );

  it('keeps a Telegram self-DM in the trusted current topic', async () => {
    await sendCommunicationMessage({
      actingUserId: 'user-1',
      taskRun: {
        payload: {
          communicationProvider: 'telegram',
          communicationChannelId: '5087578056',
          communicationThreadId: '18069',
        },
      },
      destination: 'telegram:me',
      message: 'Keep this exact.',
    });

    expect(sendUserDirectMessageWithReceiptMock).toHaveBeenCalledWith({
      provider: 'telegram',
      userId: 'user-1',
      text: 'Keep this exact.',
      logContext: 'roomote-mcp-chat-message',
      replyAnchor: {
        provider: 'telegram',
        workspaceId: '5087578056',
        channelId: '5087578056',
        messageId: '18069',
        threadId: '18069',
      },
    });
  });

  it('rejects unavailable self linkage without attempting delivery', async () => {
    hasUserDirectMessageIdentityMock.mockResolvedValue(false);

    const response = await sendCommunicationMessage({
      actingUserId: 'user-1',
      destination: 'telegram:me',
      message: 'Hello.',
    });

    expect(response.status).toBe(404);
    expect(sendUserDirectMessageWithReceiptMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      code: 'recipient_not_linked',
      provider: 'telegram',
    });
  });

  it.each([
    [
      'slack:T1:channel:C123456789',
      { channel: 'C123456789', text: 'Hello.', images: [] },
    ],
    [
      'slack:T1:channel:C123456789:thread:100.2',
      {
        channel: 'C123456789',
        threadTs: '100.2',
        text: 'Hello.',
        images: [],
      },
    ],
    [
      'slack:T1:member:U123456789',
      { channel: 'U123456789', text: 'Hello.', images: [] },
    ],
  ])(
    'routes authorized destination %s through Slack checks',
    async (destination, parsedBody) => {
      await sendCommunicationMessage({
        actingUserId: 'user-1',
        destination,
        message: 'Hello.',
      });

      expect(sendCommunicationChannelPostMock).toHaveBeenCalledWith({
        taskRun: {
          id: 0,
          taskId: 'member:user-1',
          actingUserId: 'user-1',
          payload: {
            communicationProvider: 'slack',
            communicationTeamId: 'T1',
          },
        },
        parsedBody,
      });
    },
  );

  it('forwards uploaded artifact IDs to Slack destinations', async () => {
    await sendCommunicationMessage({
      actingUserId: 'user-1',
      destination: 'slack:T1:channel:C123456789',
      message: 'Proof attached.',
      imageArtifactIds: ['artifact-1'],
    });

    expect(sendCommunicationChannelPostMock).toHaveBeenCalledWith({
      taskRun: expect.anything(),
      parsedBody: {
        channel: 'C123456789',
        text: 'Proof attached.',
        images: [{ artifactId: 'artifact-1' }],
      },
    });
  });

  it('rejects attachments for text-only self destinations', async () => {
    const response = await sendCommunicationMessage({
      actingUserId: 'user-1',
      destination: 'telegram:me',
      message: 'Proof attached.',
      imageArtifactIds: ['artifact-1'],
    });

    expect(response.status).toBe(400);
    expect(sendUserDirectMessageWithReceiptMock).not.toHaveBeenCalled();
  });

  it('allows a non-Slack current destination only when it matches task context', async () => {
    const taskRun = {
      id: 1,
      taskId: 'task-1',
      actingUserId: 'user-1',
      payload: {
        communicationProvider: 'telegram',
        communicationChannelId: 'chat-1',
      },
    };

    const allowed = await sendCommunicationMessage({
      actingUserId: 'user-1',
      taskRun,
      destination: 'telegram:current',
      message: 'Hello.',
    });
    const rejected = await sendCommunicationMessage({
      actingUserId: 'user-1',
      taskRun,
      destination: 'discord:current',
      message: 'Hello.',
    });

    expect(allowed.ok).toBe(true);
    expect(rejected.status).toBe(403);
    expect(sendCommunicationChannelPostMock).toHaveBeenCalledOnce();
  });

  it('allows slack:current only for the configured Slack task destination', async () => {
    const taskRun = {
      id: 1,
      taskId: 'task-1',
      actingUserId: 'user-1',
      payload: {
        communicationProvider: 'slack',
        communicationTeamId: 'T1',
        communicationChannelId: 'C123456789',
      },
    };

    const response = await sendCommunicationMessage({
      actingUserId: 'user-1',
      taskRun,
      destination: 'slack:current',
      message: 'Hello.',
    });

    expect(response.ok).toBe(true);
    expect(sendCommunicationChannelPostMock).toHaveBeenCalledWith({
      taskRun,
      parsedBody: {
        channel: 'C123456789',
        text: 'Hello.',
        images: [],
      },
    });
  });

  it('rejects invented destination formats', async () => {
    const response = await sendCommunicationMessage({
      actingUserId: 'user-1',
      destination: 'slack:someone-else',
      message: 'Hello.',
    });

    expect(response.status).toBe(400);
    expect(sendUserDirectMessageWithReceiptMock).not.toHaveBeenCalled();
    expect(sendCommunicationChannelPostMock).not.toHaveBeenCalled();
  });
});
