import {
  currentEpochSeconds,
  signArtifactIdWithKey,
  verifyArtifactSignatureWithKeys,
} from '@roomote/sdk/server';
import {
  getArtifactSigningKey,
  getArtifactSigningKeyPrevious,
} from '@/lib/server/env';

export { currentEpochSeconds };

/**
 * Generate an HMAC-SHA256 signature for an artifact ID bound to a timestamp.
 * Uses ARTIFACT_SIGNING_KEY (dedicated to this purpose, no prefix needed).
 *
 * The signature covers `artifactId.ts`. Verification rejects timestamps older
 * than ARTIFACT_RAW_URL_MAX_AGE_SECONDS (default 30 days) so leaked raw URLs
 * fail closed after the TTL.
 */
export function signArtifactId(artifactId: string, ts: number): string {
  return signArtifactIdWithKey({
    artifactId,
    ts,
    signingKey: getArtifactSigningKey(),
  });
}

/**
 * Verify an HMAC signature for an artifact ID + timestamp and enforce max age.
 *
 * Tries the current ARTIFACT_SIGNING_KEY first. If ARTIFACT_SIGNING_KEY_PREVIOUS
 * is set, falls back to verifying with the previous key to support graceful
 * key rotation. Expired `ts` values are rejected even when the HMAC matches.
 */
export function verifyArtifactSignature(
  artifactId: string,
  signature: string,
  ts: number,
): boolean {
  return verifyArtifactSignatureWithKeys({
    artifactId,
    signature,
    ts,
    currentSigningKey: getArtifactSigningKey(),
    previousSigningKey: getArtifactSigningKeyPrevious(),
  });
}
