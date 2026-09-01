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
  getThreadReplyFooterRecord,
  resolveFastSessionReplyFooterContext,
  setThreadReplyFooterRecord,
  withThreadReplyFooterLock,
} from '@roomote/communication';
import {
  admitFastAgentHumanFollowUp,
  persistFastAgentInlineHumanTurn,
  recordFastAgentConversationMessageBestEffort,
  resolveUserMcpServerConfigs,
  wakeFastAgentParentEventNow,
  type FastAgentDurableTurn,
} from '@roomote/sdk/server';
import { ALL_REPOSITORIES, type TaskInitiator } from '@roomote/types';

import { buildCommunicationTaskThreadName } from '../tasks/communication-task-thread.js';
import {
  startAcceptedFastAgentTurn,
  type FastAgentStartResult,
} from '../fast-agent-entry.js';
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

const DISCORD_MESSAGE_ANCHORED_CHANNEL_TYPES = new Set([0, 5]);

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

type DiscordFastAgentSource =
  | { event: DiscordGatewayEvent; eventId?: never }
  | { event?: never; eventId: string };

export async function processDiscordFastAgentMessage(
  input: {
    question: string;
    sender: DiscordUser;
    senderUserId: string;
    provider: DiscordCommunicationProvider;
    applicationId: string;
    channel: DiscordChannelContext;
    metadata: ReturnType<typeof discordMetadataForChannel>;
    conversationId: string;
    createAnchoredThread?: boolean;
    /** Real Discord message used for replies and anchored threads. */
    anchorMessageId?: string;
    interaction?: DiscordInteractionReplyContext;
    activeTasks?: { taskId: string }[];
    directedAtRoomote?: boolean;
    /** Attribution for tasks Fast delegates from this turn; automation-identity
     * turns pass their automation initiator so delegated work keeps automation
     * provenance instead of appearing installer-initiated. */
    delegatedTaskInitiator?: TaskInitiator;
    onAccepted?: (abort: () => Promise<void>) => void;
    onRejected?: () => void;
  } & DiscordFastAgentSource,
): Promise<boolean> {
  const message = input.event ? getDiscordMessageCreate(input.event) : null;
  const eventId = 'eventId' in input ? input.eventId : input.event.eventId;
  if (!eventId) {
    throw new Error('Discord Fast entry requires a source event id.');
  }
  const anchorMessageId = input.anchorMessageId ?? message?.id;
  let channel = input.channel;
  let metadata = input.metadata;
  if (
    message &&
    anchorMessageId &&
    input.createAnchoredThread !== false &&
    !channel.isDirectMessage &&
    !channel.isThread &&
    DISCORD_MESSAGE_ANCHORED_CHANNEL_TYPES.has(channel.channelType)
  ) {
    const thread = await input.provider.createThreadFromMessage({
      channelId: channel.channelId,
      messageId: anchorMessageId,
      name: buildCommunicationTaskThreadName(input.question),
    });
    channel = {
      ...channel,
      channelId: thread.channelId,
      channelName: thread.name,
      channelType: channel.channelType === 5 ? 10 : 11,
      parentChannelId: thread.parentChannelId,
      isThread: true,
    };
    metadata = {
      ...metadata,
      communicationChannelId: thread.parentChannelId,
      communicationThreadId: thread.channelId,
    };
  }

  const conversation = {
    surface: 'discord' as const,
    workspaceId: channel.guildId ?? 'dm',
    conversationId: input.conversationId,
    replyTarget: {
      channelId: metadata.communicationChannelId,
      ...(metadata.communicationThreadId
        ? { threadId: metadata.communicationThreadId }
        : {}),
    },
  };
  let releaseFastAgentLock = await acquireFastAgentTurnLock({
    conversation,
    maxWaitMs: 0,
  });

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
    // Resolved ahead of the turn so replies can carry the session footer;
    // the service's own getOrCreate finds this same row.
    const session = await getOrCreateFastAgentSession({
      userId: input.senderUserId,
      conversation,
    });
    const humanFollowUpEvent = {
      type: 'human_follow_up' as const,
      eventId,
      currentMessageId: anchorMessageId ?? eventId,
      userId: input.senderUserId,
      question: input.question,
      senderDisplayName:
        input.interaction?.interaction.member?.nick ??
        input.sender.global_name ??
        input.sender.username,
      senderExternalId: input.sender.id,
    };
    let durableTurn: FastAgentDurableTurn | null = null;
    if (!releaseFastAgentLock) {
      const admission = await admitFastAgentHumanFollowUp({
        parent: { sessionId: session.id, conversation },
        event: humanFollowUpEvent,
      });
      if (admission.kind !== 'turn') {
        input.onAccepted?.(admission.abort);
        return true;
      }
      releaseFastAgentLock = admission.turnLock;
      durableTurn = admission.durable;
    }
    if (!releaseFastAgentLock) {
      input.onRejected?.();
      return false;
    }
    const activeTurnLock = releaseFastAgentLock;
    // Durable admission: the turn is persisted under this process's claim
    // before it runs, so an interruption hands it to the queue.
    durableTurn ??= await persistFastAgentInlineHumanTurn({
      parent: { sessionId: session.id, conversation },
      event: humanFollowUpEvent,
    }).catch((error) => {
      console.error(
        `[DiscordFastAgent] Failed to persist Fast turn admission: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });
    const durableTurnForResume = durableTurn;
    const footerContext = await resolveFastSessionReplyFooterContext({
      sessionId: session.id,
    });
    input.onAccepted?.(() =>
      activeTurnLock.abort(
        new Error('Fast suggestion launch settlement failed.'),
      ),
    );
    const postFastReplyWithFooter = async (text: string) => {
      const footerText = buildFastSessionReplyFooterText({
        provider: 'discord',
        sessionId: session.id,
        ...footerContext,
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
            channel,
            ...(input.interaction ? { interaction: input.interaction } : {}),
            ...(anchorMessageId ? { replyToMessageId: anchorMessageId } : {}),
            text: textWithFooter,
          });
          await recordFastAgentConversationMessageBestEffort({
            sessionId: session.id,
            conversation,
            messageId: posted.lastTextMessageId ?? posted.messageId,
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
      currentMessageId: anchorMessageId ?? input.interaction?.interaction.id,
      signal: activeTurnLock.signal,
      ...(durableTurnForResume
        ? { durableAdmission: { eventId: durableTurnForResume.id } }
        : {}),
      senderDisplayName:
        input.interaction?.interaction.member?.nick ??
        input.sender.global_name ??
        input.sender.username,
      activeTasks: input.activeTasks,
      allowSilentAmbientReply:
        !input.directedAtRoomote &&
        history.some(
          (entry) =>
            !entry.botId &&
            Boolean(entry.user) &&
            entry.user !== input.sender.id,
        ),
      adapter: {
        ...(durableTurnForResume
          ? {
              requestDurableResume: () =>
                wakeFastAgentParentEventNow({
                  conversationId: session.id,
                  eventKey: durableTurnForResume.eventKey,
                }),
            }
          : {}),
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
            ...(input.delegatedTaskInitiator
              ? { initiator: input.delegatedTaskInitiator }
              : {}),
            queuedMessage: {
              provider: 'discord',
              text: prompt,
              user: input.sender.global_name?.trim() || input.sender.username,
              userId: input.senderUserId,
              ts: getDiscordFastLaunchSourceEventId({
                eventId,
                prompt,
                environmentId,
                model,
              }),
              channel: metadata.communicationChannelId,
              ...(metadata.communicationThreadId
                ? { threadTs: metadata.communicationThreadId }
                : {}),
              turnPolicy: { reactionsAllowed: true },
            },
            metadata,
            channel,
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
          const footerText = buildFastSessionReplyFooterText({
            provider: 'discord',
            sessionId: session.id,
            ...footerContext,
          });
          const footerChannelId = conversation.replyTarget.channelId;
          const footerStateThreadId =
            conversation.replyTarget.threadId ?? 'root';

          // The carrier check, edit, and record write must share the footer
          // lock, or a concurrent reply can relocate the footer in between
          // and this replacement would re-mark the old message as carrier.
          const replaced = await withThreadReplyFooterLock({
            lockKey: `discord:thread_reply_footer_lock:${footerChannelId}:${footerStateThreadId}`,
            fn: async () => {
              const footerRecord = await getThreadReplyFooterRecord(
                'discord',
                footerChannelId,
                footerStateThreadId,
              ).catch(() => null);
              const isFooterCarrier = footerRecord?.messageId === messageId;
              const replacementText = isFooterCarrier
                ? `${text}\n\n${footerText}`
                : text;

              if (replacementText.length > DISCORD_MAX_MESSAGE_LENGTH) {
                const placeholder = 'Reconnected to the inference provider.';
                await input.provider.editMessage({
                  channelId: channel.channelId,
                  messageId,
                  text: isFooterCarrier
                    ? `${placeholder}\n\n${footerText}`
                    : placeholder,
                });
                if (isFooterCarrier) {
                  // The relocation that follows rewrites this message to its
                  // stored footerless text; keep that text current so the
                  // edit does not resurrect the pre-retry notice.
                  await setThreadReplyFooterRecord(
                    'discord',
                    footerChannelId,
                    footerStateThreadId,
                    { messageId, textWithoutFooter: placeholder },
                  ).catch(() => {});
                }
                return false;
              }

              await input.provider.editMessage({
                channelId: channel.channelId,
                messageId,
                text: replacementText,
              });
              if (isFooterCarrier) {
                await setThreadReplyFooterRecord(
                  'discord',
                  footerChannelId,
                  footerStateThreadId,
                  { messageId, textWithoutFooter: text },
                ).catch(() => {});
              }
              return true;
            },
          });

          if (!replaced) {
            // The oversized replacement posts as a new message; the sticky
            // post takes the lock itself, so it runs outside ours.
            const posted = await postFastReplyWithFooter(text);
            didSendVisibleResponse = true;
            return { messageId: posted.messageId };
          }
          didSendVisibleResponse = true;
          return { messageId };
        },
      },
    });
    if (response && !didSendVisibleResponse) {
      await postFastReplyWithFooter(response);
    }
  } finally {
    await releaseFastAgentLock?.().catch(() => {});
  }
  return true;
}

export function startDiscordFastAgentResponse(
  input: Parameters<typeof processDiscordFastAgentMessage>[0],
): Promise<FastAgentStartResult> {
  return startAcceptedFastAgentTurn({
    run: ({ onAccepted, onRejected }) =>
      processDiscordFastAgentMessage({
        ...input,
        onAccepted,
        onRejected,
      }),
    onError: (error) => {
      console.error(
        `[Discord] Fast suggestion response failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}
