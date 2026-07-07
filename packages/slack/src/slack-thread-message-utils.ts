import { getSlackThreadDisplayName } from '@roomote/cloud-agents';

import type { SlackThreadMessage } from './types';

const SLACK_STARTED_MESSAGE_PREFIX = 'Getting started on your task';
const PROMPT_CONTROL_ACTION_IDS = new Set(['follow_task', 'cancel_task']);

function compareSlackTimestamps(left: string, right: string): number {
  return Number(left) - Number(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasPromptControlActionBlocks(blocks?: unknown[]): boolean {
  return (blocks ?? []).some((block) => {
    if (!isRecord(block) || block.type !== 'actions') {
      return false;
    }

    if (!Array.isArray(block.elements)) {
      return false;
    }

    return block.elements.some(
      (element) =>
        isRecord(element) &&
        typeof element.action_id === 'string' &&
        PROMPT_CONTROL_ACTION_IDS.has(element.action_id),
    );
  });
}

export function isTargetSlackBotMessage(
  message: Pick<SlackThreadMessage, 'bot_id' | 'user'>,
  botUserId?: string,
): boolean {
  if (!botUserId) {
    return false;
  }

  // Real Slack bot-authored messages carry the bot's user ID (`U…`, the OAuth
  // `bot_user_id`) in `user` and an unrelated `B…` ID in `bot_id`, so match on
  // either field. A `user` match alone is only trusted for bot-authored
  // messages (`bot_id` present) so a human user can never collide with it.
  return (
    message.bot_id === botUserId ||
    (Boolean(message.bot_id) && message.user === botUserId)
  );
}

export function isSlackStartedTaskMessage(
  message: {
    ts?: string;
    text: string;
    blocks?: unknown[];
    bot_id?: string;
  },
  startedMessageTs?: string | null,
): boolean {
  return (
    (startedMessageTs != null && message.ts === startedMessageTs) ||
    (Boolean(message.bot_id) &&
      message.text.trim().startsWith(SLACK_STARTED_MESSAGE_PREFIX)) ||
    hasPromptControlActionBlocks(message.blocks)
  );
}

export function isSlackStartedTaskReplyText(text: string): boolean {
  return text.trim().startsWith(SLACK_STARTED_MESSAGE_PREFIX);
}

export function splitThreadMessages(
  messages: SlackThreadMessage[],
  botUserId?: string,
  startedMessageTs?: string | null,
): {
  promptRelevantMessages: SlackThreadMessage[];
  contextMessages: SlackThreadMessage[];
  latestOwnBotReply:
    | { ts: string; text: string; displayName: string }
    | undefined;
} {
  let latestOwnBotReply:
    | { ts: string; text: string; displayName: string }
    | undefined;

  const promptRelevantMessages = messages.filter(
    (message) => !isSlackStartedTaskMessage(message, startedMessageTs),
  );

  const contextMessages = promptRelevantMessages.filter((message) => {
    if (!isTargetSlackBotMessage(message, botUserId)) {
      return true;
    }

    if (
      !latestOwnBotReply ||
      compareSlackTimestamps(message.ts, latestOwnBotReply.ts) > 0
    ) {
      latestOwnBotReply = {
        ts: message.ts,
        text: message.text,
        displayName: getSlackThreadDisplayName(message),
      };
    }

    return false;
  });

  return {
    promptRelevantMessages,
    contextMessages,
    latestOwnBotReply,
  };
}
