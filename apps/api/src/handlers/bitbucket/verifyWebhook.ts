import { createHmac, timingSafeEqual } from 'node:crypto';

type VerifyBitbucketWebhookParams = {
  body: string;
  headers: Record<string, string | undefined>;
  secretToken?: string;
};

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function normalizeSignature(signature: string): string {
  const trimmed = signature.trim();
  return trimmed.toLowerCase().startsWith('sha256=')
    ? trimmed.slice('sha256='.length)
    : trimmed;
}

/**
 * Bitbucket Cloud HMAC-SHA256 verification.
 * Prefer `x-hub-signature-256` (`sha256=<hex>`), then bare hex on `x-hub-signature`.
 */
export function verifyBitbucketWebhook({
  body,
  headers,
  secretToken,
}: VerifyBitbucketWebhookParams): boolean {
  const trimmedSecretToken = secretToken?.trim();

  if (!trimmedSecretToken) {
    return false;
  }

  const expected = createHmac('sha256', trimmedSecretToken)
    .update(body)
    .digest('hex');

  const hubSignature256 = headers['x-hub-signature-256']?.trim();
  if (hubSignature256) {
    const expectedHubSignature = `sha256=${expected}`;
    if (
      safeEqual(hubSignature256, expectedHubSignature) ||
      safeEqual(normalizeSignature(hubSignature256), expected)
    ) {
      return true;
    }
  }

  const hubSignature = headers['x-hub-signature']?.trim();
  if (hubSignature && safeEqual(normalizeSignature(hubSignature), expected)) {
    return true;
  }

  return false;
}
