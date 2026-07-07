import { createHmac, timingSafeEqual } from 'node:crypto';

type SlackVerificationResult =
  | {
      isValid: true;
      error?: undefined;
    }
  | {
      isValid: false;
      error: string;
    };

export function verifySlackRequest(
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  rawBody: string,
  signingSecret: string,
): SlackVerificationResult {
  if (!signatureHeader) {
    return { isValid: false, error: 'Missing X-Slack-Signature header' };
  }

  const signatureStr = signatureHeader.slice(3);

  if (!signatureHeader.startsWith('v0=') || !signatureStr) {
    return { isValid: false, error: 'Invalid signature format' };
  }

  const providedSignature = Buffer.from(signatureStr, 'hex');

  if (!timestampHeader) {
    return {
      isValid: false,
      error: 'Missing X-Slack-Request-Timestamp header',
    };
  }

  const requestTime = parseInt(timestampHeader, 10);

  if (isNaN(requestTime)) {
    return { isValid: false, error: 'Invalid timestamp format' };
  }

  const currentTime = Math.floor(Date.now() / 1000);
  const timeDifference = Math.abs(currentTime - requestTime);

  if (timeDifference > 300) {
    return {
      isValid: false,
      error: `Request timestamp too old: ${timeDifference}s (max 300s)`,
    };
  }

  const basestring = `v0:${timestampHeader}:${rawBody}`;

  const expectedSignature = createHmac('sha256', signingSecret)
    .update(basestring, 'utf8')
    .digest();

  if (expectedSignature.length !== providedSignature.length) {
    return { isValid: false, error: 'Signature length mismatch' };
  }

  const isValid = timingSafeEqual(expectedSignature, providedSignature);

  if (!isValid) {
    return { isValid: false, error: 'Signature verification failed' };
  }

  return { isValid: true };
}
