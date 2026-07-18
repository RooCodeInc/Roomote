import type { DiscordMessage } from '@roomote/communication/discord-event';
import { isDiscordBotMentioned } from '@roomote/communication/discord-event';

import type { DiscordThreadHistoryMessage } from './thread-context.js';

const DISCORD_USER_MENTION_PATTERN = /<@!?(\d+)>/gu;

function compareDiscordSnowflakes(left: string, right: string): number {
  try {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    if (leftId === rightId) return 0;
    return leftId < rightId ? -1 : 1;
  } catch {
    return left.localeCompare(right);
  }
}

function getMentionedDiscordUserIds(text: string): string[] {
  return Array.from(text.matchAll(DISCORD_USER_MENTION_PATTERN))
    .map((match) => match[1])
    .filter((userId): userId is string => Boolean(userId));
}

function mentionsDiscordBotInText(
  text: string,
  botUserId: string | undefined,
): boolean {
  if (!botUserId) return false;
  return getMentionedDiscordUserIds(text).includes(botUserId);
}

function mentionsDiscordUserOtherThanBotWithoutMentioningBot(
  text: string,
  botUserId: string | undefined,
): boolean {
  const mentionedUserIds = getMentionedDiscordUserIds(text);
  return (
    mentionedUserIds.length > 0 &&
    !mentionedUserIds.some((userId) => userId === botUserId)
  );
}

function mentionsDiscordUserOtherThanBotOrUser(
  text: string,
  botUserId: string | undefined,
  discordUserId: string,
): boolean {
  return getMentionedDiscordUserIds(text).some(
    (userId) => userId !== botUserId && userId !== discordUserId,
  );
}

function isHumanAuthoredHistoryMessage(
  message: DiscordThreadHistoryMessage,
  botUserId: string | undefined,
): boolean {
  return (
    !message.botId &&
    Boolean(message.user) &&
    message.user !== botUserId &&
    message.user !== 'unknown'
  );
}

function isTargetDiscordBotHistoryMessage(
  message: DiscordThreadHistoryMessage,
  botUserId: string | undefined,
): boolean {
  return Boolean(botUserId) && message.botId === botUserId;
}

/**
 * Decides whether a Discord guild-thread reply that does not mention the bot
 * should still route to the agent, mirroring Slack
 * `shouldRouteUnmentionedSlackThreadReplyToAgent` and Teams
 * `shouldRouteUnmentionedTeamsThreadReplyToAgent`.
 *
 * Replying to the bot needs no @-mention unless somebody else sent a message
 * or was mentioned since the bot's last message in the thread. The no-mention
 * flow is limited to senders already in conversation with the bot: the
 * thread's task owner, the thread starter, or someone who mentioned the bot
 * earlier in the thread.
 */
