import { getDiscordThread } from './discord-api-client.js';
import { catchError, jsonResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleGetDiscordThread(
  input: {
    channel?: string;
    messageId?: string;
    messageLink?: string;
  },
  roomoteConfig: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const channel = input.channel?.trim();
    const messageId = input.messageId?.trim();
    const messageLink = input.messageLink?.trim();

    return jsonResult(
      await getDiscordThread(roomoteConfig, {
        ...(channel ? { channel } : {}),
        ...(messageId ? { messageId } : {}),
        ...(messageLink ? { messageLink } : {}),
      }),
    );
  } catch (error) {
    return catchError(error);
  }
}
