import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verify Linear webhook signature.
 *
 * Linear signs webhooks using HMAC-SHA256 with the webhook secret.
 * The signature is sent in the `Linear-Signature` header.
 *
 * @param rawBody - Raw request body as string or Buffer
 * @param signature - The signature from the Linear-Signature header
 * @param secret - The webhook secret configured in Linear
 * @returns boolean indicating if the signature is valid
 */
export function verifyLinearWebhookSignature(
  rawBody: string | Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!signature || !secret) {
    console.warn('[verifyLinearWebhookSignature] Missing signature or secret');
    return false;
  }

  try {
    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString();

    // Linear uses HMAC-SHA256
    const hmac = createHmac('sha256', secret);
    hmac.update(body);
    const expectedSignature = hmac.digest('hex');

    // Use timing-safe comparison to prevent timing attacks
    const signatureBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (signatureBuffer.length !== expectedBuffer.length) {
      console.warn('[verifyLinearWebhookSignature] Signature length mismatch');
      return false;
    }

    const isValid = timingSafeEqual(signatureBuffer, expectedBuffer);

    if (!isValid) {
      console.warn('[verifyLinearWebhookSignature] Signature mismatch');
    }

    return isValid;
  } catch (error) {
    console.error(
      '[verifyLinearWebhookSignature] Error verifying signature:',
      error,
    );
    return false;
  }
}

/**
 * Extract and validate webhook timestamp to prevent replay attacks.
 *
 * @param timestamp - Webhook timestamp in milliseconds
 * @param maxAgeMs - Maximum allowed age of the webhook (default: 5 minutes)
 * @param maxFutureMs - Maximum allowed future drift for clock skew (default: 60 seconds)
 * @returns boolean indicating if the timestamp is within acceptable range
 */
export function isWebhookTimestampValid(
  timestamp: number,
  maxAgeMs: number = 5 * 60 * 1000,
  maxFutureMs: number = 60 * 1000, // Allow 60 seconds of future drift for clock skew
): boolean {
  const now = Date.now();
  const age = now - timestamp;

  // Allow small amount of future drift to handle clock skew
  if (age < -maxFutureMs) {
    console.warn(
      `[isWebhookTimestampValid] Webhook timestamp is too far in the future: ${-age}ms > ${maxFutureMs}ms`,
    );
    return false;
  }

  if (age > maxAgeMs) {
    console.warn(
      `[isWebhookTimestampValid] Webhook timestamp is too old: ${age}ms > ${maxAgeMs}ms`,
    );
    return false;
  }

  return true;
}
