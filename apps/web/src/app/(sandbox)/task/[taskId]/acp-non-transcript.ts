import { ACP_ENVELOPE_EVENT_TYPES, ACP_LIVE_EVENT_TYPES } from '@roomote/types';

const NON_TRANSCRIPT_ACP_EVENT_TYPES = new Set<string>([
  ACP_ENVELOPE_EVENT_TYPES.QueuedMessagesUpdate,
  ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
  ACP_LIVE_EVENT_TYPES.UsageUpdate,
  ACP_LIVE_EVENT_TYPES.ProviderUsage,
  ACP_LIVE_EVENT_TYPES.AvailableCommandsUpdate,
  ACP_LIVE_EVENT_TYPES.CurrentModeUpdate,
  ACP_LIVE_EVENT_TYPES.PermissionsStateUpdate,
  ACP_LIVE_EVENT_TYPES.ConfigOptionUpdate,
]);

/**
 * Returns true for runtime event types that should never appear in the chat
 * transcript. Note: `RequestUserInput` is handled specially upstream in
 * `AcpProtocolService` (to extract the payload) before this check runs;
 * it is included here as a safety net.
 */
export function isNonTranscriptAcpEvent(updateType: string): boolean {
  return NON_TRANSCRIPT_ACP_EVENT_TYPES.has(updateType);
}