export async function shouldRouteUnmentionedDiscordThreadReplyToAgent(params: {
  message: DiscordMessage;
  botUserId: string | undefined;
  mappedUserId: string | null;
  /**
   * True when this Discord channel/thread is already a Roomote task
   * conversation (active run, resumable completed run, or pending routing).
   */
  isRoomoteThread: boolean;
  /** Roomote user id of the thread task owner when known. */
  ownedThreadUserId: string | null | undefined;
  fetchThreadMessages: () => Promise<DiscordThreadHistoryMessage[] | null>;
}): Promise<boolean> {
  const { message, botUserId } = params;
  const senderDiscordUserId = message.author?.id;

  if (!senderDiscordUserId || message.author?.bot) {
    return false;
  }

  // DMs and explicit bot mentions are handled by the normal task-entry path.
  if (!message.guild_id || isDiscordBotMentioned(message, botUserId)) {
    return false;
  }

  // Unmentioned routing needs a linked sender so drive-by chats never trigger
  // work or account-linking spam for spectators.
  if (!params.mappedUserId || !botUserId) {
    return false;
  }

  // Replies that mention somebody else without addressing the bot are directed
  // at that person, not Roomote.
  if (
    mentionsDiscordUserOtherThanBotWithoutMentioningBot(
      message.content,
      botUserId,
    )
  ) {
    return false;
  }

  // A Roomote-owned task conversation is required (active run, resumable
  // completed run, or pending routing for this thread).
  if (!params.isRoomoteThread) {
    return false;
  }

  const threadMessages = await params.fetchThreadMessages();

  // A real thread always contains at least one message, so a missing or empty
  // history means it is unreliable. Require an explicit mention instead of
  // routing blind.
  if (!threadMessages || threadMessages.length === 0) {
    return false;
  }

  const eventMessageId = message.id;

  // The no-mention flow is limited to senders who are already in conversation
  // with the bot in this thread: the thread's task owner, the thread starter,
  // or someone who @-mentioned the bot earlier in the thread.
  //
  // Discord threads created from a message share that message's id as the
  // thread channel id. Only trust root-author eligibility when that exact
  // starter message is present in history so a truncated 500-message window
  // cannot promote some later author to "thread starter".
  const isThreadTaskOwner =
    Boolean(params.ownedThreadUserId) &&
    params.ownedThreadUserId === params.mappedUserId;
  const rootMessage = threadMessages.find(
    (historyMessage) => historyMessage.id === message.channel_id,
  );
  const isThreadRootAuthor =
    Boolean(rootMessage) &&
    isHumanAuthoredHistoryMessage(rootMessage!, botUserId) &&
    rootMessage!.user === senderDiscordUserId &&
    compareDiscordSnowflakes(rootMessage!.id, eventMessageId) < 0;
  const hasMentionedBotEarlierInThread = threadMessages.some(
    (historyMessage) => {
      return (
        compareDiscordSnowflakes(historyMessage.id, eventMessageId) < 0 &&
        isHumanAuthoredHistoryMessage(historyMessage, botUserId) &&
        historyMessage.user === senderDiscordUserId &&
        mentionsDiscordBotInText(historyMessage.text, botUserId)
      );
    },
  );

  if (
    !isThreadTaskOwner &&
    !isThreadRootAuthor &&
    !hasMentionedBotEarlierInThread
  ) {
    return false;
  }

  // Replying to the bot needs no @-mention unless somebody else sent a
  // message or was mentioned since the bot's last message in the thread.
  // Each new bot reply reopens the no-mention window.
  let latestBotMessageId: string | null = null;
  for (const historyMessage of threadMessages) {
    if (!isTargetDiscordBotHistoryMessage(historyMessage, botUserId)) {
      continue;
    }
    if (compareDiscordSnowflakes(historyMessage.id, eventMessageId) >= 0) {
      continue;
    }
    if (
      latestBotMessageId === null ||
      compareDiscordSnowflakes(historyMessage.id, latestBotMessageId) > 0
    ) {
      latestBotMessageId = historyMessage.id;
    }
  }

  for (const historyMessage of threadMessages) {
    // When no bot message is identifiable in the fetched history, the whole
    // thread is treated as the window on purpose (conservative: an
    // interjection anywhere in the thread requires an explicit mention).
    if (compareDiscordSnowflakes(historyMessage.id, eventMessageId) >= 0) {
      continue;
    }
    if (
      latestBotMessageId !== null &&
      compareDiscordSnowflakes(historyMessage.id, latestBotMessageId) <= 0
    ) {
      continue;
    }

    if (!isHumanAuthoredHistoryMessage(historyMessage, botUserId)) {
      continue;
    }

    const isMessageFromSomebodyElse =
      historyMessage.user !== senderDiscordUserId;
    const mentionsSomebodyElse = mentionsDiscordUserOtherThanBotOrUser(
      historyMessage.text,
      botUserId,
      senderDiscordUserId,
    );

    if (isMessageFromSomebodyElse || mentionsSomebodyElse) {
      return false;
    }
  }

  return true;
}
