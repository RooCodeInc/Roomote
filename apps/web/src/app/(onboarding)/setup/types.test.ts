import { SETUP_STEPS, getSetupSteps } from './types';

describe('getSetupSteps', () => {
  it('derives email/password ordering without changing the canonical step set', () => {
    const emailPasswordSteps = getSetupSteps(false);

    expect(emailPasswordSteps).toHaveLength(SETUP_STEPS.length);
    expect(new Set(emailPasswordSteps)).toEqual(new Set(SETUP_STEPS));
    expect(emailPasswordSteps).toEqual([
      'welcome',
      'inference',
      'env-vars',
      'source-control-provider',
      'source-control-config',
      'source-control-connect',
      'auth-provider',
      'auth-env-vars',
      'slack',
      'automation-recommendations',
      'compute-provider',
      'compute-config',
      'invoke',
    ]);
  });

  it('uses the canonical order when communication handled authentication', () => {
    expect(getSetupSteps(true)).toBe(SETUP_STEPS);
    expect(SETUP_STEPS.indexOf('inference')).toBe(
      SETUP_STEPS.indexOf('env-vars') - 1,
    );
  });
});
