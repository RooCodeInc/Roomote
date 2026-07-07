import { SETUP_ONBOARDING_SUGGESTION_METADATA_EVENT_TYPE } from '../constants.js';

export function parseSetupSuggestionIdFromMessageKey(
  suggestionKey: string | null | undefined,
): string | null {
  if (typeof suggestionKey !== 'string' || suggestionKey.length === 0) {
    return null;
  }

  const delimiterIndex = suggestionKey.indexOf(':');

  if (delimiterIndex < 0 || delimiterIndex === suggestionKey.length - 1) {
    return suggestionKey;
  }

  return suggestionKey.slice(delimiterIndex + 1);
}

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
