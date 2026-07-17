import { DiscordApiError } from '@roomote/communication';

import {
  replaceOrPostDiscordMessage,
  replyToDiscordEvent,
} from '../replies.js';

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

describe('replaceOrPostDiscordMessage', () => {
  it('edits a card in a task thread through the thread, not its parent', async () => {
    // A thread is itself a channel and editMessage takes no separate thread
    // id. Addressing the parent finds an unknown message, which silently
    // degrades into a second acknowledgement beside a stale card.
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const postMessage = vi.fn();

    const result = await replaceOrPostDiscordMessage({
      provider: { editMessage, postMessage } as never,
      replace: { channel: channelContext(), messageId: 'card-1' },
      text: 'Started a task in Acme.',
    });

    expect(editMessage).toHaveBeenCalledWith({
      channelId: 'thread-1',
      messageId: 'card-1',
      text: 'Started a task in Acme.',
    });
    expect(postMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      channelId: 'channel-1',
      threadId: 'thread-1',
      messageId: 'card-1',
    });
  });

  it('posts when the card it should replace was deleted', async () => {
    const editMessage = vi.fn().mockRejectedValue(
      new DiscordApiError({
        method: 'PATCH',
        path: '/channels/thread-1/messages/card-1',
        status: 404,
        message: 'Unknown Message',
        code: 10008,
      }),
    );
    const postMessage = vi.fn().mockResolvedValue({
      provider: 'discord',
      channelId: 'channel-1',
      messageId: 'ack-1',
    });

    await replaceOrPostDiscordMessage({
      provider: { editMessage, postMessage } as never,
      replace: { channel: channelContext(), messageId: 'card-1' },
      text: 'Started a task in Acme.',
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'channel-1', threadId: 'thread-1' }),
    );
  });

  it('answers through the interaction when someone is waiting on one', async () => {
    const editInteractionResponse = vi
      .fn()
      .mockResolvedValue({ messageId: 'card-1' });
    const editMessage = vi.fn();

    await replaceOrPostDiscordMessage({
      provider: { editInteractionResponse, editMessage } as never,
      replace: {
        channel: channelContext(),
        interaction: { applicationId: 'app-1', ...interactionContext() },
      },
      text: 'Started a task in Acme.',
    });

    expect(editInteractionResponse).toHaveBeenCalledWith(
      expect.objectContaining({ interactionToken: 'interaction-token' }),
    );
    expect(editMessage).not.toHaveBeenCalled();
  });
});
