import { Hono, type Context } from 'hono';

import {
  discordEventToQueuedCommunicationMessage,
  getDiscordInteractionCommand,
  getDiscordInteractionCreate,
  getDiscordInteractionUser,
  getDiscordMessageAttachments,
  getDiscordMessageContent,
  getDiscordMessageCreate,
  getDiscordReactionAdd,
  isDiscordAudioAttachment,
  isDiscordBotMentioned,
  isDiscordTaskEntryEvent,
  parseDiscordGatewayEvent,
  type DiscordGatewayEvent,
} from '@roomote/communication/discord-event';
import {
  DiscordApiError,
  DiscordApiTransportError,
} from '@roomote/communication/discord-provider';
import { reactionEmojiMatches } from '@roomote/communication/reaction-emoji';
import {
  buildFastAgentReactionExternalInputQuestion,
  hasFastAgentSession,
  type FastAgentReactionExternalInput,
} from '@roomote/cloud-agents/server';
import {
  RunStatus,
  activeRunStatuses,
  isSnapshotResumable,
} from '@roomote/types';
import {
  consumeDiscordLinkCode,
  findDiscordInstallationByGuildId,
  findDiscordMappedUserId,
  findFastAgentSessionForProviderMessage,
  findFastAgentSessionForProviderReply,
  isFastAgentProviderMessage,
  queueFastAgentSurfaceReply,
  restoreDiscordLinkCode,
  upsertDiscordInstallation,
  upsertDiscordUserMapping,
  enqueueDiscordGatewayEvent,
} from '@roomote/sdk/server';

import { apiLogger } from '../../logging.js';
import { getCallRoomoteViaEmojiConfiguration } from '../call-roomote-via-emoji.js';
import { buildCommunicationTaskThreadName } from '../tasks/communication-task-thread.js';
import {
  findActiveCommunicationTaskRun,
  findCompletedCommunicationTaskRunWithSnapshot,
  findTaskBackedAutomationReportRun,
} from '@roomote/sdk/server/communication';
import { promptDiscordAccountLink } from './account-link.js';
import { processDiscordAttachments } from './attachments.js';
import {
  DISCORD_GATEWAY_SECRET_HEADER,
  verifyDiscordGatewaySecret,
} from './auth.js';
import {
  handleDiscordComponentInteraction,
  handleDiscordSuggestionReaction,
} from './callback-actions.js';
import { maybeHandleDiscordChannelAutoStart } from './channel-auto-start.js';
import {
  getDiscordFastConversationId,
  processDiscordFastAgentMessage,
} from './fast-agent.js';
import {
  claimPendingDiscordAccountLinkTask,
  rememberPendingDiscordAccountLinkTask,
} from './pending-account-link-task.js';
import {
  claimDiscordApiEvent,
  completeDiscordApiEvent,
  discordApiEventLeaseRenewal,
  releaseDiscordApiEvent,
  renewDiscordApiEvent,
} from './event-gate.js';
import {
  DiscordProviderNotConfiguredError,
  resolveDiscordProvider,
} from './provider.js';
import { replyToDiscordEvent } from './replies.js';
import {
  discordMetadataForChannel,
  resolveDiscordChannelContext,
} from './task-launch.js';
import { startDiscordTaskGoal } from './goal-command.js';
import {
  fetchDiscordRepliedToMessageBestEffort,
  fetchDiscordThreadHistoryBestEffort,
} from './thread-context.js';
import { shouldRouteUnmentionedDiscordThreadReplyToAgent } from './unmentioned-thread-reply.js';

export const discordGatewayEventProcessingTimeout = {
  timeoutMs: 4 * 60 * 1000,
};

class DiscordGatewayEventProcessingTimeoutError extends Error {
  constructor() {
    super('Discord Gateway event processing timed out');
  }
}

