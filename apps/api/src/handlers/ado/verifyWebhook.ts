import { timingSafeEqual } from 'node:crypto';

type VerifyAdoWebhookParams = {
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

function extractBasicAuthPassword(
  authorizationHeader: string | undefined,
): string | null {
  const trimmed = authorizationHeader?.trim();

  if (!trimmed?.toLowerCase().startsWith('basic ')) {
    return null;
  }

  try {
    const decoded = Buffer.from(trimmed.slice('basic '.length), 'base64')
      .toString('utf8')
      .trim();
    const separatorIndex = decoded.indexOf(':');

    if (separatorIndex < 0) {
      return null;
    }

    return decoded.slice(separatorIndex + 1);
  } catch {
    return null;
  }
}

export function verifyAdoWebhook({
  headers,
  secretToken,
}: VerifyAdoWebhookParams): boolean {
  const trimmedSecretToken = secretToken?.trim();

  if (!trimmedSecretToken) {
    return false;
  }

  const headerSecret = headers['x-roomote-webhook-secret']?.trim();

  if (headerSecret && safeEqual(headerSecret, trimmedSecretToken)) {
    return true;
  }

  const basicAuthPassword = extractBasicAuthPassword(headers.authorization);

  return Boolean(
    basicAuthPassword && safeEqual(basicAuthPassword, trimmedSecretToken),
  );
}
