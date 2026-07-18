/**
 * Shared unmentioned thread-reply routing for Slack, Discord, and Teams.
 *
 * Once provider-specific filters decide a reply is an unmentioned follow-up in
 * a Roomote-owned conversation, the eligibility and "somebody else spoke /
 * was mentioned since the bot last replied" rules are identical.
 */

export type UnmentionedThreadHistoryMessage = {
  /** Provider message id (Slack ts, Discord snowflake, Teams activity id). */
  id: string;
  /** Human author provider user id when human-authored. */
  authorUserId: string | null | undefined;
  isBot: boolean;
  /** True when this history message @-mentions the Roomote bot. */
  mentionsBot: boolean;
  /**
   * True when this history message mentions a principal other than the bot
   * and other than the current sender (another human or another app).
   */
  mentionsSomebodyElse: boolean;
};

type UnmentionedThreadReplyEvaluation = {
  shouldRoute: boolean;
  /**
   * True when routing failed because somebody else posted or was mentioned
   * since the bot's last message. Callers that record an "explicit mention
   * required" side effect (Slack footer/redis) should act only on this case.
   */
  interjectionDetected: boolean;
};

/**
 * Compare ordered provider message ids. Return negative when `left` is older
 * than `right`, zero when equal, positive when `left` is newer.
 */
type CompareMessageIds = (left: string, right: string) => number;

export function compareNumericMessageIds(left: string, right: string): number {
  const leftValue = Number(left);
  const rightValue = Number(right);
  if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
    return left.localeCompare(right);
  }
  if (leftValue === rightValue) return 0;
  return leftValue < rightValue ? -1 : 1;
}

export function compareBigIntMessageIds(left: string, right: string): number {
  try {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    if (leftId === rightId) return 0;
    return leftId < rightId ? -1 : 1;
  } catch {
    return left.localeCompare(right);
  }
}

/**
 * Core decision after provider-specific preconditions (DM skip, bot mention
 * skip, ownership lookup, history fetch) have already passed.
 *
 * Eligibility is limited to senders already in the conversation: task owner,
 * thread starter, or someone who mentioned the bot earlier. Routing still
 * fails when somebody else posted or was mentioned after the bot's last
 * message; a later bot reply reopens that window.
 */
export function evaluateUnmentionedThreadReplyRouting(input: {
  eventMessageId: string;
  senderUserId: string;
  isThreadTaskOwner: boolean;
  isThreadRootAuthor: boolean;
  threadMessages: UnmentionedThreadHistoryMessage[];
  compareMessageIds: CompareMessageIds;
}): UnmentionedThreadReplyEvaluation {
  const {
    eventMessageId,
    senderUserId,
    isThreadTaskOwner,
    isThreadRootAuthor,
    threadMessages,
    compareMessageIds,
  } = input;

  if (threadMessages.length === 0) {
    return { shouldRoute: false, interjectionDetected: false };
  }

  const hasMentionedBotEarlierInThread = threadMessages.some((message) => {
    return (
      compareMessageIds(message.id, eventMessageId) < 0 &&
      !message.isBot &&
      message.authorUserId === senderUserId &&
      message.mentionsBot
    );
  });

  if (
    !isThreadTaskOwner &&
    !isThreadRootAuthor &&
    !hasMentionedBotEarlierInThread
  ) {
    return { shouldRoute: false, interjectionDetected: false };
  }

  let latestBotMessageId: string | null = null;
  for (const message of threadMessages) {
    if (!message.isBot) continue;
    if (compareMessageIds(message.id, eventMessageId) >= 0) continue;
    if (
      latestBotMessageId === null ||
      compareMessageIds(message.id, latestBotMessageId) > 0
    ) {
      latestBotMessageId = message.id;
    }
  }

  for (const message of threadMessages) {
    // When no bot message is identifiable, treat the whole thread as the
    // window (conservative: an interjection anywhere requires a mention).
    if (compareMessageIds(message.id, eventMessageId) >= 0) {
      continue;
    }
    if (
      latestBotMessageId !== null &&
      compareMessageIds(message.id, latestBotMessageId) <= 0
    ) {
      continue;
    }

    if (message.isBot || !message.authorUserId) {
      continue;
    }

    const isMessageFromSomebodyElse = message.authorUserId !== senderUserId;
    if (isMessageFromSomebodyElse || message.mentionsSomebodyElse) {
      return { shouldRoute: false, interjectionDetected: true };
    }
  }

  return { shouldRoute: true, interjectionDetected: false };
}
