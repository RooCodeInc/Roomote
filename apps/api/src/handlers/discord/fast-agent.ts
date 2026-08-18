import {
  getDiscordMessageCreate,
  type DiscordGatewayEvent,
  type DiscordInteraction,
  type DiscordUser,
} from '@roomote/communication/discord-event';
import type { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import { answerFastAgentQuestion } from '@roomote/cloud-agents/server';
import { Env } from '@roomote/env';
import { ALL_REPOSITORIES } from '@roomote/types';

import { replyToDiscordEvent } from './replies.js';
import {
  discordMetadataForChannel,
  resolveDiscordWorkspace,
  type DiscordChannelContext,
} from './task-launch.js';
import { startNewDiscordTask } from './task-orchestration.js';
import { fetchDiscordThreadHistoryBestEffort } from './thread-context.js';

type DiscordInteractionReplyContext = {
  interaction: DiscordInteraction;
  interactionDeferred: boolean;
};

export async function processDiscordFastAgentMessage(input: {
  event: DiscordGatewayEvent;
  question: string;
  sender: DiscordUser;
  senderUserId: string;
  provider: DiscordCommunicationProvider;
  applicationId: string;
  channel: DiscordChannelContext;
  metadata: ReturnType<typeof discordMetadataForChannel>;
  sessionThreadId: string;
  interaction?: DiscordInteractionReplyContext;
  activeTasks?: { taskId: string }[];
}): Promise<void> {
  const history =
    input.channel.isThread || input.channel.isDirectMessage
      ? await fetchDiscordThreadHistoryBestEffort({
          provider: input.provider,
          channelId: input.channel.channelId,
          ...(input.channel.parentChannelId
            ? { parentChannelId: input.channel.parentChannelId }
            : {}),
        })
      : [];
  const message = getDiscordMessageCreate(input.event);
  let didSendVisibleResponse = false;
  const conversation = {
    surface: 'discord' as const,
    workspaceId: input.channel.guildId ?? 'dm',
    channelId: input.metadata.communicationChannelId,
    threadId: input.sessionThreadId,
  };
  const response = await answerFastAgentQuestion({
    question: input.question,
    threadContext: history.map((entry) => ({
      user: entry.user,
      username: entry.username,
      text: entry.text,
      ts: entry.id,
      ...(entry.botId ? { bot_id: entry.botId } : {}),
    })),
    userId: input.senderUserId,
    apiBaseUrl: Env.TRPC_URL ?? Env.R_APP_URL,
    conversation,
    senderDisplayName:
      input.interaction?.interaction.member?.nick ??
      input.sender.global_name ??
      input.sender.username,
    activeTasks: input.activeTasks,
    adapter: {
      launchTask: async ({ prompt, environmentId, parentSessionId }) => {
        const workspaceOverride = environmentId
          ? await resolveDiscordWorkspace({
              type: 'environment',
              id: environmentId,
              name: environmentId,
            })
          : {
              repoForPayload: ALL_REPOSITORIES,
              workspaceDisplayName: 'all repos',
            };
        if (!workspaceOverride) {
          return {
            success: false,
            error: 'The selected environment is unavailable.',
          };
        }

        const started = await startNewDiscordTask({
          provider: input.provider,
          applicationId: input.applicationId,
          requesterDiscordUserId: input.sender.id,
          launchOwnerUserId: input.senderUserId,
          queuedMessage: {
            provider: 'discord',
            text: prompt,
            user: input.sender.global_name?.trim() || input.sender.username,
            userId: input.senderUserId,
            ts: input.event.eventId,
            channel: input.metadata.communicationChannelId,
            ...(input.metadata.communicationThreadId
              ? { threadTs: input.metadata.communicationThreadId }
              : {}),
            turnPolicy: { reactionsAllowed: true },
          },
          metadata: input.metadata,
          channel: input.channel,
          forceNewThread: true,
          fastAgentSessionId: parentSessionId,
          skipRoutingConfirmation: true,
          workspaceOverride,
        });
        if (started.status === 'started') {
          return {
            success: true,
            taskId: started.launchResult.taskId,
            taskUrl: started.taskUrl,
          };
        }
        if (started.status === 'already_started') {
          return {
            success: true,
            taskId: started.existingRun.taskId,
            taskUrl: started.taskUrl,
          };
        }
        return {
          success: false,
          error: `Task launch stopped with status ${started.status}.`,
        };
      },
      postReply: async ({ message: text }) => {
        await replyToDiscordEvent({
          provider: input.provider,
          applicationId: input.applicationId,
          channel: input.channel,
          ...(input.interaction ? { interaction: input.interaction } : {}),
          ...(message ? { replyToMessageId: message.id } : {}),
          text,
        });
        didSendVisibleResponse = true;
      },
    },
  });
  if (response && !didSendVisibleResponse) {
    await replyToDiscordEvent({
      provider: input.provider,
      applicationId: input.applicationId,
      channel: input.channel,
      ...(input.interaction ? { interaction: input.interaction } : {}),
      ...(message ? { replyToMessageId: message.id } : {}),
      text: response,
    });
  }
}
