import { sendChatMessage } from './chat-api-client.js';
import { catchError, successResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleSendChatMessage(
  input: { destination: string; message: string },
  roomoteConfig: RoomoteConfig,
): Promise<ToolResult> {
  try {
    return successResult(await sendChatMessage(roomoteConfig, input));
  } catch (error) {
    return catchError(error);
  }
}
