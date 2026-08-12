import { listChatChannels } from './chat-api-client.js';
import { catchError, jsonResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleListChatChannels(
  roomoteConfig: RoomoteConfig,
): Promise<ToolResult> {
  try {
    return jsonResult(await listChatChannels(roomoteConfig));
  } catch (error) {
    return catchError(error);
  }
}
