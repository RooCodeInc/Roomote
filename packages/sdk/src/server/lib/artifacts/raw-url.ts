import { createHmac, timingSafeEqual } from 'node:crypto';

/** Signed raw URLs fail closed after this many seconds from `ts`. */
export const ARTIFACT_RAW_URL_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Allow small positive clock skew when checking `ts`. */
export const ARTIFACT_RAW_URL_CLOCK_SKEW_SECONDS = 60;

function signWithKey(key: string, artifactId: string, ts: number): string {
  const hmac = createHmac('sha256', key);
  hmac.update(`${artifactId}.${ts}`);
  return hmac.digest('hex');
}

export function signArtifactIdWithKey(input: {
  artifactId: string;
  ts: number;
  signingKey: string;
}): string {
  return signWithKey(input.signingKey, input.artifactId, input.ts);
}

function signaturesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function isArtifactSignatureTimestampValid(input: {
  ts: number;
  nowSeconds?: number;
  maxAgeSeconds?: number;
  clockSkewSeconds?: number;
}): boolean {
  if (!Number.isFinite(input.ts) || input.ts <= 0) {
    return false;
  }

  const nowSeconds = input.nowSeconds ?? currentEpochSeconds();
  const maxAgeSeconds = input.maxAgeSeconds ?? ARTIFACT_RAW_URL_MAX_AGE_SECONDS;
  const clockSkewSeconds =
    input.clockSkewSeconds ?? ARTIFACT_RAW_URL_CLOCK_SKEW_SECONDS;

  if (input.ts > nowSeconds + clockSkewSeconds) {
    return false;
  }

  return nowSeconds - input.ts <= maxAgeSeconds;
}

export function verifyArtifactSignatureWithKeys(input: {
  artifactId: string;
  signature: string;
  ts: number;
  currentSigningKey: string;
  previousSigningKey?: string;
  nowSeconds?: number;
  maxAgeSeconds?: number;
  clockSkewSeconds?: number;
}): boolean {
  if (
    !isArtifactSignatureTimestampValid({
      ts: input.ts,
      nowSeconds: input.nowSeconds,
      maxAgeSeconds: input.maxAgeSeconds,
      clockSkewSeconds: input.clockSkewSeconds,
    })
  ) {
    return false;
  }

  const expected = signWithKey(
    input.currentSigningKey,
    input.artifactId,
    input.ts,
  );

  if (signaturesMatch(expected, input.signature)) {
    return true;
  }

  if (!input.previousSigningKey) {
    return false;
  }

  const expectedPrevious = signWithKey(
    input.previousSigningKey,
    input.artifactId,
    input.ts,
  );

  return signaturesMatch(expectedPrevious, input.signature);
}

export function buildSignedArtifactRawUrl(input: {
  artifactId: string;
  ts: number;
  apiBaseUrl: string;
  signingKey: string;
}): string {
  const signature = signWithKey(input.signingKey, input.artifactId, input.ts);
  let end = input.apiBaseUrl.length;
  while (end > 0 && input.apiBaseUrl.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  const normalizedBaseUrl = input.apiBaseUrl.slice(0, end);

  return `${normalizedBaseUrl}/api/artifacts/${input.artifactId}/raw?sig=${signature}&ts=${input.ts}`;
}

export function currentEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
