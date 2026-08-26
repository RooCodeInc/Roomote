import { createHash } from 'node:crypto';

import {
  getDiscordMessageCreate,
  type DiscordGatewayEvent,
  type DiscordInteraction,
  type DiscordUser,
} from '@roomote/communication/discord-event';
import {
  DISCORD_MAX_MESSAGE_LENGTH,
  type DiscordCommunicationProvider,
} from '@roomote/communication/discord-provider';
import {
  getOrCreateFastAgentSession,
  acquireFastAgentTurnLock,
  answerFastAgentQuestion,
  resolveApiBaseUrl,
} from '@roomote/cloud-agents/server';
import {
  buildFastSessionReplyFooterText,
  deliverManagedThreadReplyFooter,
  getDiscordFooterlessFinalChunk,
} from '@roomote/communication';
import { resolveUserMcpServerConfigs } from '@roomote/sdk/server';
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

export function getDiscordFastConversationId(
  channel: DiscordChannelContext,
  eventId: string,
): string {
  return channel.isDirectMessage || channel.isThread
    ? channel.channelId
    : eventId;
}

export function getDiscordFastLaunchSourceEventId(input: {
  eventId: string;
  prompt: string;
  environmentId: string | null;
  model?: string | null;
}): string {
  const launchKey = JSON.stringify([
    input.prompt,
    input.environmentId,
    input.model ?? null,
  ]);
  const digest = createHash('sha256')
    .update(launchKey)
    .digest('hex')
    .slice(0, 16);
  return `${input.eventId}:fast-launch:${digest}`;
}

export async function processDiscordFastAgentMessage(input: {
  event: DiscordGatewayEvent;
  question: string;
  sender: DiscordUser;
  senderUserId: string;
  provider: DiscordCommunicationProvider;
  applicationId: string;
  channel: DiscordChannelContext;
  metadata: ReturnType<typeof discordMetadataForChannel>;
  conversationId: string;
  interaction?: DiscordInteractionReplyContext;
  activeTasks?: { taskId: string }[];
}): Promise<void> {
  const conversation = {
    surface: 'discord' as const,
    workspaceId: input.channel.guildId ?? 'dm',
    conversationId: input.conversationId,
    replyTarget: {
      channelId: input.metadata.communicationChannelId,
      ...(input.metadata.communicationThreadId
        ? { threadId: input.metadata.communicationThreadId }
        : {}),
    },
  };
  const releaseFastAgentLock = await acquireFastAgentTurnLock({ conversation });
  if (!releaseFastAgentLock) {
    console.error(
      `[Discord] Fast turn lock did not become available for ${conversation.workspaceId}:${conversation.conversationId}`,
    );
    return;
  }

  try {
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
    // Resolved ahead of the turn so replies can carry the session footer;
    // the service's own getOrCreate finds this same row.
    const session = await getOrCreateFastAgentSession({
      userId: input.senderUserId,
      conversation,
    });
    const postFastReplyWithFooter = async (text: string) => {
      const footerText = buildFastSessionReplyFooterText({
        provider: 'discord',
        sessionId: session.id,
      });
      const textWithFooter = `${text}\n\n${footerText}`;
      const channelId = conversation.replyTarget.channelId;
      const footerStateThreadId = conversation.replyTarget.threadId ?? 'root';
      const footerMessageChannelId =
        conversation.replyTarget.threadId ?? channelId;

      return deliverManagedThreadReplyFooter({
        provider: 'discord',
        providerLabel: 'Discord',
        channelId,
        footerStateThreadId,
        lockKey: `discord:thread_reply_footer_lock:${channelId}:${footerStateThreadId}`,
        logRef: `fast session ${session.id}`,
        logContext: 'DiscordFastAgent',
        postReplyWithFooter: async () => {
          const posted = await replyToDiscordEvent({
            provider: input.provider,
            applicationId: input.applicationId,
            channel: input.channel,
            ...(input.interaction ? { interaction: input.interaction } : {}),
            ...(message ? { replyToMessageId: message.id } : {}),
            text: textWithFooter,
          });
          return {
            messageId: posted.lastTextMessageId ?? posted.messageId,
            textWithoutFooter: getDiscordFooterlessFinalChunk({
              textWithFooter,
              footerText,
            }),
          };
        },
        clearPreviousFooter: async (previousFooterRecord) => {
          await input.provider.editMessage({
            channelId: footerMessageChannelId,
            messageId: previousFooterRecord.messageId,
            text: previousFooterRecord.textWithoutFooter,
          });
        },
      });
    };
    let didSendVisibleResponse = false;
    const apiBaseUrl = resolveApiBaseUrl() ?? undefined;
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
      apiBaseUrl,
      conversation,
      currentMessageId: message?.id ?? input.interaction?.interaction.id,
      signal: releaseFastAgentLock.signal,
      senderDisplayName:
        input.interaction?.interaction.member?.nick ??
        input.sender.global_name ??
        input.sender.username,
      activeTasks: input.activeTasks,
      adapter: {
        resolveMcpServerConfigs: () =>
          resolveUserMcpServerConfigs({
            userId: input.senderUserId,
            apiBaseUrl,
            includeRoomoteMemberTools: true,
          }),
        launchTask: async ({
          prompt,
          environmentId,
          model,
          parentSessionId,
          postKickoff,
        }) => {
          const workspaceOverride =
            environmentId && environmentId !== ALL_REPOSITORIES
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
              ts: getDiscordFastLaunchSourceEventId({
                eventId: input.event.eventId,
                prompt,
                environmentId,
                model,
              }),
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
            fastAgentParent: {
              sessionId: parentSessionId,
              conversation,
            },
            skipRoutingConfirmation: true,
            model,
            workspaceOverride,
            beforeEnqueueKickoff: postKickoff,
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
              kickoffDelivered: true,
            };
          }
          return {
            success: false,
            error: `Task launch stopped with status ${started.status}.`,
          };
        },
        postReply: async ({ message: text }) => {
          const posted = await postFastReplyWithFooter(text);
          didSendVisibleResponse = true;
          return { messageId: posted.messageId };
        },
        replaceReply: async ({ messageId }, { message: text }) => {
          if (text.length > DISCORD_MAX_MESSAGE_LENGTH) {
            await input.provider.editMessage({
              channelId: input.channel.channelId,
              messageId,
              text: 'Reconnected to the inference provider.',
            });
            const posted = await replyToDiscordEvent({
              provider: input.provider,
              applicationId: input.applicationId,
              channel: input.channel,
              ...(message ? { replyToMessageId: message.id } : {}),
              text,
            });
            didSendVisibleResponse = true;
            return {
              messageId: posted.lastTextMessageId ?? posted.messageId,
            };
          }
          await input.provider.editMessage({
            channelId: input.channel.channelId,
            messageId,
            text,
          });
          didSendVisibleResponse = true;
          return { messageId };
        },
      },
    });
    if (response && !didSendVisibleResponse) {
      await postFastReplyWithFooter(response);
    }
  } finally {
    await releaseFastAgentLock().catch(() => {});
  }
}
