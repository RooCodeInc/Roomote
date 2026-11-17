import {
  normalizeChannelMessagesRequest,
  type CommunicationChannelMessagesRequest,
} from '@roomote/types';

import { getChatChannelMessages } from './chat-api-client.js';
import { catchError, jsonResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleGetChatChannelMessages(
  input: CommunicationChannelMessagesRequest,
  roomoteConfig: RoomoteConfig,
): Promise<ToolResult> {
  try {
    return jsonResult(
      await getChatChannelMessages(
        roomoteConfig,
        normalizeChannelMessagesRequest(input),
      ),
    );
  } catch (error) {
    return catchError(error);
  }
}
