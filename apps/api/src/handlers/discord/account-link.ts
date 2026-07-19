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
// "pending" is held while a claimant is still trying to deliver the DM.
// Only "sent" means a concurrent path may safely acknowledge delivery.
// A pending claim expires on its own short TTL: a claimant that crashes
// between claim and mark/release must not wedge the slot for the full
// dedupe window, or every later ping would wait out the in-flight window
// and bounce back to the Gateway for a day.
const ACCOUNT_LINK_DM_SLOT_PENDING = 'pending';
const ACCOUNT_LINK_DM_PENDING_TTL_SECONDS = 120;
const ACCOUNT_LINK_DM_SLOT_SENT = 'sent';
// Written by earlier builds of this PR before pending/sent were split. Treat
// as delivered so a rolling deploy does not re-DM or falsely take over.
const ACCOUNT_LINK_DM_SLOT_LEGACY = '1';

const ACCOUNT_LINK_DM_IN_FLIGHT_WAIT_MS = 2_500;
const ACCOUNT_LINK_DM_IN_FLIGHT_POLL_MS = 50;

/** Test-only knobs for the in-flight DM waiter. */
export const accountLinkDmInFlightWait = {
  timeoutMs: ACCOUNT_LINK_DM_IN_FLIGHT_WAIT_MS,
  intervalMs: ACCOUNT_LINK_DM_IN_FLIGHT_POLL_MS,
  sleep: (milliseconds: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
};

type AccountLinkDmSlotResult =
  | 'claimed'
  | 'sent_recently'
  | 'in_flight'
  | 'unavailable';

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

function accountLinkDmSlotKey(discordUserId: string): string {
  return `${ACCOUNT_LINK_DM_DEDUPE_PREFIX}${discordUserId}`;
}

function classifyAccountLinkDmSlotValue(
  value: string | null,
): Exclude<AccountLinkDmSlotResult, 'claimed' | 'unavailable'> | null {
  if (
    value === ACCOUNT_LINK_DM_SLOT_SENT ||
    value === ACCOUNT_LINK_DM_SLOT_LEGACY
  ) {
    return 'sent_recently';
  }
  if (value === ACCOUNT_LINK_DM_SLOT_PENDING) {
    return 'in_flight';
  }
  return null;
}

/**
 * NX-claim the per-user link-DM slot as `pending` until delivery finishes.
 * `sent_recently` means a link DM was confirmed delivered within the TTL.
 * `in_flight` means another path claimed the slot but has not marked delivery
 * yet — callers must not acknowledge "I sent you a DM" until that settles.
 * `unavailable` means Redis could not answer and the caller decides whether
 * to fail open or closed.
 */
export async function claimAccountLinkDmSlot(
  discordUserId: string,
): Promise<AccountLinkDmSlotResult> {
  const key = accountLinkDmSlotKey(discordUserId);
  try {
    const acquired = await getRedis().set(
      key,
      ACCOUNT_LINK_DM_SLOT_PENDING,
      'EX',
      ACCOUNT_LINK_DM_PENDING_TTL_SECONDS,
      'NX',
    );
    if (acquired === 'OK') {
      return 'claimed';
    }
    const value = await getRedis().get(key);
    return classifyAccountLinkDmSlotValue(value) ?? 'unavailable';
  } catch (error) {
    apiLogger.warn(
      `[discord] Account-link DM dedupe check failed for ${discordUserId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'unavailable';
  }
}

/** Promote a claimed pending slot to confirmed delivery for the TTL window. */
export async function markAccountLinkDmSent(
  discordUserId: string,
): Promise<void> {
  try {
    await getRedis().set(
      accountLinkDmSlotKey(discordUserId),
      ACCOUNT_LINK_DM_SLOT_SENT,
      'EX',
      ACCOUNT_LINK_DM_DEDUPE_TTL_SECONDS,
    );
  } catch (error) {
    apiLogger.warn(
      `[discord] Failed to mark account-link DM sent for ${discordUserId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Free the slot after a failed DM so the next attempt can retry. */
export async function releaseAccountLinkDmSlot(
  discordUserId: string,
): Promise<void> {
  await getRedis()
    .del(accountLinkDmSlotKey(discordUserId))
    .catch(() => undefined);
}

async function waitForAccountLinkDmSettlement(
  discordUserId: string,
): Promise<'sent' | 'released' | 'timeout'> {
  const timeoutMs = accountLinkDmInFlightWait.timeoutMs;
  const intervalMs = accountLinkDmInFlightWait.intervalMs;
  const sleep = accountLinkDmInFlightWait.sleep;
  const key = accountLinkDmSlotKey(discordUserId);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let value: string | null;
    try {
      value = await getRedis().get(key);
    } catch {
      return 'timeout';
    }
    if (value === null) {
      return 'released';
    }
    if (
      value === ACCOUNT_LINK_DM_SLOT_SENT ||
      value === ACCOUNT_LINK_DM_SLOT_LEGACY
    ) {
      return 'sent';
    }
    await sleep(intervalMs);
  }

  try {
    const finalValue = await getRedis().get(key);
    if (finalValue === null) {
      return 'released';
    }
    if (
      finalValue === ACCOUNT_LINK_DM_SLOT_SENT ||
      finalValue === ACCOUNT_LINK_DM_SLOT_LEGACY
    ) {
      return 'sent';
    }
  } catch {
    // fall through to timeout
  }
  return 'timeout';
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
  let slot = await claimAccountLinkDmSlot(input.discordUserId);

  if (slot === 'sent_recently') {
    dmPromptSent = true;
  } else if (slot === 'in_flight') {
    // Another path owns the pending claim. Wait for delivery confirmation or
    // release so we never say "I sent you a DM" about a DM that failed.
    const settlement = await waitForAccountLinkDmSettlement(
      input.discordUserId,
    );
    if (settlement === 'sent') {
      dmPromptSent = true;
    } else if (settlement === 'released') {
      slot = await claimAccountLinkDmSlot(input.discordUserId);
      if (slot === 'sent_recently') {
        dmPromptSent = true;
      } else if (slot === 'in_flight') {
        throw new DiscordApiError({
          method: 'POST',
          path: '/users/@me/channels',
          status: 503,
          message: 'Account-link DM delivery still in progress',
        });
      }
    } else {
      throw new DiscordApiError({
        method: 'POST',
        path: '/users/@me/channels',
        status: 503,
        message: 'Account-link DM delivery still in progress',
      });
    }
  }

  if (!dmPromptSent) {
    // On `unavailable` (Redis down) fail open: the user explicitly asked the
    // bot for something, so a possible duplicate DM beats silence.
    // On `claimed`, we own the pending slot until mark/release below.
    try {
      const dmChannel = await input.provider.createDirectMessage(
        input.discordUserId,
      );
      await input.provider.postMessage({
        channelId: dmChannel.id,
        text: DISCORD_LINK_REQUIRED_MESSAGE,
      });
      dmPromptSent = true;
      if (slot === 'claimed') {
        await markAccountLinkDmSent(input.discordUserId);
      }
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
