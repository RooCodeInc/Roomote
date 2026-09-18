import { listChatDestinations } from './chat-api-client.js';
import { catchError, jsonResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleListChatDestinations(
  roomoteConfig: RoomoteConfig,
): Promise<ToolResult> {
  try {
    return jsonResult(await listChatDestinations(roomoteConfig));
  } catch (error) {
    return catchError(error);
  }
}
