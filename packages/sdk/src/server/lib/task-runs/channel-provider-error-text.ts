import { redactSecrets } from '@roomote/communication/redact-secrets';

const CHANNEL_PROVIDER_ERROR_MAX_CHARS = 300;
const CHANNEL_PROVIDER_ERROR_PATTERN =
  /^The provider returned an error(?: \([A-Za-z][A-Za-z0-9_-]*\))?: .+$/;
const UNSAFE_CHANNEL_ERROR_PATTERN =
  /\r|\n|https?:\/\/|\b(?:api[_ -]?key|token|authorization|password|secret)\s*(?:=|:)\s*\S+|\bBearer\s+\S+|\b(?:stack|traceback)\b/i;

/**
 * Gate arbitrary run/turn error text down to the narrow shape that is safe to
 * echo into a customer chat surface: a single-line "The provider returned an
 * error: ..." summary, short enough to read inline, with no URLs, credentials,
 * or stack traces. Anything else is dropped so the chat message falls back to
 * generic copy while the full text stays in the task transcript and run row.
 *
 * Shared by terminal run failures (`finishRun`) and per-turn provider errors
 * so both surfaces apply exactly the same redaction rules.
 */
export function formatChannelProviderError(
  error?: string | null,
): string | undefined {
  const message = error?.trim();

  if (
    !message ||
    message.length > CHANNEL_PROVIDER_ERROR_MAX_CHARS ||
    !CHANNEL_PROVIDER_ERROR_PATTERN.test(message) ||
    UNSAFE_CHANNEL_ERROR_PATTERN.test(message)
  ) {
    return undefined;
  }

  return redactSecrets(message);
}

export function escapeSlackMrkdwnText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
