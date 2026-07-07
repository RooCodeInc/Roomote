interface ShouldSteerQueuedMessageOnEnterParams {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  prompt: string;
  hasEnabledSubmitButton: boolean;
  hasClient: boolean;
  readOnly: boolean;
  canSteerQueuedMessages: boolean;
  queuedMessagesCount: number;
  steeringInFlight: boolean;
}

/**
 * Determines whether pressing Enter in the prompt textarea should steer the
 * oldest queued message instead of submitting the current prompt.
 */
export function shouldSteerQueuedMessageOnEnter({
  key,
  shiftKey,
  metaKey,
  ctrlKey,
  altKey,
  isComposing,
  prompt,
  hasEnabledSubmitButton,
  hasClient,
  readOnly,
  canSteerQueuedMessages,
  queuedMessagesCount,
  steeringInFlight,
}: ShouldSteerQueuedMessageOnEnterParams): boolean {
  if (key !== 'Enter') {
    return false;
  }

  if (shiftKey || metaKey || ctrlKey || altKey || isComposing) {
    return false;
  }

  if (prompt.trim().length > 0) {
    return false;
  }

  if (hasEnabledSubmitButton) {
    return false;
  }

  if (!hasClient || readOnly || !canSteerQueuedMessages) {
    return false;
  }

  if (queuedMessagesCount === 0 || steeringInFlight) {
    return false;
  }

  return true;
}
