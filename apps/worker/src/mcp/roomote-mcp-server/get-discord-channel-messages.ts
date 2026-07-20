import { getDiscordChannelMessages } from './discord-api-client.js';
import { catchError, jsonResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleGetDiscordChannelMessages(
  input: {
    channel?: string;
    oldest?: string;
    latest?: string;
  },
  roomoteConfig: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const channel = input.channel?.trim();
    const oldest = input.oldest?.trim();
    const latest = input.latest?.trim();

    return jsonResult(
      await getDiscordChannelMessages(roomoteConfig, {
        ...(channel ? { channel } : {}),
        ...(oldest ? { oldest } : {}),
        ...(latest ? { latest } : {}),
      }),
    );
  } catch (error) {
    return catchError(error);
  }
}
