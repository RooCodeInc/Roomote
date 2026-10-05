/**
 * Shared unmentioned thread-reply routing for Slack, Discord, and Teams.
 *
 * Once provider-specific filters decide a reply is an unmentioned follow-up in
 * a Roomote-owned conversation, the eligibility and "somebody else spoke /
 * was mentioned since the bot last replied" rules are identical.
 */

import { evaluateTypeSafeJudgments } from '@roomote/cloud-agents/server/typesafe-judgment';
import { REPLY_ADDRESSEE_QUESTION } from '@roomote/cloud-agents/server/judgment-questions';

/**
 * One mention in a message's text, resolved by the provider so the judgment
 * state can name who it is for without a raw provider id.
 */
export type UnmentionedThreadMention = {
  /**
   * The mention exactly as it appears in the text: Slack `<@U123>` or
   * `<@U123|name>`, Discord `<@123>` or `<@!123>`, or the Teams display name or
   * `<at>…</at>` tag.
   */
  token: string;
  /** Provider id of the mentioned user or application, when known. */
  userId?: string | null;
  /** True when the mention names Roomote. */
  isBot: boolean;
};

export type UnmentionedThreadHistoryMessage = {
  /** Provider message id (Slack ts, Discord snowflake, Teams activity id). */
  id: string;
  /** Human author provider user id when human-authored. */
  authorUserId: string | null | undefined;
  isBot: boolean;
  /** True when this history message @-mentions the Roomote bot. */
  mentionsBot: boolean;
  /** True when this history message mentions someone other than its author or the bot. */
  mentionsSomebodyElse: boolean;
  /** Message text, used only by the optional judgment model. */
  text?: string;
  /** Mentions in `text`, rewritten to role labels for the judgment model. */
  mentions?: UnmentionedThreadMention[];
};

type UnmentionedThreadReplyEvaluation = {
  shouldRoute: boolean;
  /**
   * True when routing failed because somebody else posted or was mentioned
   * since the bot's last message. Callers that record an "explicit mention
   * required" side effect (Slack footer/redis) should act only on this case.
   */
  interjectionDetected: boolean;
  /**
   * True when the heuristic refused because of an interjection but the
   * optional judgment model was confident the reply is for Roomote.
   */
  routedByJudgmentModel?: boolean;
};

