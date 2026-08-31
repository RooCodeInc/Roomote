import fs from 'node:fs';

import {
  CHAT_REPLY_SATISFACTION_STATE_FILE_ENV,
  isChatTurnMessageTs,
} from './chat-reply-satisfaction.js';
import { handleAddReactionToSlackMessage } from './add-reaction-to-slack-message.js';
import { addReactionToChatMessage } from './chat-api-client.js';
import { catchError, errorResult, successResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

const FIRST_TURN_REACTION_ERROR =
  'emoji reactions are not allowed on the first chat turn of a task; use send_chat_reply instead';
const NON_CHAT_TURN_REACTION_ERROR =
  'current turn did not originate from a chat message; use send_chat_reply instead';

function getCurrentTurnState(): {
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
    const currentTurnMessageTs =
      typeof parsed.currentTurnMessageTs === 'string'
        ? parsed.currentTurnMessageTs.trim()
        : '';
    const currentTurnReactionsAllowed =
      parsed.currentTurnReactionsAllowed !== false;

    return {
      currentTurnMessageTs: currentTurnMessageTs || null,
      currentTurnReactionsAllowed,
    };
  } catch {
    return {
      currentTurnMessageTs: null,
      currentTurnReactionsAllowed: true,
    };
  }
}

function normalizeReactionName(name: string): string | null {
  const trimmedName = name.trim().replace(/^:+|:+$/g, '');

  if (!trimmedName || /\s/.test(trimmedName)) {
    return null;
  }

  return trimmedName;
}

export async function handleSendChatReactionEmoji(
  input: {
    name: string;
  },
  roomoteConfig: RoomoteConfig,
): Promise<ToolResult> {
  const communicationProvider =
    process.env.ROOMOTE_COMMUNICATION_PROVIDER?.trim();
  if (communicationProvider === 'agentmail') {
    return errorResult(
      'Email has no reactions; reply with send_chat_reply when a response is needed',
    );
  }
  const isCommunicationReactionContext =
    communicationProvider === 'telegram' ||
    communicationProvider === 'teams' ||
    communicationProvider === 'discord';
  const channel = isCommunicationReactionContext
    ? process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID?.trim()
    : process.env.ROOMOTE_SLACK_CHANNEL?.trim();
  if (!channel) {
    return errorResult(
      'no chat channel is configured for this task (ROOMOTE_SLACK_CHANNEL or communication provider context)',
    );
  }

  const { currentTurnMessageTs, currentTurnReactionsAllowed } =
    getCurrentTurnState();
  if (!currentTurnMessageTs) {
    return errorResult(
      'current chat turn message timestamp is unavailable for this task',
    );
  }

  if (!currentTurnReactionsAllowed) {
    return errorResult(FIRST_TURN_REACTION_ERROR);
  }

  if (!isChatTurnMessageTs(currentTurnMessageTs)) {
    return errorResult(NON_CHAT_TURN_REACTION_ERROR);
  }

  if (isCommunicationReactionContext) {
    const normalizedName = normalizeReactionName(input.name);
    if (!normalizedName) {
      return errorResult(
        'name must be an emoji name without surrounding colons, for example eyes or white_check_mark',
      );
    }

    try {
      const response = await addReactionToChatMessage(roomoteConfig, {
        channel,
        messageTs: currentTurnMessageTs,
        name: normalizedName,
      });

      return successResult({ ...response });
    } catch (error) {
      return catchError(error);
    }
  }

  return handleAddReactionToSlackMessage(
    {
      channel,
      messageTs: currentTurnMessageTs,
      name: input.name,
    },
    roomoteConfig,
  );
}
