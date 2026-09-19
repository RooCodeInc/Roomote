import { listChatDestinations } from './chat-api-client.js';
import { catchError, jsonResult } from './tool-result.js';
import type { ChatDestinationLookupInput } from '@roomote/types';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleListChatDestinations(
  input: ChatDestinationLookupInput,
  roomoteConfig: RoomoteConfig,
): Promise<ToolResult> {
  try {
    return jsonResult(await listChatDestinations(roomoteConfig, input));
  } catch (error) {
    return catchError(error);
  }
}
