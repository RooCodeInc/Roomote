import {
  CURATED_INTEGRATIONS_DISABLED_MESSAGE,
  assertCuratedIntegrationsEnabled,
} from './curated-integrations';

describe('assertCuratedIntegrationsEnabled', () => {
  it('allows the default and enabled values', () => {
    expect(() => assertCuratedIntegrationsEnabled(undefined)).not.toThrow();
    expect(() => assertCuratedIntegrationsEnabled(true)).not.toThrow();
  });

  it('rejects operator-disabled integrations', () => {
    expect(() => assertCuratedIntegrationsEnabled(false)).toThrow(
      CURATED_INTEGRATIONS_DISABLED_MESSAGE,
    );
  });
});
