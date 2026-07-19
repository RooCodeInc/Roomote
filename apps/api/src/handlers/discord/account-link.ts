import { buildAccountLinkThreadReplyText } from '@roomote/communication/chat-messages';
import type { DiscordInteraction } from '@roomote/communication/discord-event';
import {
  DiscordApiError,
  type DiscordCommunicationProvider,
} from '@roomote/communication/discord-provider';
import { getRedis } from '@roomote/redis';

import { apiLogger } from '../../logging.js';
import { replyToDiscordEvent } from './replies.js';
import type { DiscordChannelContext } from './task-launch.js';

const DISCORD_ACCOUNT_LINK_FALLBACK_INSTRUCTION =
  'Generate a code under **Settings → Personal → Linked Accounts**, then DM me with `/link code:<code>`.';
const DISCORD_LINK_REQUIRED_MESSAGE = `Link your Discord account to Roomote before starting tasks. ${DISCORD_ACCOUNT_LINK_FALLBACK_INSTRUCTION}`;
const DISCORD_ACCOUNT_LABEL = 'Discord account';

// One link DM per user per day across every entry path (mentions, slash
// commands, channel auto-start): repeated pings acknowledge the existing DM
// instead of sending another one, and a Gateway retry after a partial
// failure cannot double-send the DM.
const ACCOUNT_LINK_DM_DEDUPE_PREFIX = 'discord:account-link-dm:';
const ACCOUNT_LINK_DM_DEDUPE_TTL_SECONDS = 24 * 60 * 60;

export function isDiscordDmBlockedError(error: unknown): boolean {
  // Discord API error 50007 is the only code that means "Cannot send messages
  // to this user" (recipient blocked DMs). A bare 403 also covers unrelated
  // auth failures such as Missing Access (50001), which must not trigger the
  // public account-link fallback.
  return (
    error instanceof DiscordApiError &&
    (error.code === 50007 || error.code === '50007')
  );
}

/**
 * NX-claim the per-user link-DM slot. `sent_recently` means a link DM already
 * went out within the TTL from any entry path; `unavailable` means Redis
 * could not answer and the caller decides whether to fail open or closed.
 */
export async function claimAccountLinkDmSlot(
  discordUserId: string,
): Promise<'claimed' | 'sent_recently' | 'unavailable'> {
  try {
    const acquired = await getRedis().set(
      `${ACCOUNT_LINK_DM_DEDUPE_PREFIX}${discordUserId}`,
      '1',
      'EX',
      ACCOUNT_LINK_DM_DEDUPE_TTL_SECONDS,
      'NX',
    );
    return acquired === 'OK' ? 'claimed' : 'sent_recently';
  } catch (error) {
    apiLogger.warn(
      `[discord] Account-link DM dedupe check failed for ${discordUserId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'unavailable';
  }
}

/** Free the slot after a failed DM so the next attempt can retry. */
export async function releaseAccountLinkDmSlot(
  discordUserId: string,
): Promise<void> {
  await getRedis()
    .del(`${ACCOUNT_LINK_DM_DEDUPE_PREFIX}${discordUserId}`)
    .catch(() => undefined);
}

/**
 * Prefer a DM for the full link prompt (same as channel auto-start and Slack/
 * Teams): public channels only get a short ack so we do not clutter them with
 * setup instructions. When DMs are blocked, the short public reply carries the
 * full instruction instead.
 */
export async function promptDiscordAccountLink(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  channel: DiscordChannelContext;
  discordUserId: string;
  interaction?: {
    interaction: DiscordInteraction;
    interactionDeferred: boolean;
  };
  replyToMessageId?: string;
}): Promise<void> {
  if (input.channel.isDirectMessage) {
    await replyToDiscordEvent({
      provider: input.provider,
      applicationId: input.applicationId,
      channel: input.channel,
      ...(input.interaction ? { interaction: input.interaction } : {}),
      text: DISCORD_LINK_REQUIRED_MESSAGE,
      ...(input.replyToMessageId
        ? { replyToMessageId: input.replyToMessageId }
        : {}),
    });
    return;
  }

  let dmPromptSent = false;
  const slot = await claimAccountLinkDmSlot(input.discordUserId);

  if (slot === 'sent_recently') {
    // A link DM already went out within the TTL; the ack below still points
    // the user at it without sending another copy.
    dmPromptSent = true;
  } else {
    // On `unavailable` (Redis down) fail open: the user explicitly asked the
    // bot for something, so a possible duplicate DM beats silence.
    try {
      const dmChannel = await input.provider.createDirectMessage(
        input.discordUserId,
      );
      await input.provider.postMessage({
        channelId: dmChannel.id,
        text: DISCORD_LINK_REQUIRED_MESSAGE,
      });
      dmPromptSent = true;
    } catch (error) {
      if (slot === 'claimed') {
        // Let the next attempt retry instead of burning the daily slot on a
        // failed delivery.
        await releaseAccountLinkDmSlot(input.discordUserId);
      }
      // Only treat confirmed recipient-side blocks as a soft failure that may
      // fall back publicly. Network/429/5xx DM failures are retryable and must
      // bubble so the Gateway retains the event instead of posting full setup
      // instructions in the channel on a transient outage. Permanent non-50007
      // failures (for example Missing Access) complete the event upstream with
      // no user-visible reply at all; that silence is intentional, because the
      // alternative is dumping setup copy into the channel on auth failures.
      if (!isDiscordDmBlockedError(error)) {
        throw error;
      }
      apiLogger.info(
        `[discord] Could not DM link prompt to ${input.discordUserId} (DMs blocked)`,
      );
    }
  }

  await replyToDiscordEvent({
    provider: input.provider,
    applicationId: input.applicationId,
    channel: input.channel,
    ...(input.interaction ? { interaction: input.interaction } : {}),
    text: buildAccountLinkThreadReplyText({
      dmPromptSent,
      accountLabel: DISCORD_ACCOUNT_LABEL,
      fallbackInstruction: DISCORD_ACCOUNT_LINK_FALLBACK_INSTRUCTION,
    }),
    ...(input.replyToMessageId
      ? { replyToMessageId: input.replyToMessageId }
      : {}),
  });
}
