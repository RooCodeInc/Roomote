import { SETUP_STEPS, getSetupSteps } from './types';

describe('getSetupSteps', () => {
  it('returns the canonical step order regardless of the auth mode', () => {
    expect(getSetupSteps(false)).toBe(SETUP_STEPS);
    expect(getSetupSteps(true)).toBe(SETUP_STEPS);
    expect(SETUP_STEPS).toEqual(['welcome', 'inference', 'env-vars']);
  });

  it('orders inference before provider configuration', () => {
    expect(SETUP_STEPS.indexOf('inference')).toBe(
      SETUP_STEPS.indexOf('env-vars') - 1,
    );
  });
});
