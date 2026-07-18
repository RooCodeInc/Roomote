import { Hono } from 'hono';

import {
  discordEventToQueuedCommunicationMessage,
  getDiscordInteractionCommand,
  getDiscordInteractionCreate,
  getDiscordInteractionUser,
  getDiscordMessageCreate,
  isDiscordBotMentioned,
  isDiscordTaskEntryEvent,
  parseDiscordGatewayEvent,
  type DiscordGatewayEvent,
} from '@roomote/communication/discord-event';
import {
  DiscordApiError,
  DiscordApiTransportError,
} from '@roomote/communication/discord-provider';
import {
  queueCommunicationMessageOnce,
  setLatestInboundMessageId,
} from '@roomote/communication/messages';
import { getTaskUrl } from '@roomote/cloud-agents/server';
import {
  consumeDiscordLinkCode,
  findDiscordInstallationByGuildId,
  findDiscordMappedUserId,
  restoreDiscordLinkCode,
  upsertDiscordInstallation,
  upsertDiscordUserMapping,
} from '@roomote/sdk/server';

import { apiLogger } from '../../logging.js';
import { syncActingUserForInboundMessage } from '../tasks/acting-user-sync.js';
import {
  findActiveCommunicationTaskRun,
  findCompletedCommunicationTaskRunWithSnapshot,
  findCommunicationTaskRunBySourceEvent,
} from '../tasks/communication-task-run-lookup.js';
import { resumeCommunicationTaskFromSnapshot } from '../tasks/communication-snapshot-resume.js';
import {
  attachOutOfBandContextToCommunicationMessage,
  releaseCommunicationOutOfBandClaim,
} from '../tasks/communication-out-of-band-context.js';
import { processDiscordAttachments } from './attachments.js';
import {
  DISCORD_GATEWAY_SECRET_HEADER,
  verifyDiscordGatewaySecret,
} from './auth.js';
import { handleDiscordComponentInteraction } from './callback-actions.js';
import { maybeHandleDiscordChannelAutoStart } from './channel-auto-start.js';
import {
  claimDiscordApiEvent,
  completeDiscordApiEvent,
  releaseDiscordApiEvent,
} from './event-gate.js';
import {
  DiscordProviderNotConfiguredError,
  resolveDiscordProvider,
} from './provider.js';
import { replyToDiscordEvent } from './replies.js';
import {
  findDiscordPendingRoutingReply,
  handleDiscordRoutingReply,
} from './routing-confirmation.js';
import {
  discordMetadataForChannel,
  resolveDiscordChannelContext,
} from './task-launch.js';
import { startNewDiscordTask } from './task-orchestration.js';

const DISCORD_HELP_MESSAGE = [
  "👋 I'm Roomote. Mention me in a server channel or message me directly to start a task.",
  '',
  '**Available commands**',
  '`/new request:<request>` — start a fresh task.',
  '`/link code:<code>` — link this Discord account in a DM with me.',
  '`/help` — show this message.',
  '',
  'Follow up by sending another message in the task thread.',
].join('\n');

const DISCORD_LINK_REQUIRED_MESSAGE =
  'Link your Discord account to Roomote before starting tasks. Generate a code under **Settings → Personal → Linked Accounts**, then DM me with `/link code:<code>`.';

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

