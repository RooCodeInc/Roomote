import { getSlackThread } from './slack-api-client.js';
import { catchError, jsonResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleGetSlackThread(
  input: {
    channel?: string;
    messageTs: string;
  },
  roomoteConfig: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const channel = input.channel?.trim();

    return jsonResult(
      await getSlackThread(roomoteConfig, {
        ...(channel && { channel }),
        messageTs: input.messageTs.trim(),
      }),
    );
  } catch (error) {
    return catchError(error);
  }
}
