import {
  getDiscordMessageContent,
  getDiscordMessageMentions,
  isDiscordBotMentioned,
  type DiscordMessage,
  type DiscordUser,
} from '@roomote/communication/discord-event';

import {
  compareBigIntMessageIds,
  evaluateUnmentionedThreadReplyRouting,
  type UnmentionedThreadHistoryMessage,
} from '../shared/unmentioned-thread-reply.js';
import type { DiscordThreadHistoryMessage } from './thread-context.js';

const DISCORD_USER_MENTION_PATTERN = /<@!?(\d+)>/gu;

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
  mentions: DiscordUser[],
  botUserId: string | undefined,
): boolean {
  const mentionedUserIds = new Set([
    ...getMentionedDiscordUserIds(text),
    ...mentions.map((mention) => mention.id),
  ]);
  return mentionedUserIds.size > 0 && !mentionedUserIds.has(botUserId ?? '');
}

function mentionsDiscordUserOtherThanBot(
  text: string,
  botUserId: string | undefined,
): boolean {
  return getMentionedDiscordUserIds(text).some(
    (userId) => userId !== botUserId,
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

function toSharedHistoryMessages(
  threadMessages: DiscordThreadHistoryMessage[],
  botUserId: string,
): UnmentionedThreadHistoryMessage[] {
  return threadMessages.map((message) => {
    const isBot = message.botId === botUserId;
    const isHuman = isHumanAuthoredHistoryMessage(message, botUserId);
    return {
      id: message.id,
      authorUserId: isHuman ? message.user : isBot ? botUserId : null,
      isBot,
      mentionsBot: mentionsDiscordBotInText(message.text, botUserId),
      mentionsSomebodyElse: mentionsDiscordUserOtherThanBot(
        message.text,
        botUserId,
      ),
    };
  });
}

/**
 * Decides whether a Discord guild-thread reply that does not mention the bot
 * should still route to the agent. Provider filters stay Discord-specific;
 * eligibility and interjection window rules come from the shared Slack/Teams
 * core in `handlers/shared/unmentioned-thread-reply`.
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
  /** True when the reply targets an automation report root. */
  isAutomationReportThread?: boolean;
  /** True when the thread is an open Fast conversation. */
  isOpenConversationThread?: boolean;
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
      getDiscordMessageContent(message),
      getDiscordMessageMentions(message),
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

  // Discord threads created from a message share that message's id as the
  // thread channel id. Only trust root-author eligibility when that exact
  // starter message is present in history so a truncated 500-message window
  // cannot promote some later author to "thread starter".
  const rootMessage = threadMessages.find(
    (historyMessage) => historyMessage.id === message.channel_id,
  );
  const isThreadRootAuthor =
    Boolean(rootMessage) &&
    isHumanAuthoredHistoryMessage(rootMessage!, botUserId) &&
    rootMessage!.user === senderDiscordUserId;

  const decision = evaluateUnmentionedThreadReplyRouting({
    eventMessageId: message.id,
    senderUserId: senderDiscordUserId,
    isThreadTaskOwner:
      Boolean(params.ownedThreadUserId) &&
      params.ownedThreadUserId === params.mappedUserId,
    isThreadRootAuthor,
    isAutomationReportThread: params.isAutomationReportThread,
    isOpenConversationThread: params.isOpenConversationThread,
    threadMessages: toSharedHistoryMessages(threadMessages, botUserId),
    compareMessageIds: compareBigIntMessageIds,
  });

  return decision.shouldRoute;
}
