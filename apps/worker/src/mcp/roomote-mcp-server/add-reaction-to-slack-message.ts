import fs from 'node:fs';

import { CHAT_REPLY_SATISFACTION_STATE_FILE_ENV } from './chat-reply-satisfaction.js';
import { addReactionToChatMessage } from './chat-api-client.js';
import { catchError, errorResult, successResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

const CHANNEL_TARGET_ERROR =
  'channel must be a Slack channel ID, channel name, or Slack channel mention like C123ABC456, #eng, eng, or <#C123ABC456>';
const DIRECT_MESSAGE_ERROR =
  'direct message IDs are not supported; use a Slack channel ID or channel name instead';
const FIRST_TURN_REACTION_ERROR =
  'emoji reactions are not allowed on the first Slack turn of a task; use send_chat_reply instead';
const REACTION_NAME_ERROR =
  'name must be a Slack emoji name without surrounding colons, for example eyes or white_check_mark';
const SLACK_CHANNEL_ID_REGEX = /^[CG][A-Z0-9]{8,}$/i;
const SLACK_DIRECT_MESSAGE_ID_REGEX = /^D[A-Z0-9]{8,}$/i;
const SLACK_CHANNEL_MENTION_REGEX = /^<#([A-Z0-9]{9,})(?:\|[^>]+)?>$/i;

function normalizeSlackChannelTarget(
  channel: string,
): { value: string } | { error: string } | null {
  const trimmedChannel = channel.trim();
  if (!trimmedChannel) {
    return null;
  }

  const mentionMatch = trimmedChannel.match(SLACK_CHANNEL_MENTION_REGEX);
  const channelId = (mentionMatch?.[1] ?? trimmedChannel).toUpperCase();

  if (SLACK_DIRECT_MESSAGE_ID_REGEX.test(channelId)) {
    return { error: DIRECT_MESSAGE_ERROR };
  }

  if (SLACK_CHANNEL_ID_REGEX.test(channelId)) {
    return { value: channelId };
  }

  const channelName = trimmedChannel.startsWith('#')
    ? trimmedChannel.slice(1)
    : trimmedChannel;

  if (!/^[^\s#<>|]+$/i.test(channelName)) {
    return { error: CHANNEL_TARGET_ERROR };
  }

  return { value: `#${channelName.toLowerCase()}` };
}

function normalizeReactionName(name: string): string | null {
  const trimmedName = name.trim().replace(/^:+|:+$/g, '');

  if (!trimmedName || /\s/.test(trimmedName)) {
    return null;
  }

  return trimmedName;
}

function readCurrentTurnReactionPolicy(): {
  currentTurnMessageTs: string | null;
  currentTurnReactionsAllowed: boolean;
} {
  const stateFilePath =
    process.env[CHAT_REPLY_SATISFACTION_STATE_FILE_ENV]?.trim();
  if (!stateFilePath) {
    return {
      currentTurnMessageTs: null,
      currentTurnReactionsAllowed: true,
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as {
      currentTurnMessageTs?: unknown;
      currentTurnReactionsAllowed?: unknown;
    };

    return {
      currentTurnMessageTs:
        typeof parsed.currentTurnMessageTs === 'string' &&
        parsed.currentTurnMessageTs.trim()
          ? parsed.currentTurnMessageTs.trim()
          : null,
      currentTurnReactionsAllowed: parsed.currentTurnReactionsAllowed !== false,
    };
  } catch {
    return {
      currentTurnMessageTs: null,
      currentTurnReactionsAllowed: true,
    };
  }
}

export async function handleAddReactionToSlackMessage(
  input: {
    channel: string;
    messageTs: string;
    name: string;
  },
  roomoteConfig: RoomoteConfig,
): Promise<ToolResult> {
  const rawChannel = input.channel.trim();
  if (!rawChannel) {
    return errorResult('channel is required');
  }
  const channelTarget = normalizeSlackChannelTarget(rawChannel);
  if (!channelTarget) {
    return errorResult('channel is required');
  }
  if ('error' in channelTarget) {
    return errorResult(channelTarget.error);
  }

  const messageTs = input.messageTs.trim();
  if (!messageTs) {
    return errorResult('messageTs is required');
  }

  const { currentTurnMessageTs, currentTurnReactionsAllowed } =
    readCurrentTurnReactionPolicy();
  if (
    !currentTurnReactionsAllowed &&
    currentTurnMessageTs &&
    currentTurnMessageTs === messageTs
  ) {
    return errorResult(FIRST_TURN_REACTION_ERROR);
  }

  const normalizedName = normalizeReactionName(input.name);
  if (!normalizedName) {
    return errorResult(REACTION_NAME_ERROR);
  }

  try {
    const response = await addReactionToChatMessage(roomoteConfig, {
      channel: channelTarget.value,
      messageTs,
      name: normalizedName,
    });

    return successResult({ ...response });
  } catch (error) {
    return catchError(error);
  }
}
