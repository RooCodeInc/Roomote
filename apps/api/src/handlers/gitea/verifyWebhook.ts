import { createHmac, timingSafeEqual } from 'node:crypto';

type VerifyGiteaWebhookParams = {
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

export function verifyGiteaWebhook({
  body,
  headers,
  secretToken,
}: VerifyGiteaWebhookParams): boolean {
  const trimmedSecretToken = secretToken?.trim();

  if (!trimmedSecretToken) {
    return false;
  }

  const expected = createHmac('sha256', trimmedSecretToken)
    .update(body)
    .digest('hex');
  const giteaSignature = headers['x-gitea-signature']?.trim();

  if (giteaSignature && safeEqual(giteaSignature, expected)) {
    return true;
  }

  const hubSignature = headers['x-hub-signature-256']?.trim();
  const expectedHubSignature = `sha256=${expected}`;

  return Boolean(hubSignature && safeEqual(hubSignature, expectedHubSignature));
}