type UnmentionedThreadReplyEvaluationOptions = {
  /**
   * Restore the legacy peer-participation cutoff for an open conversation.
   * Used only after Slack has established that no judgment model is selected.
   */
  includeOtherHumanAuthorsInOpenConversation?: boolean;
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
 * thread starter, or someone who mentioned the bot earlier. Automation reports
 * and other open Roomote conversations have no single owning participant, so
 * any human reply there is eligible. Speaker changes are expected in open
 * conversations, but routing still fails when somebody else was mentioned
 * after the bot's last message unless an opted-in peer conversation passes
 * that message to the judgment gate; a later bot reply reopens the window.
 */
export function evaluateUnmentionedThreadReplyRouting(
  input: {
    eventMessageId: string;
    senderUserId: string;
    isThreadTaskOwner: boolean;
    isThreadRootAuthor: boolean;
    isAutomationReportThread?: boolean;
    /** True when any human participant may address Roomote in this conversation. */
    isOpenConversationThread?: boolean;
    /**
     * True when an opted-in conversation intentionally admits peer chatter to
     * the judgment gate instead of using the legacy interjection cutoff.
     */
    allowPeerConversationMessages?: boolean;
    threadMessages: UnmentionedThreadHistoryMessage[];
    compareMessageIds: CompareMessageIds;
  },
  options: UnmentionedThreadReplyEvaluationOptions = {},
): UnmentionedThreadReplyEvaluation {
  const {
    eventMessageId,
    senderUserId,
    isThreadTaskOwner,
    isThreadRootAuthor,
    isAutomationReportThread = false,
    isOpenConversationThread = false,
    allowPeerConversationMessages = false,
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
    !hasMentionedBotEarlierInThread &&
    !isAutomationReportThread &&
    !isOpenConversationThread
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

    const isMessageFromSomebodyElse =
      (!isOpenConversationThread ||
        options.includeOtherHumanAuthorsInOpenConversation === true) &&
      message.authorUserId !== senderUserId;
    if (
      isMessageFromSomebodyElse ||
      (message.mentionsSomebodyElse && !allowPeerConversationMessages)
    ) {
      return { shouldRoute: false, interjectionDetected: true };
    }
  }

  return { shouldRoute: true, interjectionDetected: false };
}

/** Only this many messages before the reply are shown to the judgment model. */
const JUDGMENT_MAX_THREAD_MESSAGES = 20;
const JUDGMENT_MAX_MESSAGE_LENGTH = 1_500;
const JUDGMENT_MAX_REPLY_LENGTH = 4_000;

/**
 * An unmentioned reply routes when Roomote is the strict majority addressee:
 * more probability than the other two options combined, exceeding this value. Human-to-human traffic
 * scores far below this, while the bar stays meaningful across judgment
 * backends whose absolute probabilities are calibrated differently. Routing
 * is not yet a reply: Fast may still stay silent in a multi-human thread when
 * Roomote was not the last speaker. Starting value, not tuned.
 */
const JUDGMENT_ROUTE_TO_ROOMOTE_MIN = 0.5;

function truncateForJudgment(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * Raw user, role, and group mention syntax left after provider mentions are
 * rewritten (a mention the provider did not resolve): Slack `<@U123>`,
 * `<@W123|name>`, `<!subteam^S123|@team>`; Discord `<@123>`, `<@!123>`,
 * `<@&123>`. Replaced so no provider id reaches the judgment state.
 */
const UNRESOLVED_MENTION_PATTERN =
  /<@[!&]?[A-Z0-9]+(?:\|[^>]*)?>|<!subteam\^[^>]+>/giu;

function rewriteMentions(
  text: string,
  mentions: UnmentionedThreadMention[] | undefined,
  labelFor: (mention: UnmentionedThreadMention) => string,
): string {
  let rewritten = text;
  // Longest first, so a display name that contains another is replaced whole.
  const ordered = [...(mentions ?? [])]
    .filter((mention) => mention.token.length > 0)
    .sort((left, right) => right.token.length - left.token.length);
  for (const mention of ordered) {
    rewritten = rewritten.split(mention.token).join(labelFor(mention));
  }
  return rewritten.replace(UNRESOLVED_MENTION_PATTERN, '@someone else');
}

function buildReplyAddresseeState(params: {
  eventMessageId: string;
  senderUserId: string;
  eventText: string;
  eventMentions?: UnmentionedThreadMention[];
  eventMentionsSomebodyElse?: boolean;
  threadMessages: UnmentionedThreadHistoryMessage[];
  compareMessageIds: CompareMessageIds;
}) {
  const earlierMessages = params.threadMessages
    .filter(
      (message) =>
        params.compareMessageIds(message.id, params.eventMessageId) < 0,
    )
    .sort((left, right) => params.compareMessageIds(left.id, right.id))
    .slice(-JUDGMENT_MAX_THREAD_MESSAGES);

  // Provider user ids are replaced with stable role labels so the model sees
  // who is who without raw identifiers. Mentions use the same labels as
  // authors, so "@participant 1" in a message is the person who wrote as
  // "participant 1".
  const participantLabels = new Map<string, string>();
  const participantLabel = (userId: string): string => {
    let label = participantLabels.get(userId);
    if (!label) {
      label = `participant ${participantLabels.size + 1}`;
      participantLabels.set(userId, label);
    }
    return label;
  };
  const authorLabel = (message: UnmentionedThreadHistoryMessage): string => {
    if (message.isBot) return 'Roomote';
    if (!message.authorUserId) return 'other app';
    if (message.authorUserId === params.senderUserId) return 'reply author';
    return participantLabel(message.authorUserId);
  };
  const mentionLabel = (mention: UnmentionedThreadMention): string => {
    if (mention.isBot) return '@Roomote';
    if (!mention.userId) return '@someone else';
    if (mention.userId === params.senderUserId) return '@reply author';
    return `@${participantLabel(mention.userId)}`;
  };

  // Authors are labelled in thread order before any mention is, so a
  // participant's label does not depend on who mentioned them first.
  const authors = earlierMessages.map(authorLabel);
  const eventMentions = params.eventMentions ?? [];

  return {
    thread: {
      messages: earlierMessages.map((message, index) => ({
        author: authors[index]!,
        // Rewritten before truncation so a cut never leaves half a raw token.
        text: truncateForJudgment(
          rewriteMentions(
            message.text?.trim() ?? '',
            message.mentions,
            mentionLabel,
          ),
          JUDGMENT_MAX_MESSAGE_LENGTH,
        ),
        mentionsRoomote: message.mentionsBot,
        mentionsSomebodyElse: message.mentionsSomebodyElse,
      })),
    },
    reply: {
      author: 'reply author',
      text: truncateForJudgment(
        rewriteMentions(params.eventText.trim(), eventMentions, mentionLabel),
        JUDGMENT_MAX_REPLY_LENGTH,
      ),
      mentionsRoomote: eventMentions.some((mention) => mention.isBot),
      mentionsSomebodyElse:
        params.eventMentionsSomebodyElse ??
        eventMentions.some(
          (mention) => !mention.isBot && mention.userId !== params.senderUserId,
        ),
    },
  };
}

type AddresseeChoice = 'roomote' | 'participant' | 'unclear';

type UnmentionedReplyJudgment =
  | { kind: 'unconfigured' }
  | { kind: 'decision'; shouldRoute: boolean }
  | { kind: 'failed' };

function isUnitInterval(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isValidAddresseeAnswer(value: unknown): value is {
  type: 'choice';
  choice: AddresseeChoice;
  probabilities: Record<AddresseeChoice, number>;
  confidence: number;
} {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const answer = value as Record<string, unknown>;
  const probabilities = answer.probabilities;
  if (
    answer.type !== 'choice' ||
    !['roomote', 'participant', 'unclear'].includes(answer.choice as string) ||
    !isUnitInterval(answer.confidence) ||
    typeof probabilities !== 'object' ||
    probabilities === null ||
    Array.isArray(probabilities)
  ) {
    return false;
  }

  const probabilityRecord = probabilities as Record<string, unknown>;
  const choices: AddresseeChoice[] = ['roomote', 'participant', 'unclear'];
  if (
    Object.keys(probabilityRecord).length !== choices.length ||
    !choices.every((choice) => isUnitInterval(probabilityRecord[choice]))
  ) {
    return false;
  }

  // The majority threshold only means something over a real distribution,
  // so a vector that does not sum to one is treated as malformed.
  const total = choices.reduce(
    (sum, choice) => sum + (probabilityRecord[choice] as number),
    0,
  );
  return Math.abs(total - 1) <= PROBABILITY_SUM_TOLERANCE;
}

/** Probabilities are reported rounded, so the sum may miss one slightly. */
const PROBABILITY_SUM_TOLERANCE = 0.05;

function normalizeProbabilities(
  probabilities: Record<AddresseeChoice, number>,
): Record<AddresseeChoice, number> {
  const total =
    probabilities.roomote + probabilities.participant + probabilities.unclear;
  return {
    roomote: probabilities.roomote / total,
    participant: probabilities.participant / total,
    unclear: probabilities.unclear / total,
  };
}

/**
 * The option with strictly the most probability, or null on a tie; `choice`
 * is not trusted for this.
 */
function likeliestAddressee(
  probabilities: Record<AddresseeChoice, number>,
): AddresseeChoice | null {
  const ranked = (['roomote', 'participant', 'unclear'] as const)
    .map((choice) => ({ choice, probability: probabilities[choice] }))
    .sort((left, right) => right.probability - left.probability);
  return ranked[0]!.probability > ranked[1]!.probability
    ? ranked[0]!.choice
    : null;
}

/**
 * Asks the optional judgment model who an eligible unmentioned reply is for.
 * A null result means
 * the deployment has no judgment backend and preserves the existing heuristic
 * behavior. Once a backend is configured, transport, validation, and
 * uncertainty failures fail closed so human-to-human messages do not start an
 * assistant activity by accident.
 */
async function judgeUnmentionedReplyAddressee(
  params: Parameters<typeof buildReplyAddresseeState>[0],
): Promise<UnmentionedReplyJudgment> {
  try {
    const answers = await evaluateTypeSafeJudgments({
      decision: 'unmentioned-thread-reply',
      state: buildReplyAddresseeState(params),
      questions: {
        addressee: REPLY_ADDRESSEE_QUESTION,
      },
    });

    if (answers === null) {
      return { kind: 'unconfigured' };
    }

    if (!isValidAddresseeAnswer(answers.addressee)) {
      console.warn(
        '[UnmentionedThreadReply] Judgment model returned an invalid addressee answer, keeping the explicit-mention requirement',
      );
      return { kind: 'failed' };
    }

    // Normalize so rounding slack in the reported vector cannot lift a
    // sub-majority Roomote score over the bar.
    const probabilities = normalizeProbabilities(
      answers.addressee.probabilities,
    );
    const shouldRoute =
      likeliestAddressee(probabilities) === 'roomote' &&
      probabilities.roomote > JUDGMENT_ROUTE_TO_ROOMOTE_MIN;

    // Scores only, never message text, so operators can read the gate's
    // calibration off ordinary logs.
    console.info(
      `[UnmentionedThreadReply] Judged reply ${params.eventMessageId}: addressee=${answers.addressee.choice} roomote=${probabilities.roomote.toFixed(2)} participant=${probabilities.participant.toFixed(2)} unclear=${probabilities.unclear.toFixed(2)} route=${shouldRoute}`,
    );

    return { kind: 'decision', shouldRoute };
  } catch (error) {
    console.warn(
      `[UnmentionedThreadReply] Judgment model failed, keeping the explicit-mention requirement: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { kind: 'failed' };
  }
}

function hasAnotherHumanInConversation(input: {
  senderUserId: string;
  eventMentionsSomebodyElse?: boolean;
  threadMessages: UnmentionedThreadHistoryMessage[];
}): boolean {
  return (
    input.eventMentionsSomebodyElse === true ||
    input.threadMessages.some(
      (message) =>
        message.mentionsSomebodyElse ||
        (!message.isBot &&
          Boolean(message.authorUserId) &&
          message.authorUserId !== input.senderUserId),
    )
  );
}

/**
 * `evaluateUnmentionedThreadReplyRouting` plus the optional judgment model.
 *
 * The model is consulted only after the sender passed the eligibility checks,
 * so it can never route a reply from an ineligible sender, and only when
 * another human is part of the conversation, since a sender alone with
 * Roomote can be addressing nobody else. Explicit Roomote
 * mentions do not enter this helper and therefore cannot be vetoed here. A
 * configured model must find Roomote the likeliest addressee; an unconfigured
 * model falls back to the existing heuristic, while every configured failure
 * or participant/unclear answer stays silent. Whether a routed reply deserves
 * an answer (a bare "thanks") is left to Fast.
 */
export async function resolveUnmentionedThreadReplyRouting(
  input: Parameters<typeof evaluateUnmentionedThreadReplyRouting>[0] & {
    /** Text of the reply being routed. */
    eventText: string;
    /** Mentions in `eventText`, rewritten to role labels for the judgment model. */
    eventMentions?: UnmentionedThreadMention[];
    /** True when the reply itself mentions a human other than the sender. */
    eventMentionsSomebodyElse?: boolean;
    /**
     * In a user-owned Slack Fast conversation, restore the legacy peer cutoff
     * only if no judgment model is selected. Selected-model decisions remain
     * authoritative.
     */
    conservativePeerConversationFallback?: boolean;
  },
): Promise<UnmentionedThreadReplyEvaluation> {
  const {
    eventText,
    eventMentions,
    eventMentionsSomebodyElse,
    conservativePeerConversationFallback = false,
    ...routingInput
  } = input;
  const decision = evaluateUnmentionedThreadReplyRouting(routingInput);

  // A false/non-interjected result is either an ineligible sender or unreliable
  // empty history. Do not spend a judgment request on either case.
  if (!decision.shouldRoute && !decision.interjectionDetected) {
    return decision;
  }

  // Alone with Roomote and nobody else mentioned, the sender has only one
  // possible addressee; the model would add latency and a false-silence risk.
  if (
    decision.shouldRoute &&
    !decision.interjectionDetected &&
    !hasAnotherHumanInConversation(input)
  ) {
    return decision;
  }

  const judgment = await judgeUnmentionedReplyAddressee({
    eventMessageId: routingInput.eventMessageId,
    senderUserId: routingInput.senderUserId,
    eventText,
    eventMentions,
    eventMentionsSomebodyElse,
    threadMessages: routingInput.threadMessages,
    compareMessageIds: routingInput.compareMessageIds,
  });

  if (judgment.kind === 'unconfigured') {
    if (conservativePeerConversationFallback) {
      // The legacy Slack fallback treated a current peer mention, or another
      // human's participation/mention since Roomote's latest reply, as an
      // interjection. A later Roomote reply therefore reopens the window.
      if (eventMentionsSomebodyElse) {
        return { shouldRoute: false, interjectionDetected: true };
      }

      return evaluateUnmentionedThreadReplyRouting(
        { ...routingInput, allowPeerConversationMessages: false },
        { includeOtherHumanAuthorsInOpenConversation: true },
      );
    }

    return decision;
  }

  if (judgment.kind === 'decision' && judgment.shouldRoute) {
    return {
      shouldRoute: true,
      interjectionDetected: false,
      routedByJudgmentModel: true,
    };
  }

  // Preserve the existing interjection side effect so provider callers keep
  // their explicit-mention reminder as a backstop when Jev declines the turn.
  if (decision.interjectionDetected) {
    return decision;
  }

  return { shouldRoute: false, interjectionDetected: false };
}
