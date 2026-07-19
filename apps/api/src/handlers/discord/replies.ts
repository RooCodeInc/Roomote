import type { DiscordInteraction } from '@roomote/communication/discord-event';
import {
  DiscordApiError,
  isDiscordUnknownMessageError,
  type CommunicationMessageButton,
  type CommunicationPostMessageResult,
  type DiscordCommunicationProvider,
} from '@roomote/communication';

import type { DiscordChannelContext } from './task-launch.js';

type DiscordInteractionReplyContext = {
  interaction: DiscordInteraction;
  /** The original response was deferred, or the Gateway ACK was ambiguous. */
  interactionDeferred: boolean;
};

/**
 * An already-posted message to rewrite in place, addressed the only way that
 * works for its origin: an interaction still owes its clicker a response and
 * must be answered through its token, while a message nobody is waiting on is
 * edited by id.
 */
export type DiscordMessageToReplace = {
  channel: DiscordChannelContext;
  interaction?: DiscordInteractionReplyContext & { applicationId: string };
  messageId?: string;
};

/**
 * Discord's analog of Slack's `postOrReplaceSlackMessage`: turn an existing
 * message into this one, or post it fresh when there is nothing to replace or
 * the original is gone.
 */
export async function replaceOrPostDiscordMessage(input: {
  provider: DiscordCommunicationProvider;
  replace: DiscordMessageToReplace;
  text: string;
  buttons?: CommunicationMessageButton[][];
}): Promise<CommunicationPostMessageResult> {
  const { channel } = input.replace;
  const message = {
    text: input.text,
    ...(input.buttons ? { buttons: input.buttons } : {}),
  };
  if (input.replace.interaction) {
    return replyToDiscordEvent({
      provider: input.provider,
      applicationId: input.replace.interaction.applicationId,
      channel,
      interaction: input.replace.interaction,
      ...message,
    });
  }
  const postChannelId = channel.parentChannelId ?? channel.channelId;
  if (input.replace.messageId) {
    try {
      await input.provider.editMessage({
        // A thread is itself a channel, and the message lives in it. Unlike
        // postMessage, editMessage takes no separate thread id — addressing
        // the parent here would only ever find an unknown message.
        channelId: channel.channelId,
        messageId: input.replace.messageId,
        ...message,
      });
      return {
        provider: 'discord',
        channelId: postChannelId,
        messageId: input.replace.messageId,
        ...(channel.parentChannelId ? { threadId: channel.channelId } : {}),
      };
    } catch (error) {
      // Someone deleted the card. Posting is the only way left to say the task
      // started, and it still needs its cancel control.
      if (!isDiscordUnknownMessageError(error)) throw error;
    }
  }
  return input.provider.postMessage({
    channelId: postChannelId,
    ...(channel.parentChannelId ? { threadId: channel.channelId } : {}),
    ...message,
  });
}

export async function replyToDiscordEvent(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  channel: DiscordChannelContext;
  interaction?: DiscordInteractionReplyContext;
  text: string;
  buttons?: CommunicationMessageButton[][];
  /** Must match the Gateway's initial defer choice; it cannot be changed later. */
  ephemeral?: boolean;
  /** When posting a non-interaction channel message, nest under this message. */
  replyToMessageId?: string;
}) {
  if (input.interaction?.interactionDeferred) {
    try {
      return await input.provider.editInteractionResponse({
        applicationId: input.applicationId,
        interactionToken: input.interaction.interaction.token,
        text: input.text,
        ...(input.buttons ? { buttons: input.buttons } : {}),
      });
    } catch (error) {
      // An ambiguous Gateway ACK is represented as deferred so a successful
      // ACK is never abandoned. A definitive 404 here means the ACK did not
      // create an original response (or its webhook expired), so a normal bot
      // message is the only remaining way to answer. Other errors remain
      // retryable; falling back on an ambiguous edit could duplicate a reply.
      if (!(error instanceof DiscordApiError) || error.status !== 404) {
        throw error;
      }
    }
  }
  return input.provider.postMessage({
    channelId: input.channel.parentChannelId ?? input.channel.channelId,
    ...(input.channel.parentChannelId
      ? { threadId: input.channel.channelId }
      : {}),
    text: input.text,
    ...(input.buttons ? { buttons: input.buttons } : {}),
    ...(input.replyToMessageId
      ? { replyToMessageId: input.replyToMessageId }
      : {}),
  });
}
