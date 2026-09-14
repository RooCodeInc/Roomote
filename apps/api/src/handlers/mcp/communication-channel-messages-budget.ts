import type {
  CommunicationChannelMessagesPayload,
  CommunicationLookupMessage,
} from './communication-message-lookup-types';

/**
 * Upper bound on the pretty-printed size of a channel messages payload.
 *
 * Agents receive tool output as indented JSON and truncate it around 50k
 * characters by keeping the head and tail, which silently drops the middle of
 * a busy channel. Bounding the payload here keeps the JSON intact and tells
 * the agent how to page for the rest.
 */
export const CHANNEL_MESSAGES_RESULT_BUDGET_CHARS = 36_000;

const MESSAGE_INDENT_CHARS = 4;

function serializedSize(value: unknown): number {
  return JSON.stringify(value, null, 2).length;
}

function estimateMessageSize(message: CommunicationLookupMessage): number {
  const text = JSON.stringify(message, null, 2);
  const lineCount = text.split('\n').length;
  // Each message line sits two levels deep inside `messages`, plus the
  // separating comma and newline.
  return text.length + lineCount * MESSAGE_INDENT_CHARS + 2;
}

export type BudgetedCommunicationChannelMessagesPayload =
  CommunicationChannelMessagesPayload & {
    truncated?: true;
    omittedMessageCount?: number;
    nextLatest?: string;
    note?: string;
  };

/**
 * Keep the newest messages that fit the budget. The messages arrive oldest
 * first, so the oldest are dropped first; the response names the newest
 * message that was dropped so the caller can page further back with
 * `latest` (inclusive on both providers) without repeating what it has.
 */
export function applyChannelMessagesResultBudget(
  payload: CommunicationChannelMessagesPayload,
  budgetChars: number = CHANNEL_MESSAGES_RESULT_BUDGET_CHARS,
): BudgetedCommunicationChannelMessagesPayload {
  if (serializedSize(payload) <= budgetChars) {
    return payload;
  }

  const { messages } = payload;
  const baseSize = serializedSize({ ...payload, messages: [] });
  let keep = 0;
  let used = baseSize;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const size = estimateMessageSize(messages[index]!);
    if (used + size > budgetChars && keep > 0) {
      break;
    }
    used += size;
    keep += 1;
  }

  let kept = messages.slice(messages.length - keep);
  const build = (
    subset: CommunicationLookupMessage[],
  ): BudgetedCommunicationChannelMessagesPayload => {
    const omitted = messages.length - subset.length;
    const newestOmitted = messages[omitted - 1];
    return {
      ...payload,
      messageCount: subset.length,
      messages: subset,
      truncated: true,
      omittedMessageCount: omitted,
      ...(newestOmitted ? { nextLatest: newestOmitted.id } : {}),
      note: `Result truncated to the newest ${subset.length} of ${messages.length} messages in the requested range. To read the older messages, call again with latest set to nextLatest and the same oldest; that page will not repeat any message returned here.`,
    };
  };

  // The estimate is conservative in the common case; confirm against the
  // real serialization and shed messages until it fits, never below one.
  let result = build(kept);
  while (kept.length > 1 && serializedSize(result) > budgetChars) {
    kept = kept.slice(1);
    result = build(kept);
  }

  return result;
}
