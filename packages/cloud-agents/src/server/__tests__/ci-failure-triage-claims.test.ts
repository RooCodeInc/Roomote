import { describe, expect, it } from 'vitest';

import {
  buildCiFailureTriageClaimKey,
  buildCiFailureTriageFingerprint,
} from '../ci-failure-triage-claims';

describe('ci-failure-triage-claims', () => {
  it('builds a stable fingerprint and claim key', () => {
    const fingerprint = buildCiFailureTriageFingerprint({
      repositoryFullName: 'Acme/API',
      workflowName: ' CI ',
      headBranch: 'Main',
    });

    expect(fingerprint).toBe('acme/api::ci::main');
    expect(buildCiFailureTriageClaimKey(fingerprint)).toBe(
      'github:ci-failure-triage:active:acme/api::ci::main',
    );
  });
});
