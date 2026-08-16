import {
  type TaskPayload,
  TaskPayloadKind,
  PRODUCT_NAME,
} from '@roomote/types';

/**
 * Generates a human-readable title from a task run.
 */

const UNTITLED_TASK = 'Untitled task';
const LEADING_SLACK_MENTION_TRAILER_PATTERN = String.raw`[\s,:;.!?-]*`;
const LEADING_RAW_SLACK_MENTION_PATTERN = new RegExp(
  String.raw`^\s*(?:<@[^>]+>${LEADING_SLACK_MENTION_TRAILER_PATTERN})+`,
  'u',
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeSlackMessageContent(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeSlackAttributeValue(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function normalizeSlackThreadContextDisplayName(displayName: string): string {
  return displayName.trim().replace(/\s+/gu, ' ');
}

function compareSlackTimestamps(left: string, right: string): number {
  return Number(left) - Number(right);
}

export function getSlackThreadDisplayName({
  user,
  username,
}: Pick<SlackThreadPromptMessage, 'user' | 'username'>): string {
  return username?.trim() || user;
}

export interface SlackThreadPromptMessage {
  ts: string;
  user: string;
  username?: string;
  text: string;
  bot_id?: string;
}

export function findLatestSlackBotReply<
  T extends Pick<SlackThreadPromptMessage, 'ts' | 'user' | 'bot_id'>,
>(messages: T[], botUserId?: string): T | undefined {
  return messages.reduce<T | undefined>((latest, message) => {
    if (!message.bot_id) {
      return latest;
    }

    // Real Slack bot messages carry the bot's `U…` user ID in `user` and a
    // separate `B…` ID in `bot_id`, so accept either as the bot identity.
    if (
      botUserId &&
      message.bot_id !== botUserId &&
      message.user !== botUserId
    ) {
      return latest;
    }

    if (!latest || compareSlackTimestamps(message.ts, latest.ts) > 0) {
      return message;
    }

    return latest;
  }, undefined);
}

export function stripLeadingRawSlackMention(text: string): string {
  return text.replace(LEADING_RAW_SLACK_MENTION_PATTERN, '').trimStart();
}

export function stripLeadingSlackProductMention(text: string): string {
  const escapedProductName = escapeRegExp(PRODUCT_NAME);
  const leadingMentionPattern = new RegExp(
    `^\\s*(?:(?:@${escapedProductName}|${escapedProductName})(?=$|\\s|[,:;.!?-])[\\s,:;.!?-]*)+`,
    'i',
  );

  return text.replace(leadingMentionPattern, '').trimStart();
}

function buildSlackWrapperOpenTag(
  tagName: string,
  attributes?: {
    ts?: string;
    senderSlackId?: string;
    senderName?: string;
    senderGithub?: string;
  },
): string {
  const serializedAttributes = [
    ['ts', attributes?.ts],
    ['sender_slack_id', attributes?.senderSlackId],
    ['sender_name', attributes?.senderName],
    ['sender_github', attributes?.senderGithub],
  ]
    .flatMap(([name, value]) => {
      const normalizedValue = value?.trim();
      return normalizedValue
        ? [`${name}="${escapeSlackAttributeValue(normalizedValue)}"`]
        : [];
    })
    .join(' ');

  if (!serializedAttributes) {
    return `<${tagName}>`;
  }

  return `<${tagName} ${serializedAttributes}>`;
}

export function wrapSlackMessage(
  text: string,
  options?: {
    ts?: string;
    senderSlackId?: string;
    senderName?: string;
    senderGithub?: string;
  },
): string {
  const normalizedText = escapeSlackMessageContent(text.trim());
  const openTag = buildSlackWrapperOpenTag('slack_message', options);

  return `${openTag}\n${normalizedText}\n</slack_message>`;
}

export function wrapSlackTurnPolicy({
  reactionsAllowed,
  preferEmojiAck,
}: {
  reactionsAllowed: boolean;
  preferEmojiAck: boolean;
}): string {
  const guidance = reactionsAllowed
    ? preferEmojiAck
      ? 'Emoji reactions are allowed on the current Slack message. Prefer `send_chat_reaction_emoji` instead of a short text acknowledgement when a lightweight acknowledgement or emoji-only answer is enough.'
      : 'Emoji reactions are allowed on the current Slack message.'
    : 'Emoji reactions are not allowed on the current Slack message. Use `send_chat_reply` for acknowledgements and lightweight clarification. Use `request_user_input` only when the task actually needs structured or private input from the user.';

  return `<slack_turn_policy reactions_allowed="${reactionsAllowed ? 'true' : 'false'}" prefer_emoji_ack="${preferEmojiAck ? 'true' : 'false'}">\n${escapeSlackMessageContent(guidance)}\n</slack_turn_policy>`;
}

export function wrapSlackThreadActivity({
  displayName,
  text,
}: {
  displayName: string;
  text: string;
}): string | undefined {
  const normalizedDisplayName =
    normalizeSlackThreadContextDisplayName(displayName);
  const normalizedText = text.trim();

  if (!normalizedDisplayName || !normalizedText) {
    return undefined;
  }

  return `<thread_activity>\n${escapeSlackMessageContent(normalizedDisplayName)}: ${escapeSlackMessageContent(normalizedText)}\n</thread_activity>`;
}

export function wrapSlackThreadContext(
  entries: Array<{ displayName: string; text: string; ts?: string }>,
): string | undefined {
  const formattedEntries = entries
    .map(({ displayName, text, ts }) => {
      const normalizedDisplayName =
        normalizeSlackThreadContextDisplayName(displayName);
      const normalizedText = text.trim();

      if (!normalizedDisplayName || !normalizedText) {
        return null;
      }

      return `${buildSlackWrapperOpenTag('slack_thread_message', { ts })}${escapeSlackMessageContent(normalizedDisplayName)}: ${escapeSlackMessageContent(normalizedText)}</slack_thread_message>`;
    })
    .filter((entry): entry is string => entry !== null);

  if (formattedEntries.length === 0) {
    return undefined;
  }

  return `<thread_context>\n${formattedEntries.join('\n\n')}\n</thread_context>`;
}

export function wrapSlackReplyingTo({
  displayName,
  text,
  ts,
}: {
  displayName: string;
  text: string;
  ts?: string;
}): string | undefined {
  const normalizedDisplayName =
    normalizeSlackThreadContextDisplayName(displayName);
  const normalizedText = text.trim();

  if (!normalizedDisplayName || !normalizedText) {
    return undefined;
  }

  return `${buildSlackWrapperOpenTag('replying_to', { ts })}\n${escapeSlackMessageContent(normalizedDisplayName)}: ${escapeSlackMessageContent(normalizedText)}\n</replying_to>`;
}

export function buildSlackThreadPromptBlocks({
  threadMessages,
  currentMessageTs,
  latestOwnBotReply,
  includeMessagesAfterCurrent = false,
}: {
  threadMessages: SlackThreadPromptMessage[];
  currentMessageTs: string;
  latestOwnBotReply?: { ts: string; text: string };
  includeMessagesAfterCurrent?: boolean;
}): {
  threadContext: string | undefined;
  replyingTo: string | undefined;
  latestBotReplyTs: string | undefined;
} {
  const earlierMessages = threadMessages.filter(
    (message) =>
      message.ts !== currentMessageTs &&
      (includeMessagesAfterCurrent ||
        compareSlackTimestamps(message.ts, currentMessageTs) < 0) &&
      message.text.trim().length > 0,
  );
  const latestBotReply =
    latestOwnBotReply ?? findLatestSlackBotReply(earlierMessages);
  const latestBotReplyDisplayName = latestOwnBotReply
    ? PRODUCT_NAME
    : latestBotReply
      ? getSlackThreadDisplayName(latestBotReply as SlackThreadPromptMessage)
      : undefined;
  const contextMessages = earlierMessages.filter(
    (message) => message.ts !== latestBotReply?.ts,
  );

  return {
    threadContext: wrapSlackThreadContext(
      contextMessages.map((message) => ({
        displayName: getSlackThreadDisplayName(message),
        text: message.text,
        ts: message.ts,
      })),
    ),
    replyingTo:
      latestBotReply &&
      wrapSlackReplyingTo({
        displayName: latestBotReplyDisplayName!,
        text: latestBotReply.text,
        ts: latestBotReply.ts,
      }),
    latestBotReplyTs: latestBotReply?.ts,
  };
}

export function generateTaskRunTitle(
  { type, payload }: { type: TaskPayloadKind; payload: TaskPayload },
  limit: number = 10_000,
  fallbackTitle?: string | null,
): string {
  switch (type) {
    case TaskPayloadKind.GithubPrReview: {
      const prPayload = payload as TaskPayload<
        typeof TaskPayloadKind.GithubPrReview
      >;

      return `Review PR #${prPayload.prNumber}: ${prPayload.prTitle}`;
    }

    case TaskPayloadKind.GithubPrReviewSync: {
      const prPayload = payload as TaskPayload<
        typeof TaskPayloadKind.GithubPrReviewSync
      >;

      const shortSha = prPayload.headSha?.slice(0, 7) || 'unknown';

      return `Re-review PR #${prPayload.prNumber} at ${shortSha}: ${prPayload.prTitle}`;
    }

    case TaskPayloadKind.GithubPrReviewFollowUp: {
      const commentPayload = payload as TaskPayload<
        typeof TaskPayloadKind.GithubPrReviewFollowUp
      >;

      return `Follow up on PR review #${commentPayload.prNumber}: ${commentPayload.prTitle}`;
    }

    case TaskPayloadKind.SlackAppMention: {
      const slackPayload = payload as TaskPayload<
        typeof TaskPayloadKind.SlackAppMention
      >;

      const text = slackPayload.text.slice(0, limit);

      const truncated =
        text.length < slackPayload.text.length ? `${text}…` : text;

      return `Respond to Slack message: ${truncated}`;
    }

    case TaskPayloadKind.LinearAgentSession: {
      const linearPayload = payload as TaskPayload<
        typeof TaskPayloadKind.LinearAgentSession
      >;

      return `${linearPayload.issueIdentifier}: ${linearPayload.issueTitle}`;
    }

    case TaskPayloadKind.StandardTask:
    case TaskPayloadKind.Scan:
    case TaskPayloadKind.McpRecommendations: {
      const standardPayload = payload as
        | TaskPayload<typeof TaskPayloadKind.StandardTask>
        | TaskPayload<typeof TaskPayloadKind.Scan>
        | TaskPayload<typeof TaskPayloadKind.McpRecommendations>;

      if (!standardPayload.description) {
        return UNTITLED_TASK;
      }

      const desc = standardPayload.description.slice(0, limit);

      return desc.length < standardPayload.description.length
        ? `${desc}...`
        : desc;
    }

    case TaskPayloadKind.GithubPrConflictResolve: {
      const conflictPayload = payload as TaskPayload<
        typeof TaskPayloadKind.GithubPrConflictResolve
      >;

      return `Fix merge conflicts on PR #${conflictPayload.prNumber}`;
    }

    default:
      return fallbackTitle || UNTITLED_TASK;
  }
}

const DETERMINISTIC_TITLE_TASK_TYPES: ReadonlySet<TaskPayloadKind> = new Set([
  TaskPayloadKind.GithubPrReview,
  TaskPayloadKind.GithubPrReviewSync,
  TaskPayloadKind.GithubPrReviewFollowUp,
  TaskPayloadKind.GithubPrConflictResolve,
]);

/**
 * Task types whose `generateTaskRunTitle` result is a stable payload-derived
 * string such as `Review PR #<n>: <prTitle>`. These titles carry structured
 * provenance the UI relies on, so LLM title refresh must never replace them
 * with a summary of the structured startup prompt.
 */
export function hasDeterministicTaskRunTitle(type: TaskPayloadKind): boolean {
  return DETERMINISTIC_TITLE_TASK_TYPES.has(type);
}
