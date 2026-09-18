const {
  hasUserDirectMessageIdentityMock,
  sendCommunicationChannelPostMock,
  sendUserDirectMessageMock,
} = vi.hoisted(() => ({
  hasUserDirectMessageIdentityMock: vi.fn(),
  sendCommunicationChannelPostMock: vi.fn(),
  sendUserDirectMessageMock: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  hasUserDirectMessageIdentity: hasUserDirectMessageIdentityMock,
  sendUserDirectMessage: sendUserDirectMessageMock,
}));

vi.mock('../communication-channel-posts', () => ({
  sendCommunicationChannelPost: sendCommunicationChannelPostMock,
}));

import { sendCommunicationMessage } from '../communication-message-send';

describe('sendCommunicationMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasUserDirectMessageIdentityMock.mockResolvedValue(true);
    sendUserDirectMessageMock.mockResolvedValue(true);
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
      expect(sendUserDirectMessageMock).toHaveBeenCalledWith({
        provider,
        userId: 'user-1',
        text: 'Keep this exact.',
        logContext: 'roomote-mcp-chat-message',
      });
    },
  );

  it('rejects unavailable self linkage without attempting delivery', async () => {
    hasUserDirectMessageIdentityMock.mockResolvedValue(false);

    const response = await sendCommunicationMessage({
      actingUserId: 'user-1',
      destination: 'telegram:me',
      message: 'Hello.',
    });

    expect(response.status).toBe(404);
    expect(sendUserDirectMessageMock).not.toHaveBeenCalled();
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
    expect(sendUserDirectMessageMock).not.toHaveBeenCalled();
    expect(sendCommunicationChannelPostMock).not.toHaveBeenCalled();
  });
});
