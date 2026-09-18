import type { DiscordInteraction } from '@roomote/communication/discord-event';
import {
  DiscordApiError,
  type CommunicationMessageButton,
  type DiscordCommunicationProvider,
} from '@roomote/communication';

import type { DiscordChannelContext } from './task-launch.js';

type DiscordInteractionReplyContext = {
  interaction: DiscordInteraction;
  /** The original response was deferred, or the Gateway ACK was ambiguous. */
  interactionDeferred: boolean;
};

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
