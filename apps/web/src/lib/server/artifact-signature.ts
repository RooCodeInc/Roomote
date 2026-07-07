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
 * The signature covers `artifactId.ts` so that a future expiration check
 * can be added without regenerating URLs.
 */
export function signArtifactId(artifactId: string, ts: number): string {
  return signArtifactIdWithKey({
    artifactId,
    ts,
    signingKey: getArtifactSigningKey(),
  });
}

/**
 * Verify an HMAC signature for an artifact ID + timestamp.
 *
 * Tries the current ARTIFACT_SIGNING_KEY first. If ARTIFACT_SIGNING_KEY_PREVIOUS
 * is set, falls back to verifying with the previous key to support graceful
 * key rotation.
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