function withDiscordGatewayEventProcessingTimeout<T>(
  promise: Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DiscordGatewayEventProcessingTimeoutError()),
      discordGatewayEventProcessingTimeout.timeoutMs,
    );

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function renewDiscordApiEventLease(input: {
  eventType: string;
  eventId: string;
  token: string;
}): () => void {
  const interval = setInterval(() => {
    void renewDiscordApiEvent(input).catch((error) => {
      apiLogger.warn(
        `[discord] Failed to renew event lease ${input.eventId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, discordApiEventLeaseRenewal.intervalMs);
  interval.unref();
  return () => clearInterval(interval);
}

const DISCORD_HELP_MESSAGE = [
  "👋 I'm Roomote. Mention me in a server channel or message me directly to start a task.",
  '',
  '**Available commands**',
  '`/new request:<request>` — start a fresh task.',
  '`/goal objective:<objective>` — keep working toward an objective across multiple turns.',
  '`/link code:<code>` — link this Discord account in a DM with me.',
  '`/help` — show this message.',
  '',
  'Follow up by sending another message in the task thread.',
].join('\n');

function isPermanentDiscordEventError(
  error: unknown,
): error is DiscordApiError {
  return (
    error instanceof DiscordApiError &&
    (error.status === 403 || error.status === 404)
  );
}

function isRetryableDiscordProviderError(
  error: unknown,
): error is DiscordApiError | DiscordApiTransportError {
  if (error instanceof DiscordApiTransportError) return true;
  return (
    error instanceof DiscordApiError &&
    (error.status === 401 ||
      error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500)
  );
}

function interactionReplyContext(event: DiscordGatewayEvent) {
  const interaction = getDiscordInteractionCreate(event);
  if (!interaction) {
    throw new Error('Discord interaction reply requires an interaction event.');
  }
  return {
    interaction,
    interactionDeferred: event.interactionDeferred === true,
  };
}

async function rememberDiscordContextBestEffort(input: {
  applicationId: string;
  botUserId: string;
  guildId?: string;
}): Promise<void> {
  if (!input.guildId) return;
  try {
    const existing = await findDiscordInstallationByGuildId(input.guildId);
    if (
      !existing ||
      existing.applicationId !== input.applicationId ||
      existing.botUserId !== input.botUserId
    ) {
      await upsertDiscordInstallation({
        guildId: input.guildId,
        ...(existing?.guildName ? { guildName: existing.guildName } : {}),
        applicationId: input.applicationId,
        botUserId: input.botUserId,
      });
    }
  } catch (error) {
    apiLogger.warn(
      `[discord] Failed to record guild ${input.guildId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function refreshDiscordUserMappingBestEffort(input: {
  discordUserId: string;
  discordUsername?: string | null;
  discordGlobalName?: string | null;
  discordDmChannelId?: string | null;
  userId: string;
}): Promise<void> {
  try {
    await upsertDiscordUserMapping(input);
  } catch (error) {
    apiLogger.warn(
      `[discord] Failed to refresh linked user ${input.discordUserId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

type DiscordReactionTarget = { channelId: string; messageId: string };

function getPersistedDiscordReactionTarget(
  event: DiscordGatewayEvent,
): DiscordReactionTarget | undefined {
  const value = event.reactionTarget;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const target = value as Record<string, unknown>;
  return typeof target.channelId === 'string' &&
    typeof target.messageId === 'string'
    ? { channelId: target.channelId, messageId: target.messageId }
    : undefined;
}

async function processDiscordGatewayEvent(
  event: DiscordGatewayEvent,
  options: {
    reactionTarget?: DiscordReactionTarget;
  } = {},
) {
  const reactionTarget =
    options.reactionTarget ?? getPersistedDiscordReactionTarget(event);
  const reaction = getDiscordReactionAdd(event);
  if (reaction) {
    const resolved = await resolveDiscordProvider();
    if (reaction.user_id === resolved.botUserId || !reaction.emoji.name) {
      return { ok: true, ignored: 'bot_or_missing_reaction' };
    }

    if (reactionEmojiMatches('thumbsup', reaction.emoji.name)) {
      const channel = await resolveDiscordChannelContext(
        resolved.provider,
        reaction.channel_id,
      );
      const author = reaction.member?.user ?? {
        id: reaction.user_id,
        username: `Discord user ${reaction.user_id}`,
      };
      const handled = await handleDiscordSuggestionReaction({
        provider: resolved.provider,
        applicationId: resolved.applicationId,
        channel,
        channelId: reaction.channel_id,
        messageId: reaction.message_id,
        eventId: event.eventId,
        sender: author,
        senderDisplayName:
          typeof reaction.member?.nick === 'string'
            ? reaction.member.nick
            : undefined,
      });
      if (handled) {
        return { ok: true, suggestionStarted: true };
      }
    }

    const configuration = await getCallRoomoteViaEmojiConfiguration(
      reaction.emoji.name,
    );
    if (!configuration) {
      const channel = await resolveDiscordChannelContext(
        resolved.provider,
        reaction.channel_id,
      );
      const metadata = discordMetadataForChannel({
        channel,
        messageId: reaction.message_id,
      });
      const session = await findFastAgentSessionForProviderMessage({
        provider: 'discord',
        workspaceId: channel.guildId ?? 'dm',
        channelId: metadata.communicationChannelId,
        ...(metadata.communicationThreadId
          ? { threadId: metadata.communicationThreadId }
          : {}),
        messageId: reaction.message_id,
      });
      if (!session) {
        return { ok: true, ignored: 'reaction_not_configured' };
      }

      const senderUserId = await findDiscordMappedUserId(reaction.user_id);
      if (!senderUserId) {
        await promptDiscordAccountLink({
          provider: resolved.provider,
          applicationId: resolved.applicationId,
          channel,
          discordUserId: reaction.user_id,
          replyToMessageId: reaction.message_id,
        });
        return { ok: true, ignored: 'discord_reactor_not_linked' };
      }
      if (session.userId !== senderUserId) {
        return { ok: true, ignored: 'discord_fast_session_user_mismatch' };
      }

      const author = reaction.member?.user ?? {
        id: reaction.user_id,
        username: `Discord user ${reaction.user_id}`,
      };
      const senderDisplayName =
        (typeof reaction.member?.nick === 'string'
          ? reaction.member.nick
          : undefined) ??
        (typeof author.global_name === 'string'
          ? author.global_name
          : undefined) ??
        author.username;
      const reactionInput: FastAgentReactionExternalInput = {
        type: 'reaction_added',
        provider: 'discord',
        reactions: [
          {
            name: reaction.emoji.name,
            ...(reaction.emoji.id ? { id: reaction.emoji.id } : {}),
          },
        ],
        reactor: {
          externalUserId: reaction.user_id,
          ...(senderDisplayName ? { displayName: senderDisplayName } : {}),
        },
        message: {
          workspaceId: channel.guildId ?? 'dm',
          channelId: metadata.communicationChannelId,
          messageId: reaction.message_id,
          ...(metadata.communicationThreadId
            ? { threadId: metadata.communicationThreadId }
            : {}),
        },
        eventId: event.eventId,
      };
      const queued = await queueFastAgentSurfaceReply({
        sessionId: session.id,
        userId: senderUserId,
        senderDisplayName,
        question: buildFastAgentReactionExternalInputQuestion(reactionInput),
        currentMessageId: `discord-reaction:${event.eventId}`,
        replyToMessageId: reaction.message_id,
        externalInput: reactionInput,
      });
      return queued
        ? { ok: true, fastReactionQueued: true }
        : { ok: true, ignored: 'discord_fast_reaction_route_unavailable' };
    }

    const author = reaction.member?.user ?? {
      id: reaction.user_id,
      username: `Discord user ${reaction.user_id}`,
    };
    return processDiscordGatewayEvent(
      {
        eventId: event.eventId,
        eventType: 'MESSAGE_CREATE',
        receivedAt: event.receivedAt,
        reactionTarget: {
          channelId: reaction.channel_id,
          messageId: reaction.message_id,
        },
        payload: {
          id: event.eventId,
          channel_id: reaction.channel_id,
          ...(reaction.guild_id ? { guild_id: reaction.guild_id } : {}),
          content: `<@${resolved.botUserId}> ${configuration.prompt}`,
          author,
          mentions: [
            {
              id: resolved.botUserId,
              username: 'Roomote',
              bot: true,
            },
          ],
          attachments: [],
          message_reference: {
            message_id: reaction.message_id,
            channel_id: reaction.channel_id,
          },
        },
      },
      {
        reactionTarget: {
          channelId: reaction.channel_id,
          messageId: reaction.message_id,
        },
      },
    );
  }

  const interaction = getDiscordInteractionCreate(event);
  const message = getDiscordMessageCreate(event);
  const resolved = await resolveDiscordProvider();
  const channelId = interaction?.channel_id ?? message?.channel_id;
  if (!channelId) {
    return { ok: true, ignored: 'missing_channel' };
  }
  const channel = await resolveDiscordChannelContext(
    resolved.provider,
    channelId,
  );
  await rememberDiscordContextBestEffort({
    applicationId: resolved.applicationId,
    botUserId: resolved.botUserId,
    guildId: channel.guildId,
  });
  const metadata = discordMetadataForChannel({
    channel,
    messageId: reactionTarget?.messageId ?? event.eventId,
    // Only a real channel message provides an anchor for the task thread;
    // interactions (slash commands, buttons) do not.
    ...(reactionTarget?.messageId
      ? { anchorMessageId: reactionTarget.messageId }
      : message?.id
        ? { anchorMessageId: message.id }
        : {}),
  });

  if (interaction?.type === 3) {
    const result = await handleDiscordComponentInteraction({
      provider: resolved.provider,
      applicationId: resolved.applicationId,
      interaction,
      interactionDeferred: event.interactionDeferred === true,
      channel,
    });
    return { ok: true, component: result };
  }

  // Auto-respond channels run first, mirroring Slack: a message in a
  // configured channel — mentioned or not, bot- or human-authored — is
  // consumed here and never reaches the mention/task-entry gating below.
  if (message && !interaction && !reactionTarget) {
    const handledAsChannelAutoStart = await maybeHandleDiscordChannelAutoStart({
      event,
      message,
      channel,
      provider: resolved.provider,
      applicationId: resolved.applicationId,
      botUserId: resolved.botUserId,
    });
    if (handledAsChannelAutoStart) {
      return { ok: true, channelAutoStart: true };
    }
  }

  const command = getDiscordInteractionCommand(event);
  const sender = interaction
    ? getDiscordInteractionUser(interaction)
    : message?.author;
  if (!sender || sender.bot) {
    return { ok: true, ignored: 'bot_or_missing_sender' };
  }

  if (command?.name === 'help') {
    await replyToDiscordEvent({
      provider: resolved.provider,
      applicationId: resolved.applicationId,
      channel,
      interaction: interactionReplyContext(event),
      text: DISCORD_HELP_MESSAGE,
      ephemeral: true,
    });
    return { ok: true, helped: true };
  }

  if (command?.name === 'link') {
    if (!channel.isDirectMessage) {
      await replyToDiscordEvent({
        provider: resolved.provider,
        applicationId: resolved.applicationId,
        channel,
        interaction: interactionReplyContext(event),
        text: 'Run `/link` in a direct message with me so Roomote can verify that it can reach you. Your link code has not been used.',
        ephemeral: true,
      });
      return { ok: true, linked: false, reason: 'link_requires_dm' };
    }
    const linkedUserId = command.code
      ? await consumeDiscordLinkCode(command.code)
      : null;
    if (!linkedUserId) {
      await replyToDiscordEvent({
        provider: resolved.provider,
        applicationId: resolved.applicationId,
        channel,
        interaction: interactionReplyContext(event),
        text: 'That link code is invalid or has expired. Generate a fresh code in Roomote and try again.',
        ephemeral: true,
      });
      return { ok: true, linked: false, reason: 'invalid_link_code' };
    }
    try {
      await upsertDiscordUserMapping({
        discordUserId: sender.id,
        discordUsername: sender.username,
        discordGlobalName: sender.global_name ?? null,
        ...(channel.isDirectMessage
          ? { discordDmChannelId: channel.channelId }
          : {}),
        userId: linkedUserId,
      });
    } catch (error) {
      await restoreDiscordLinkCode(command.code!, linkedUserId);
      throw error;
    }
    const pendingTask = await claimPendingDiscordAccountLinkTask(
      sender.id,
    ).catch((error) => {
      apiLogger.warn(
        `[discord] Failed to claim pending task after linking user ${sender.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });
    if (pendingTask) {
      try {
        await processDiscordGatewayEvent(pendingTask);
      } catch (error) {
        await Promise.allSettled([
          rememberPendingDiscordAccountLinkTask({
            discordUserId: sender.id,
            event: pendingTask,
          }),
          restoreDiscordLinkCode(command.code!, linkedUserId),
        ]);
        throw error;
      }
    }
    await replyToDiscordEvent({
      provider: resolved.provider,
      applicationId: resolved.applicationId,
      channel,
      interaction: interactionReplyContext(event),
      text: [
        '✅ Linked! This Discord account is now connected to your Roomote account. Tasks you start here are attributed to you.',
        ...(pendingTask
          ? ['I also picked up your most recent task request.']
          : []),
        DISCORD_HELP_MESSAGE,
      ].join('\n\n'),
      ephemeral: true,
    });
    return { ok: true, linked: true };
  }

  if (command && command.name !== 'new') {
    if (command.name === 'goal') {
      // Handled after resolving the current conversation and linked user.
    } else {
      return { ok: true, ignored: 'unsupported_command' };
    }
  }
  if (command?.name === 'new' && !command.request) {
    await replyToDiscordEvent({
      provider: resolved.provider,
      applicationId: resolved.applicationId,
      channel,
      interaction: interactionReplyContext(event),
      text: 'Add what you want Roomote to do in the `request` field.',
    });
    return { ok: true, started: false, reason: 'missing_request' };
  }

  const senderUserId = await findDiscordMappedUserId(sender.id);
  const conversation = {
    provider: 'discord' as const,
    channelId: metadata.communicationChannelId,
    ...(metadata.communicationThreadId
      ? { threadId: metadata.communicationThreadId }
      : {}),
  };
  const forceNewTask = command?.name === 'new';
  const repliedFastSession =
    !forceNewTask && message?.message_reference?.message_id
      ? await findFastAgentSessionForProviderReply({
          provider: 'discord',
          workspaceId: channel.guildId ?? 'dm',
          channelId: metadata.communicationChannelId,
          ...(metadata.communicationThreadId
            ? { threadId: metadata.communicationThreadId }
            : {}),
          replyToMessageId: message.message_reference.message_id,
        })
      : null;
  if (
    !forceNewTask &&
    !repliedFastSession &&
    message?.message_reference?.message_id &&
    (await isFastAgentProviderMessage({
      provider: 'discord',
      messageId: message.message_reference.message_id,
    }))
  ) {
    return { ok: true, ignored: 'discord_fast_session_route_mismatch' };
  }
  if (
    repliedFastSession &&
    channel.isDirectMessage &&
    repliedFastSession.userId !== senderUserId
  ) {
    return { ok: true, ignored: 'discord_fast_session_user_mismatch' };
  }
  const repliedToAutomationReport =
    !forceNewTask &&
    !repliedFastSession &&
    message?.message_reference?.message_id
      ? await findTaskBackedAutomationReportRun({
          provider: 'discord',
          channelId: metadata.communicationChannelId,
          messageId: message.message_reference.message_id,
        })
      : null;
  const activeRun =
    !forceNewTask && repliedToAutomationReport
      ? activeRunStatuses.some(
          (status) => status === repliedToAutomationReport.status,
        )
        ? repliedToAutomationReport
        : undefined
      : forceNewTask
        ? undefined
        : await findActiveCommunicationTaskRun(conversation);
  const completedRun =
    forceNewTask || activeRun
      ? null
      : repliedToAutomationReport
        ? repliedToAutomationReport.status === RunStatus.Completed &&
          repliedToAutomationReport.snapshotId &&
          isSnapshotResumable(repliedToAutomationReport.snapshotCreatedAt)
          ? repliedToAutomationReport
          : null
        : await findCompletedCommunicationTaskRunWithSnapshot(conversation);
  const isFastAgentConversation = Boolean(
    repliedFastSession ??
    (channel.isThread || channel.isDirectMessage
      ? await hasFastAgentSession({
          surface: 'discord',
          workspaceId: channel.guildId ?? 'dm',
          conversationId: channel.channelId,
          replyTarget: {
            channelId: metadata.communicationChannelId,
            ...(channel.isThread ? { threadId: channel.channelId } : {}),
          },
        })
      : false),
  );
  const isRoomoteThread = Boolean(
    activeRun ||
    completedRun ||
    repliedToAutomationReport ||
    isFastAgentConversation,
  );
  const isTaskEntry = isDiscordTaskEntryEvent(event, {
    botUserId: resolved.botUserId,
    isTaskThread: isRoomoteThread,
    parentChannelId: channel.parentChannelId,
  });
  if (!isTaskEntry) {
    return { ok: true, ignored: 'not_task_entry' };
  }

  if (!senderUserId) {
    // Mirror Slack: unlinked people chatting in a task thread without
    // @mentioning Roomote are ignored. Only explicit task entry (DM,
    // @mention, or slash command) should nudge them to link.
    const addressedBot =
      Boolean(command) ||
      channel.isDirectMessage ||
      (message != null && isDiscordBotMentioned(message, resolved.botUserId));
    if (!addressedBot) {
      apiLogger.debug(
        `[discord] Ignoring unaddressed task-thread message from unlinked Discord sender ${sender.id}`,
      );
      return {
        ok: true,
        ignored: 'discord_sender_not_linked_unmentioned',
      };
    }

    await rememberPendingDiscordAccountLinkTask({
      discordUserId: sender.id,
      event,
    }).catch((error) => {
      apiLogger.warn(
        `[discord] Failed to remember pending task for unlinked user ${sender.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    await promptDiscordAccountLink({
      provider: resolved.provider,
      applicationId: resolved.applicationId,
      channel,
      discordUserId: sender.id,
      ...(interaction ? { interaction: interactionReplyContext(event) } : {}),
      ...(reactionTarget?.messageId
        ? { replyToMessageId: reactionTarget.messageId }
        : message?.id
          ? { replyToMessageId: message.id }
          : {}),
    });
    return {
      ok: true,
      queued: false,
      reason: 'discord_sender_not_linked',
    };
  }

  // Mirror Slack/Teams: unmentioned guild-thread follow-ups only route when the
  // sender is already in the conversation and nobody else interjected since
  // the bot's last reply. Explicit @mentions, DMs, and slash commands stay on
  // the normal task-entry path above.
  if (
    message &&
    !channel.isDirectMessage &&
    !command &&
    !isDiscordBotMentioned(message, resolved.botUserId) &&
    !repliedFastSession &&
    isRoomoteThread
  ) {
    const shouldRouteUnmentioned =
      await shouldRouteUnmentionedDiscordThreadReplyToAgent({
        message,
        botUserId: resolved.botUserId,
        mappedUserId: senderUserId,
        isRoomoteThread: true,
        ownedThreadUserId:
          activeRun?.userId ??
          completedRun?.userId ??
          repliedToAutomationReport?.userId ??
          null,
        isAutomationReportThread: Boolean(repliedToAutomationReport),
        isOpenConversationThread: isFastAgentConversation,
        fetchThreadMessages: async () => {
          const history = await fetchDiscordThreadHistoryBestEffort({
            provider: resolved.provider,
            channelId: channel.channelId,
            ...(channel.parentChannelId
              ? { parentChannelId: channel.parentChannelId }
              : {}),
          });
          return history.length > 0 ? history : null;
        },
      });
    if (!shouldRouteUnmentioned) {
      apiLogger.debug(
        `[discord] Ignoring unmentioned guild-thread reply from ${sender.id} (requires @mention after interjection or ineligible sender)`,
      );
      return {
        ok: true,
        ignored: 'discord_unmentioned_requires_mention',
      };
    }
  }
  await refreshDiscordUserMappingBestEffort({
    discordUserId: sender.id,
    discordUsername: sender.username,
    discordGlobalName: sender.global_name ?? null,
    ...(channel.isDirectMessage
      ? { discordDmChannelId: channel.channelId }
      : {}),
    userId: senderUserId,
  });

  // Fast mode is unconditional for ordinary linked-human messages, including
  // reaction summons: a configured emoji synthesizes a bot mention that enters
  // the fast agent, matching Slack's call-roomote-via-emoji flow.
  const defaultFastMessage =
    message != null && command == null ? message : null;

  if (command?.name === 'goal') {
    if (!command.objective) {
      await replyToDiscordEvent({
        provider: resolved.provider,
        applicationId: resolved.applicationId,
        channel,
        interaction: interactionReplyContext(event),
        text: 'Add what you want Roomote to keep working toward in the `objective` field.',
        ephemeral: true,
      });
      return { ok: true, goalStarted: false, reason: 'missing_objective' };
    }
    if (!activeRun) {
      await replyToDiscordEvent({
        provider: resolved.provider,
        applicationId: resolved.applicationId,
        channel,
        interaction: interactionReplyContext(event),
        text: 'Use `/goal` in an active Roomote task thread or DM. Start a task with `/new` or mention me first.',
        ephemeral: true,
      });
      return { ok: true, goalStarted: false, reason: 'no_active_task' };
    }

    const result = await startDiscordTaskGoal({
      taskId: activeRun.taskId,
      userId: senderUserId,
      objective: command.objective,
      clientMessageId: interaction?.id ?? event.eventId,
    });
    await replyToDiscordEvent({
      provider: resolved.provider,
      applicationId: resolved.applicationId,
      channel,
      interaction: interactionReplyContext(event),
      text: result.success ? 'Goal Mode enabled.' : result.error,
      ephemeral: true,
    });
    return { ok: true, goalStarted: result.success, runId: activeRun.id };
  }

  const messageAttachments = message
    ? getDiscordMessageAttachments(message)
    : [];
  const processedAttachments = messageAttachments.length
    ? messageAttachments.some(isDiscordAudioAttachment)
      ? await processDiscordAttachments(messageAttachments, {
          userId: senderUserId,
          userTextContext: message
            ? getDiscordMessageContent(message)
            : undefined,
        })
      : await processDiscordAttachments(messageAttachments)
    : { images: [], attachmentTexts: [], warnings: [] };
  for (const warning of processedAttachments.warnings) {
    apiLogger.warn(`[discord] Attachment warning: ${warning}`);
  }
  // The queued-message builder already folds attachment summaries and any
  // extracted attachment text into one prompt, so an attachment-only message
  // still has something to say to Fast.
  const fastEntryText = message
    ? (discordEventToQueuedCommunicationMessage(event, {
        botUserId: resolved.botUserId,
        userId: senderUserId,
        isTaskThread: isRoomoteThread,
        parentChannelId: channel.parentChannelId,
        attachmentImages: processedAttachments.images,
        attachmentText: processedAttachments.attachmentTexts,
      })?.text ?? '')
    : '';
  const fastAttachments = processedAttachments.images.length
    ? { images: processedAttachments.images }
    : {};

  if (command?.name === 'new' && command.request && interaction) {
    // `/new` opens a fresh conversation. In a server it gets its own thread
    // beside the current one; a DM keeps one conversation, so the request
    // simply joins it.
    let fastChannel = channel;
    let fastMetadata = metadata;
    if (!channel.isDirectMessage) {
      const parentId = channel.parentChannelId ?? channel.channelId;
      const thread = await resolved.provider.createTaskThread({
        channelId: parentId,
        name: buildCommunicationTaskThreadName(command.request),
        initialText: `Request from ${getDiscordInteractionUser(interaction)?.global_name?.trim() || sender.username}:\n\n${command.request}`,
      });
      fastChannel = {
        ...channel,
        channelId: thread.channelId,
        channelName: thread.name,
        channelType: channel.channelType === 5 ? 10 : 11,
        parentChannelId: thread.parentChannelId,
        isThread: true,
      };
      fastMetadata = {
        ...metadata,
        communicationChannelId: thread.parentChannelId,
        communicationThreadId: thread.channelId,
      };
    }
    await processDiscordFastAgentMessage({
      event,
      question: command.request,
      sender,
      senderUserId,
      provider: resolved.provider,
      applicationId: resolved.applicationId,
      channel: fastChannel,
      metadata: fastMetadata,
      conversationId: getDiscordFastConversationId(fastChannel, interaction.id),
      createAnchoredThread: false,
      interaction: interactionReplyContext(event),
      directedAtRoomote: true,
    });
    return { ok: true, fastAnswered: true, fastStartedNew: true };
  }

  if (message && !command && isFastAgentConversation) {
    const question = fastEntryText;
    if (question) {
      await processDiscordFastAgentMessage({
        event,
        question,
        ...fastAttachments,
        sender,
        senderUserId,
        provider: resolved.provider,
        applicationId: resolved.applicationId,
        channel,
        metadata,
        conversationId:
          repliedFastSession?.conversation.conversationId ?? channel.channelId,
        ...(repliedFastSession ? { createAnchoredThread: false } : {}),
        // A reaction summon's synthesized message id is not a real Discord
        // message; anchor replies on the reacted-on message instead.
        ...(reactionTarget
          ? { anchorMessageId: reactionTarget.messageId }
          : {}),
        activeTasks: activeRun ? [{ taskId: activeRun.taskId }] : [],
        directedAtRoomote:
          channel.isDirectMessage ||
          Boolean(repliedFastSession) ||
          isDiscordBotMentioned(message, resolved.botUserId),
      });
      return { ok: true, fastAnswered: true, fastContinued: true };
    }
  }
  const defaultFastQuestion = defaultFastMessage ? fastEntryText : '';
  if (defaultFastMessage && defaultFastQuestion) {
    let fastQuestion = defaultFastQuestion;
    let agentContext: string | undefined;
    if (
      !reactionTarget &&
      !channel.isThread &&
      !channel.isDirectMessage &&
      defaultFastMessage.message_reference?.message_id
    ) {
      // A channel-level reply mention carries the message it answers, the
      // way a task launch used to, without dumping whole-channel history.
      const repliedTo = await fetchDiscordRepliedToMessageBestEffort({
        provider: resolved.provider,
        channelId:
          defaultFastMessage.message_reference.channel_id ?? channel.channelId,
        messageId: defaultFastMessage.message_reference.message_id,
      });
      if (repliedTo?.text) {
        agentContext = `The person is replying to this Discord message from ${repliedTo.username ?? repliedTo.user}:\n${repliedTo.text}`;
      }
    }
    if (reactionTarget) {
      // Match Slack's emoji summon: inline the reacted-on message so the fast
      // agent sees what it was asked to act on even without thread history.
      try {
        const targetMessage = await resolved.provider.getMessage({
          channelId: reactionTarget.channelId,
          messageId: reactionTarget.messageId,
        });
        if (targetMessage?.text) {
          fastQuestion = `${defaultFastQuestion}\n\nMessage to act on:\n${targetMessage.text}`;
        }
      } catch (error) {
        apiLogger.warn(
          `[discord] Could not resolve emoji summon target ${reactionTarget.channelId}:${reactionTarget.messageId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await processDiscordFastAgentMessage({
      event,
      question: fastQuestion,
      ...fastAttachments,
      ...(agentContext ? { agentContext } : {}),
      sender,
      senderUserId,
      provider: resolved.provider,
      applicationId: resolved.applicationId,
      channel,
      metadata,
      // A reaction summon anchors its fast conversation (and any created
      // thread) on the reacted-on message, mirroring Slack threading under
      // the reacted-on message; the synthesized message id is not a real
      // Discord message.
      conversationId: getDiscordFastConversationId(
        channel,
        reactionTarget?.messageId ?? defaultFastMessage.id,
      ),
      ...(reactionTarget ? { anchorMessageId: reactionTarget.messageId } : {}),
      activeTasks: activeRun ? [{ taskId: activeRun.taskId }] : [],
      directedAtRoomote: true,
    });
    return { ok: true, fastAnswered: true, fastDefaulted: true };
  }

  // Every remaining entry shape already entered Fast above; a message with
  // nothing to say and nothing attached has no conversation to join.
  return { ok: true, ignored: 'no_fast_entry' };
}

export const discord = new Hono();

async function parseAuthorizedDiscordGatewayEvent(c: Context) {
  const authError = await verifyDiscordGatewaySecret(
    c.req.header(DISCORD_GATEWAY_SECRET_HEADER),
  );
  if (authError) {
    return {
      response: c.json({ ok: false, error: authError.error }, authError.status),
    };
  }
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return { response: c.json({ ok: false, error: 'invalid_json' }, 400) };
  }
  const parsed = parseDiscordGatewayEvent(rawBody);
  if (!parsed.success) {
    return {
      response: c.json({ ok: false, error: 'invalid_discord_event' }, 400),
    };
  }
  return { event: parsed.data };
}

discord.post('/events', async (c) => {
  const parsed = await parseAuthorizedDiscordGatewayEvent(c);
  if ('response' in parsed) return parsed.response;

  try {
    await enqueueDiscordGatewayEvent(parsed.event);
    return c.json({ ok: true, queued: true }, 202);
  } catch (error) {
    apiLogger.error(
      `[discord] Failed to enqueue event ${parsed.event.eventId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return c.json({ ok: false, error: 'discord_event_enqueue_failed' }, 503);
  }
});

discord.post('/events/process', async (c) => {
  const parsed = await parseAuthorizedDiscordGatewayEvent(c);
  if ('response' in parsed) return parsed.response;

  const eventRef = {
    eventType: parsed.event.eventType,
    eventId: parsed.event.eventId,
  };
  const claim = await claimDiscordApiEvent(eventRef);
  if (claim.status === 'completed') {
    return c.json({ ok: true, duplicate: true }, 409);
  }
  if (claim.status === 'processing') {
    return c.json({ ok: false, error: 'discord_event_in_progress' }, 425);
  }
  const eventLease = { ...eventRef, token: claim.token };
  const stopLeaseRenewal = renewDiscordApiEventLease(eventLease);
  const processing = processDiscordGatewayEvent(parsed.event);
  try {
    const result = await withDiscordGatewayEventProcessingTimeout(processing);
    stopLeaseRenewal();
    // The queue retries processing failures. If this bookkeeping write is
    // unavailable, the short lease expires and a later job attempt can claim it.
    await completeDiscordApiEvent({ ...eventRef, token: claim.token }).catch(
      (error) => {
        apiLogger.warn(
          `[discord] Failed to mark event ${eventRef.eventId} complete: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
    return c.json(result);
  } catch (error) {
    if (error instanceof DiscordGatewayEventProcessingTimeoutError) {
      // The timeout only ends this HTTP request. Keep the lease until the
      // original handler settles so a retry cannot start duplicate work.
      void processing
        .then(
          () =>
            completeDiscordApiEvent(eventLease).catch((completionError) => {
              apiLogger.warn(
                `[discord] Failed to mark timed-out event ${eventRef.eventId} complete: ${completionError instanceof Error ? completionError.message : String(completionError)}`,
              );
            }),
          (processingError: unknown) => {
            const finalize = isPermanentDiscordEventError(processingError)
              ? completeDiscordApiEvent(eventLease)
              : releaseDiscordApiEvent(eventLease);
            return finalize.catch(() => undefined);
          },
        )
        .finally(stopLeaseRenewal);
      apiLogger.warn(
        `[discord] Discord API unavailable while processing event ${eventRef.eventId}: ${error.message}`,
      );
      return c.json({ ok: false, error: 'discord_api_unavailable' }, 503);
    }

    stopLeaseRenewal();
    if (isPermanentDiscordEventError(error)) {
      await completeDiscordApiEvent({
        ...eventRef,
        token: claim.token,
      }).catch((completionError) => {
        apiLogger.warn(
          `[discord] Failed to mark ignored event ${eventRef.eventId} complete: ${completionError instanceof Error ? completionError.message : String(completionError)}`,
        );
      });
      apiLogger.warn(
        `[discord] Ignoring inaccessible event ${eventRef.eventId}: ${error.message}`,
      );
      return c.json({ ok: true, ignored: 'discord_resource_unavailable' });
    }

    await releaseDiscordApiEvent({ ...eventRef, token: claim.token }).catch(
      () => undefined,
    );
    if (error instanceof DiscordProviderNotConfiguredError) {
      return c.json(
        { ok: false, error: 'discord_provider_not_configured' },
        503,
      );
    }
    if (isRetryableDiscordProviderError(error)) {
      apiLogger.warn(
        `[discord] Discord API unavailable while processing event ${eventRef.eventId}: ${error.message}`,
      );
      return c.json({ ok: false, error: 'discord_api_unavailable' }, 503);
    }
    apiLogger.error(
      `[discord] Unhandled error while processing ${eventRef.eventType} event ${eventRef.eventId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
});
