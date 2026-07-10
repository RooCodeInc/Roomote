import { SETUP_ONBOARDING_SUGGESTION_METADATA_EVENT_TYPE } from '../constants.js';

export function parseSetupSuggestionIdFromSlackMessageMetadata(
  metadata: {
    event_type: string;
    event_payload: Record<string, unknown>;
  } | null,
): string | null {
  if (
    !metadata ||
    metadata.event_type !== SETUP_ONBOARDING_SUGGESTION_METADATA_EVENT_TYPE
  ) {
    return null;
  }

  const suggestionId = metadata.event_payload.suggestionId;

  return typeof suggestionId === 'string' && suggestionId.length > 0
    ? suggestionId
    : null;
}