async function processDiscordGatewayEvent(event: DiscordGatewayEvent) {
  const resolved = await resolveDiscordProvider();
  const interaction = getDiscordInteractionCreate(event);
  const message = getDiscordMessageCreate(event);
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
    messageId: event.payload.id,
    // Only a real channel message provides an anchor for the task thread;
    // interactions (slash commands, buttons) do not.
    ...(message?.id ? { anchorMessageId: message.id } : {}),
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
  if (message && !interaction) {
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
    await replyToDiscordEvent({
      provider: resolved.provider,
      applicationId: resolved.applicationId,
      channel,
      interaction: interactionReplyContext(event),
      text: [
        '✅ Linked! This Discord account is now connected to your Roomote account. Tasks you start here are attributed to you.',
        DISCORD_HELP_MESSAGE,
      ].join('\n\n'),
      ephemeral: true,
    });
    return { ok: true, linked: true };
  }

  if (command && command.name !== 'new') {
    return { ok: true, ignored: 'unsupported_command' };
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
  let activeRun = forceNewTask
    ? undefined
    : await findActiveCommunicationTaskRun(conversation);
  const completedRun =
    forceNewTask || activeRun
      ? null
      : await findCompletedCommunicationTaskRunWithSnapshot(conversation);
  const pendingRoutingReply =
    message && senderUserId && !forceNewTask
      ? await findDiscordPendingRoutingReply({
          channel,
          replyToMessageId: message.message_reference?.message_id,
          requesterDiscordUserId: sender.id,
          launchOwnerUserId: senderUserId,
        })
      : null;
  const isTaskEntry = isDiscordTaskEntryEvent(event, {
    botUserId: resolved.botUserId,
    isTaskThread: Boolean(activeRun || completedRun || pendingRoutingReply),
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

    await replyToDiscordEvent({
      provider: resolved.provider,
      applicationId: resolved.applicationId,
      channel,
      ...(interaction ? { interaction: interactionReplyContext(event) } : {}),
      text: DISCORD_LINK_REQUIRED_MESSAGE,
    });
    return {
      ok: true,
      queued: false,
      reason: 'discord_sender_not_linked',
    };
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

  const processedAttachments = message?.attachments.length
    ? await processDiscordAttachments(message.attachments)
    : { images: [], attachmentTexts: [], warnings: [] };
  for (const warning of processedAttachments.warnings) {
    apiLogger.warn(`[discord] Attachment warning: ${warning}`);
  }
  const queuedMessage = discordEventToQueuedCommunicationMessage(event, {
    botUserId: resolved.botUserId,
    userId: senderUserId,
    isTaskThread: Boolean(activeRun || completedRun || pendingRoutingReply),
    parentChannelId: channel.parentChannelId,
    attachmentImages: processedAttachments.images,
    attachmentText: processedAttachments.attachmentTexts,
  });
  if (!queuedMessage) {
    return { ok: true, ignored: 'empty_task_entry' };
  }

  if (pendingRoutingReply) {
    try {
      await resolved.provider.addReaction({
        channelId: channel.channelId,
        messageId: queuedMessage.ts,
        name: '👀',
      });
    } catch {
      // Routing ownership is already durable; the reaction is only an ack.
    }

    const handled = await handleDiscordRoutingReply({
      provider: resolved.provider,
      applicationId: resolved.applicationId,
      pendingRouteId: pendingRoutingReply.pendingRouteId,
      requesterDiscordUserId: sender.id,
      launchOwnerUserId: senderUserId,
      queuedMessage,
      channel,
    });
    if (handled) {
      return { ok: true, routingReplyHandled: true };
    }

    // The auto-confirm timer may have claimed the card between lookup and
    // classification. If it launched, this message is now a normal task
    // follow-up and should enter that run instead of becoming a new task.
    activeRun = await findActiveCommunicationTaskRun(conversation);
    if (!activeRun) {
      return { ok: true, ignored: 'routing_reply_expired' };
    }
  }

  // Check the upstream event before conversation routing. In a DM, a retry
  // after task creation would otherwise discover that new run as "active"
  // and enqueue the original launch request as a second user turn.
  const existingSourceRun = await findCommunicationTaskRunBySourceEvent({
    provider: 'discord',
    sourceEventId: queuedMessage.ts,
  });
  if (existingSourceRun) {
    const taskUrl = getTaskUrl({
      taskId: existingSourceRun.taskId,
      utm: { source: 'discord', campaign: 'discord.event_retry' },
    });
    await replyToDiscordEvent({
      provider: resolved.provider,
      applicationId: resolved.applicationId,
      channel,
      ...(interaction ? { interaction: interactionReplyContext(event) } : {}),
      text: taskUrl
        ? `This request already started a task: ${taskUrl}`
        : 'This request already started a task.',
    }).catch(() => undefined);
    return {
      ok: true,
      duplicate: true,
      runId: existingSourceRun.id,
    };
  }

  if (activeRun) {
    await syncActingUserForInboundMessage({
      logContext: 'discord.activeRunMessage',
      runId: activeRun.id,
      senderUserId,
    });
    // Mirror Slack: out-of-band PR review/status notifications are posted
    // outside the harness session and must be re-surfaced on the next user
    // turn so the agent knows what the user is replying to.
    const { message: messageWithOutOfBand, claim: outOfBandClaim } =
      await attachOutOfBandContextToCommunicationMessage({
        taskId: activeRun.taskId,
        provider: 'discord',
        message: queuedMessage,
      });
    try {
      const queued = await queueCommunicationMessageOnce(
        'discord',
        activeRun.id,
        messageWithOutOfBand,
      );
      // Dedupe hit: nothing new will be delivered, so put claimed OOB
      // messages back for a later real follow-up.
      if (!queued) {
        await releaseCommunicationOutOfBandClaim(outOfBandClaim);
      }
    } catch (error) {
      await releaseCommunicationOutOfBandClaim(outOfBandClaim);
      throw error;
    }
    await setLatestInboundMessageId('discord', activeRun.id, queuedMessage.ts);
    // Match Slack: eyes is an intake-only platform ack. Active follow-ups are
    // already durable once queued; agents may still react when turn policy allows.
    return { ok: true, queued: true, runId: activeRun.id };
  }

  if (completedRun) {
    const resumed = await resumeCommunicationTaskFromSnapshot({
      provider: 'discord',
      completedRun,
      queuedMessage,
      channelId: metadata.communicationChannelId,
      threadId: metadata.communicationThreadId,
      messageId: metadata.communicationMessageId,
      guildId: metadata.communicationGuildId,
      preservePayloadFlags: ['discordTaskThread'],
    });
    return { ok: true, resumed: true, runId: resumed.id };
  }

  // Match Slack intake: ack the origin message with 👀 before launch work.
  // Only real MESSAGE_CREATE messages can receive Discord reactions; slash-
  // command interaction ids are not message targets and would 404.
  if (message?.id) {
    try {
      await resolved.provider.addReaction({
        channelId: channel.channelId,
        messageId: message.id,
        name: '👀',
      });
    } catch {
      // Soft ack only.
    }
  }

  const started = await startNewDiscordTask({
    provider: resolved.provider,
    applicationId: resolved.applicationId,
    requesterDiscordUserId: sender.id,
    launchOwnerUserId: senderUserId,
    queuedMessage,
    metadata,
    channel,
    ...(interaction ? { interaction: interactionReplyContext(event) } : {}),
    // A mention inside an unrelated server thread cannot own that shared
    // conversation. Create a sibling task thread/forum post just as `/new`
    // does, while known task threads were handled by the active/resume paths.
    forceNewThread: forceNewTask || channel.isThread,
  });
  return { ok: true, ...started };
}

export const discord = new Hono();

discord.post('/events', async (c) => {
  const authError = await verifyDiscordGatewaySecret(
    c.req.header(DISCORD_GATEWAY_SECRET_HEADER),
  );
  if (authError) {
    return c.json({ ok: false, error: authError.error }, authError.status);
  }
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400);
  }
  const parsed = parseDiscordGatewayEvent(rawBody);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'invalid_discord_event' }, 400);
  }
  const eventRef = {
    eventType: parsed.data.eventType,
    eventId: parsed.data.eventId,
  };
  const claim = await claimDiscordApiEvent(eventRef);
  if (claim.status === 'completed') {
    return c.json({ ok: true, duplicate: true }, 409);
  }
  if (claim.status === 'processing') {
    return c.json({ ok: false, error: 'discord_event_in_progress' }, 425);
  }
  try {
    const result = await processDiscordGatewayEvent(parsed.data);
    // The 2xx response is sufficient for the durable Gateway to acknowledge
    // this entry. If Redis is unavailable for this final bookkeeping write,
    // the short processing lease expires instead of failing completed work.
    await completeDiscordApiEvent({ ...eventRef, token: claim.token }).catch(
      (error) => {
        apiLogger.warn(
          `[discord] Failed to mark event ${eventRef.eventId} complete: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
    return c.json(result);
  } catch (error) {
    if (isPermanentDiscordEventError(error)) {
      // The channel/message no longer exists or the bot cannot access it.
      // Retrying this specific event cannot make progress, so complete it
      // instead of eventually poisoning the Gateway's durable delivery queue.
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
      // The Gateway treats 503 as delivery infrastructure and retains the
      // stream entry without applying its poison-event attempt cap.
      return c.json({ ok: false, error: 'discord_api_unavailable' }, 503);
    }
    throw error;
  }
});
