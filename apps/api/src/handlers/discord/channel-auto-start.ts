import {
  discordEventToQueuedCommunicationMessage,
  type DiscordGatewayEvent,
  type DiscordMessage,
} from '@roomote/communication/discord-event';
import { type DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import { getBackgroundAgentSettingsForDeployment } from '@roomote/db/server';
import {
  AUTO_START_CHANNEL_CACHE_TTL_SECONDS,
  getRedis,
  REDIS_KEYS,
  syncAutoStartChannelCacheBestEffort,
} from '@roomote/redis';
import { findDiscordMappedUserId } from '@roomote/sdk/server';
import type { TaskInitiator } from '@roomote/types';

import { apiLogger } from '../../logging.js';
import { checkAutoStartChannelCache } from '../shared/auto-start-cache.js';
import { evaluateChannelLaunchGate } from '../shared/channel-launch-gate.js';
import {
  claimAccountLinkDmSlot,
  isDiscordDmBlockedError,
  releaseAccountLinkDmSlot,
} from './account-link.js';
import { processDiscordAttachments } from './attachments.js';
import { startNewDiscordTask } from './task-orchestration.js';
import {
  discordMetadataForChannel,
  type DiscordChannelContext,
} from './task-launch.js';

// Text (0) and announcement (5) channels only: their top-level messages can
// anchor a task thread. Forum posts are threads by construction, and other
// channel kinds would persist thread-less conversation keys that swallow every
// later channel message as a follow-up.
const CHANNEL_AUTO_START_CHANNEL_TYPES = new Set([0, 5]);
// DEFAULT (0) and REPLY (19); everything else is a system message (pins,
// joins, boosts, thread-created, ...) that must not launch tasks.
const CHANNEL_AUTO_START_MESSAGE_TYPES = new Set([0, 19]);

const DISCORD_ROUTING_LOCK_PREFIX = 'discord:routing-lock:';
const ROUTING_LOCK_TTL_SECONDS = 60;

function isBotMentioned(message: DiscordMessage, botUserId: string): boolean {
  return (
    message.mentions.some((mention) => mention.id === botUserId) ||
    message.content.includes(`<@${botUserId}>`) ||
    message.content.includes(`<@!${botUserId}>`)
  );
}

/**
 * Discord has no ephemeral channel messages, so the "connect your account"
 * nudge Slack shows inline arrives as a DM instead — at most once per user
 * per day (shared with the mention-flow link prompt), and never blocking:
 * users who disallow DMs from server members simply miss the nudge.
 */
async function sendLinkNudgeBestEffort(input: {
  provider: DiscordCommunicationProvider;
  discordUserId: string;
  channelName: string;
}): Promise<void> {
  const slot = await claimAccountLinkDmSlot(input.discordUserId);
  if (slot !== 'claimed') {
    // `sent_recently`: the user already has a fresh link DM from any entry
    // path. `unavailable`: this nudge is best-effort, so skip rather than
    // risk DM spam while Redis cannot answer.
    return;
  }

  try {
    const dmChannel = await input.provider.createDirectMessage(
      input.discordUserId,
    );
    await input.provider.postMessage({
      channelId: dmChannel.id,
      text: [
        `Roomote watches **#${input.channelName}** and starts a task for each new message, but your Discord account is not linked to a Roomote account yet, so your message did not start one.`,
        'Generate a code under **Settings → Personal → Linked Accounts** in Roomote, then reply here with `/link code:<code>`.',
      ].join('\n\n'),
    });
  } catch (error) {
    // Let the next qualifying message retry instead of burning the daily slot
    // on a failed delivery.
    await releaseAccountLinkDmSlot(input.discordUserId);
    if (isDiscordDmBlockedError(error)) {
      apiLogger.info(
        `[DiscordChannelAutoStart] Could not DM link nudge to ${input.discordUserId} (DMs blocked)`,
      );
      return;
    }
    apiLogger.warn(
      `[DiscordChannelAutoStart] Failed to DM link nudge to ${input.discordUserId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Channel auto-start for Discord: every qualifying top-level message in a
 * configured auto-respond channel launches a task with the channel's
 * instructions, optionally gated by its launch criteria — the Discord
 * counterpart of the Slack path in slack/events/message-entry.ts.
 *
 * Returns true when the event belongs to a configured auto-respond channel
 * and was consumed here (launched, gated, nudged, or deduped); the caller
 * then skips its mention/task-entry handling entirely.
 */
export async function maybeHandleDiscordChannelAutoStart(input: {
  event: DiscordGatewayEvent;
  message: DiscordMessage;
  channel: DiscordChannelContext;
  provider: DiscordCommunicationProvider;
  applicationId: string;
  botUserId: string;
}): Promise<boolean> {
  const { event, message, channel, provider, botUserId } = input;

  if (
    channel.isDirectMessage ||
    channel.isThread ||
    !channel.guildId ||
    !CHANNEL_AUTO_START_CHANNEL_TYPES.has(channel.channelType)
  ) {
    return false;
  }

  if (
    typeof message.type === 'number' &&
    !CHANNEL_AUTO_START_MESSAGE_TYPES.has(message.type)
  ) {
    return false;
  }

  // Roomote's own posts (acknowledgements, answers) never re-trigger.
  if (message.author.id === botUserId) {
    return false;
  }

  if (!message.content.trim() && message.attachments.length === 0) {
    return false;
  }

  const redis = getRedis();
  const cacheKey = REDIS_KEYS.DISCORD_AUTO_START_CHANNEL;
  const cacheResult = await checkAutoStartChannelCache({
    redis,
    cacheKey,
    channelId: channel.channelId,
    logContext: 'DiscordChannelAutoStart',
  });

  if (cacheResult.status === 'empty') {
    return false;
  }

  const settings = await getBackgroundAgentSettingsForDeployment();
  const configuredTargets = settings.channelAutoStartEnabled
    ? settings.channelAutoStartDiscordChannels
    : [];
  const configuredChannelIds = configuredTargets.map(
    ({ channelId }) => channelId,
  );
  const shouldRefreshCache =
    cacheResult.status === 'legacy' ||
    cacheResult.status === 'mismatch' ||
    cacheResult.status === 'miss' ||
    (cacheResult.status === 'hit' &&
      !configuredChannelIds.includes(channel.channelId));

  if (shouldRefreshCache) {
    void syncAutoStartChannelCacheBestEffort({
      redis,
      key: cacheKey,
      channelIds: configuredChannelIds,
      onError: (error) => {
        apiLogger.warn(
          `[DiscordChannelAutoStart] Failed to sync auto-start channel cache (ttl ${AUTO_START_CHANNEL_CACHE_TTL_SECONDS}s): ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });
  }

  const matchedTarget = configuredTargets.find(
    (target) => target.channelId === channel.channelId,
  );
  if (!matchedTarget) {
    return false;
  }

  const logContext = `configured channel auto-start ${channel.channelId}:${message.id}`;
  const isBotAuthored =
    message.author.bot === true || typeof message.webhook_id === 'string';
  const authorDisplayName =
    message.author.global_name?.trim() || message.author.username;

  let initiator: TaskInitiator;
  let launchOwnerUserId: string | undefined;
  let queuedMessageUserId: string | undefined;

  if (isBotAuthored) {
    initiator = {
      kind: 'automation',
      key: 'slack_channel_auto_start',
      actor: {
        externalId: message.author.id,
        ...(authorDisplayName ? { displayName: authorDisplayName } : {}),
      },
    };
  } else {
    const mappedUserId = await findDiscordMappedUserId(message.author.id);

    if (!mappedUserId) {
      await sendLinkNudgeBestEffort({
        provider,
        discordUserId: message.author.id,
        channelName: channel.channelName,
      });
      return true;
    }

    initiator = {
      kind: 'user',
      externalId: message.author.id,
      ...(authorDisplayName ? { displayName: authorDisplayName } : {}),
      matchedUserId: mappedUserId,
    };
    launchOwnerUserId = mappedUserId;
    queuedMessageUserId = mappedUserId;
  }

  const processedAttachments = message.attachments.length
    ? await processDiscordAttachments(message.attachments)
    : { images: [], attachmentTexts: [], warnings: [] };
  for (const warning of processedAttachments.warnings) {
    apiLogger.warn(`[DiscordChannelAutoStart] Attachment warning: ${warning}`);
  }

  const queuedMessage = discordEventToQueuedCommunicationMessage(event, {
    botUserId,
    ...(queuedMessageUserId ? { userId: queuedMessageUserId } : {}),
    channelAutoStart: true,
    ...(channel.parentChannelId
      ? { parentChannelId: channel.parentChannelId }
      : {}),
    attachmentImages: processedAttachments.images,
    attachmentText: processedAttachments.attachmentTexts,
  });
  if (!queuedMessage) {
    apiLogger.info(
      `[DiscordChannelAutoStart] Skipping ${logContext}: no usable message content`,
    );
    return true;
  }

  const routingLockKey = `${DISCORD_ROUTING_LOCK_PREFIX}${message.id}`;
  const lockAcquired = await redis.set(
    routingLockKey,
    '1',
    'EX',
    ROUTING_LOCK_TTL_SECONDS,
    'NX',
  );
  if (lockAcquired !== 'OK') {
    apiLogger.info(
      `[DiscordChannelAutoStart] Skipping ${logContext}: routing lock already held`,
    );
    return true;
  }
  const releaseRoutingLock = async () => {
    await redis.del(routingLockKey).catch(() => undefined);
  };

  const metadata = discordMetadataForChannel({
    channel,
    messageId: message.id,
    anchorMessageId: message.id,
  });

  // The Gateway delivery loop expects a fast 2xx; the launch-criteria LLM,
  // routing, and thread creation continue in the background, exactly like the
  // Slack webhook path.
  void (async () => {
    try {
      const launchCriteria = matchedTarget.launchCriteria?.trim();

      if (launchCriteria) {
        const gateResult = await evaluateChannelLaunchGate({
          redis,
          provider: 'discord',
          channelId: channel.channelId,
          channelName: channel.channelName,
          messageText: queuedMessage.text,
          botMentioned: isBotMentioned(message, botUserId),
          launchCriteria,
          isBotAuthored,
          logContext,
        });

        if (!gateResult.shouldLaunch) {
          // Silent to the channel by design; the gate logged its reason.
          await releaseRoutingLock();
          return;
        }
      }

      try {
        await provider.addReaction({
          channelId: channel.channelId,
          messageId: message.id,
          name: '👀',
        });
      } catch {
        // The launch matters more than the acknowledgement.
      }

      const started = await startNewDiscordTask({
        provider,
        applicationId: input.applicationId,
        requesterDiscordUserId: message.author.id,
        ...(launchOwnerUserId ? { launchOwnerUserId } : {}),
        queuedMessage,
        metadata,
        channel,
        skipRoutingConfirmation: true,
        channelAutoStart: {
          ...(matchedTarget.instructions
            ? { agentPromptPrefix: matchedTarget.instructions }
            : {}),
          initiator,
        },
      });

      if (started.status !== 'started') {
        apiLogger.info(
          `[DiscordChannelAutoStart] No task launched for ${logContext}: ${started.status}`,
        );
        await releaseRoutingLock();
      }
    } catch (error) {
      apiLogger.error(
        `[DiscordChannelAutoStart] Failed to launch for ${logContext}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await releaseRoutingLock();
    }
  })();

  return true;
}
