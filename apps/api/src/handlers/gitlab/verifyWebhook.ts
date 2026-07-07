import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

type VerifyGitLabWebhookParams = {
  body: string;
  headers: Record<string, string | undefined>;
  now?: Date;
  secretToken?: string;
  signingToken?: string;
};

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function verifySigningToken({
  body,
  headers,
  now = new Date(),
  signingToken,
}: VerifyGitLabWebhookParams & { signingToken: string }): boolean {
  const messageId = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signature = headers['webhook-signature'];

  if (!messageId || !timestamp || !signature) {
    return false;
  }

  const timestampSeconds = Number(timestamp);

  if (
    !Number.isFinite(timestampSeconds) ||
    Math.abs(now.getTime() / 1000 - timestampSeconds) >
      SIGNATURE_TOLERANCE_SECONDS
  ) {
    return false;
  }

  const rawKey = Buffer.from(signingToken.replace(/^whsec_/, ''), 'base64');

  if (rawKey.length === 0) {
    return false;
  }

  const expected = `v1,${createHmac('sha256', rawKey)
    .update(`${messageId}.${timestamp}.${body}`)
    .digest('base64')}`;

  return signature
    .split(/\s+/)
    .some((candidate) => safeEqual(candidate, expected));
}

export function verifyGitLabWebhook({
  body,
  headers,
  now,
  secretToken,
  signingToken,
}: VerifyGitLabWebhookParams): boolean {
  const trimmedSigningToken = signingToken?.trim();
  const receivedSignature = headers['webhook-signature'];

  if (trimmedSigningToken && receivedSignature) {
    return verifySigningToken({
      body,
      headers,
      now,
      signingToken: trimmedSigningToken,
    });
  }

  const trimmedSecretToken = secretToken?.trim();

  if (!trimmedSecretToken) {
    return false;
  }

  return safeEqual(headers['x-gitlab-token'] ?? '', trimmedSecretToken);
}
