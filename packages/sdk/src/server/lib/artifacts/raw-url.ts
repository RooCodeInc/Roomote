import { createHmac, timingSafeEqual } from 'node:crypto';

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

export function verifyArtifactSignatureWithKeys(input: {
  artifactId: string;
  signature: string;
  ts: number;
  currentSigningKey: string;
  previousSigningKey?: string;
}): boolean {
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
  const normalizedBaseUrl = input.apiBaseUrl.replace(/\/+$/, '');

  return `${normalizedBaseUrl}/api/artifacts/${input.artifactId}/raw?sig=${signature}&ts=${input.ts}`;
}

export function currentEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
