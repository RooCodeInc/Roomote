import { DiscordApiError } from '@roomote/communication';

import { replyToDiscordEvent } from '../replies.js';

function interactionContext() {
  return {
    interaction: {
      id: 'interaction-1',
      application_id: 'app-1',
      type: 2,
      token: 'interaction-token',
    },
    interactionDeferred: true,
  } as const;
}

function channelContext() {
  return {
    channelId: 'thread-1',
    channelName: 'Task thread',
    channelType: 11,
    guildId: 'guild-1',
    parentChannelId: 'channel-1',
    isDirectMessage: false,
    isThread: true,
  } as const;
}

describe('replyToDiscordEvent', () => {
  it('edits a deferred interaction original instead of posting a channel message', async () => {
    const editInteractionResponse = vi.fn(async () => ({
      provider: 'discord' as const,
      channelId: 'thread-1',
      messageId: 'response-1',
    }));
    const postMessage = vi.fn();

    await expect(
      replyToDiscordEvent({
        provider: { editInteractionResponse, postMessage } as never,
        applicationId: 'app-1',
        channel: channelContext(),
        interaction: interactionContext(),
        text: 'Done',
      }),
    ).resolves.toMatchObject({ messageId: 'response-1' });

    expect(editInteractionResponse).toHaveBeenCalledWith({
      applicationId: 'app-1',
      interactionToken: 'interaction-token',
      text: 'Done',
    });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('falls back to the channel when an ambiguous ACK has no original response', async () => {
    const editInteractionResponse = vi.fn().mockRejectedValue(
      new DiscordApiError({
        method: 'PATCH',
        path: '/webhooks/app-1/token/messages/@original',
        status: 404,
        code: 10015,
        message: 'Unknown Webhook',
      }),
    );
    const postMessage = vi.fn(async () => ({
      provider: 'discord' as const,
      channelId: 'thread-1',
      messageId: 'fallback-1',
    }));
    const buttons = [[{ text: 'Follow Task', url: 'https://example.com' }]];

    await expect(
      replyToDiscordEvent({
        provider: { editInteractionResponse, postMessage } as never,
        applicationId: 'app-1',
        channel: channelContext(),
        interaction: interactionContext(),
        text: 'Done',
        buttons,
      }),
    ).resolves.toMatchObject({ messageId: 'fallback-1' });

    expect(postMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      threadId: 'thread-1',
      text: 'Done',
      buttons,
    });
  });

  it('does not risk a duplicate channel reply after an ambiguous edit failure', async () => {
    const editError = new Error('socket reset while editing');
    const editInteractionResponse = vi.fn().mockRejectedValue(editError);
    const postMessage = vi.fn();

    await expect(
      replyToDiscordEvent({
        provider: { editInteractionResponse, postMessage } as never,
        applicationId: 'app-1',
        channel: channelContext(),
        interaction: interactionContext(),
        text: 'Done',
      }),
    ).rejects.toBe(editError);

    expect(postMessage).not.toHaveBeenCalled();
  });
});
