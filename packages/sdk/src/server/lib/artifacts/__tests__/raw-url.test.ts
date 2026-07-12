import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_RAW_URL_MAX_AGE_SECONDS,
  buildSignedArtifactRawUrl,
  isArtifactSignatureTimestampValid,
  signArtifactIdWithKey,
  verifyArtifactSignatureWithKeys,
} from '../raw-url';

const CURRENT_KEY = 'current-artifact-signing-key-32chars!!';
const PREVIOUS_KEY = 'previous-artifact-signing-key-32chars!';
const ARTIFACT_ID = 'art_test_123';

describe('artifact raw URL signatures', () => {
  const nowSeconds = 1_700_000_000;

  it('accepts a fresh signature signed with the current key', () => {
    const ts = nowSeconds - 60;
    const signature = signArtifactIdWithKey({
      artifactId: ARTIFACT_ID,
      ts,
      signingKey: CURRENT_KEY,
    });

    expect(
      verifyArtifactSignatureWithKeys({
        artifactId: ARTIFACT_ID,
        signature,
        ts,
        currentSigningKey: CURRENT_KEY,
        previousSigningKey: PREVIOUS_KEY,
        nowSeconds,
      }),
    ).toBe(true);
  });

  it('accepts a fresh signature signed with the previous key during rotation', () => {
    const ts = nowSeconds - 120;
    const signature = signArtifactIdWithKey({
      artifactId: ARTIFACT_ID,
      ts,
      signingKey: PREVIOUS_KEY,
    });

    expect(
      verifyArtifactSignatureWithKeys({
        artifactId: ARTIFACT_ID,
        signature,
        ts,
        currentSigningKey: CURRENT_KEY,
        previousSigningKey: PREVIOUS_KEY,
        nowSeconds,
      }),
    ).toBe(true);
  });

  it('rejects an expired timestamp even with a valid HMAC', () => {
    const ts = nowSeconds - ARTIFACT_RAW_URL_MAX_AGE_SECONDS - 1;
    const signature = signArtifactIdWithKey({
      artifactId: ARTIFACT_ID,
      ts,
      signingKey: CURRENT_KEY,
    });

    expect(
      verifyArtifactSignatureWithKeys({
        artifactId: ARTIFACT_ID,
        signature,
        ts,
        currentSigningKey: CURRENT_KEY,
        previousSigningKey: PREVIOUS_KEY,
        nowSeconds,
      }),
    ).toBe(false);
  });

  it('accepts a timestamp exactly at the max age boundary', () => {
    const ts = nowSeconds - ARTIFACT_RAW_URL_MAX_AGE_SECONDS;
    const signature = signArtifactIdWithKey({
      artifactId: ARTIFACT_ID,
      ts,
      signingKey: CURRENT_KEY,
    });

    expect(
      verifyArtifactSignatureWithKeys({
        artifactId: ARTIFACT_ID,
        signature,
        ts,
        currentSigningKey: CURRENT_KEY,
        previousSigningKey: PREVIOUS_KEY,
        nowSeconds,
      }),
    ).toBe(true);
  });

  it('rejects timestamps too far in the future', () => {
    const ts = nowSeconds + 61;
    expect(
      isArtifactSignatureTimestampValid({
        ts,
        nowSeconds,
      }),
    ).toBe(false);

    const signature = signArtifactIdWithKey({
      artifactId: ARTIFACT_ID,
      ts,
      signingKey: CURRENT_KEY,
    });
    expect(
      verifyArtifactSignatureWithKeys({
        artifactId: ARTIFACT_ID,
        signature,
        ts,
        currentSigningKey: CURRENT_KEY,
        nowSeconds,
      }),
    ).toBe(false);
  });

  it('rejects invalid signatures that do not match either key', () => {
    const ts = nowSeconds;
    expect(
      verifyArtifactSignatureWithKeys({
        artifactId: ARTIFACT_ID,
        signature: '0'.repeat(64),
        ts,
        currentSigningKey: CURRENT_KEY,
        previousSigningKey: PREVIOUS_KEY,
        nowSeconds,
      }),
    ).toBe(false);
  });

  it('builds a signed raw URL with sig and ts query params', () => {
    const ts = nowSeconds;
    const url = buildSignedArtifactRawUrl({
      artifactId: ARTIFACT_ID,
      ts,
      apiBaseUrl: 'https://example.com/',
      signingKey: CURRENT_KEY,
    });
    const signature = signArtifactIdWithKey({
      artifactId: ARTIFACT_ID,
      ts,
      signingKey: CURRENT_KEY,
    });

    expect(url).toBe(
      `https://example.com/api/artifacts/${ARTIFACT_ID}/raw?sig=${signature}&ts=${ts}`,
    );
  });
});
