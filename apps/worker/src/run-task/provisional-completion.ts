const TRANSIENT_ASSISTANT_MESSAGE_PATTERN = /^(provider error|retrying)\b/i;

export function isEligibleProvisionalCompletionText(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 && !TRANSIENT_ASSISTANT_MESSAGE_PATTERN.test(trimmed)
  );
}
