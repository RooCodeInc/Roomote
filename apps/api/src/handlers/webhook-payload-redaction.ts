/**
 * Redaction for stored webhook payloads.
 *
 * Webhook rows in the `webhooks` table keep the full provider payload for
 * auditing and debugging. Payloads can carry secret material (hook configs
 * include the shared webhook secret, and some providers echo tokens back in
 * the body), so clearly sensitive fields are masked before the payload is
 * persisted. The redaction only affects the stored copy -- handlers receive
 * the original payload. Retention is bounded separately by the WebhookCleanup
 * scheduled job (see apps/bullmq).
 *
 * Redaction is key-based and intentionally conservative: it only masks keys
 * that unambiguously hold credentials. Free-text fields (comment bodies, PR
 * descriptions) are kept as-is because debugging depends on them.
 */

import { secretRedactor } from '@roomote/types';

const REDACTED_VALUE = '[REDACTED]';

/**
 * Credential-bearing key names, compared against keys normalized to
 * lowercase alphanumerics so snake_case, camelCase, and kebab-case variants
 * all match (e.g. `client_secret`, `clientSecret`, `client-secret`).
 */
export function isSensitiveWebhookPayloadKey(key: string): boolean {
  return secretRedactor.isSensitiveKey(key, 'webhook');
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }

  if (value !== null && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
      redacted[key] =
        isSensitiveWebhookPayloadKey(key) && entry !== null
          ? REDACTED_VALUE
          : redactValue(entry);
    }

    return redacted;
  }

  return value;
}

/**
 * Returns a deep copy of the payload with clearly sensitive fields replaced
 * by `[REDACTED]`. Non-object payloads are returned unchanged.
 */
export function redactWebhookPayload<T>(payload: T): T {
  return redactValue(payload) as T;
}
