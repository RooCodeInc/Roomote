import {
  createCritiqueSubmissionCapability,
  validateCritiqueSubmissionCapability,
} from './critique-capability';

describe('Critique submission capability', () => {
  it('binds a short-lived capability to one run token', () => {
    const expiresAtMs = Date.now() + 60_000;
    const capability = createCritiqueSubmissionCapability({
      runToken: 'run-token-1',
      expiresAtMs,
      signingKey: 'signing-key',
    });

    expect(
      validateCritiqueSubmissionCapability({
        capability,
        runToken: 'run-token-1',
        signingKeys: ['signing-key'],
      }),
    ).toBe(true);
    expect(
      validateCritiqueSubmissionCapability({
        capability,
        runToken: 'run-token-2',
        signingKeys: ['signing-key'],
      }),
    ).toBe(false);
    expect(
      validateCritiqueSubmissionCapability({
        capability,
        runToken: 'run-token-1',
        signingKeys: ['wrong-key'],
      }),
    ).toBe(false);
    expect(
      validateCritiqueSubmissionCapability({
        capability,
        runToken: 'run-token-1',
        signingKeys: ['signing-key'],
        nowMs: expiresAtMs,
      }),
    ).toBe(false);
  });
});
