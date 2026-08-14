import type { RoomoteConfig } from '../mcp/roomote-mcp-server/types';

export function getChatFallbackDeliveryConfig(
  mcpTaskEnv: Record<string, string> | undefined,
): RoomoteConfig | null {
  if (!mcpTaskEnv) {
    return null;
  }

  const hasSlackContext = Boolean(mcpTaskEnv.ROOMOTE_SLACK_CHANNEL?.trim());
  const hasCommunicationContext = Boolean(
    mcpTaskEnv.ROOMOTE_COMMUNICATION_PROVIDER?.trim() &&
    mcpTaskEnv.ROOMOTE_COMMUNICATION_CHANNEL_ID?.trim(),
  );
  const token =
    mcpTaskEnv.ROOMOTE_CLOUD_TOKEN?.trim() || mcpTaskEnv.AUTH_TOKEN?.trim();
  const platformApiUrl =
    mcpTaskEnv.ROOMOTE_PLATFORM_API_URL?.trim() ||
    mcpTaskEnv.TRPC_URL?.trim() ||
    'http://localhost:13001';

  if ((!hasSlackContext && !hasCommunicationContext) || !token) {
    return null;
  }

  return {
    token,
    platformApiUrl: platformApiUrl.replace(/\/+$/, ''),
    authBypassHeaderName:
      mcpTaskEnv.ROOMOTE_AUTH_BYPASS_HEADER_NAME?.trim() || undefined,
    authBypassHeaderValue:
      mcpTaskEnv.ROOMOTE_AUTH_BYPASS_VALUE?.trim() || undefined,
  };
}
