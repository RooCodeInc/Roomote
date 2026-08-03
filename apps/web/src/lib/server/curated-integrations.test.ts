import {
  CURATED_INTEGRATIONS_DISABLED_MESSAGE,
  assertCuratedIntegrationsEnabled,
} from './curated-integrations';

describe('assertCuratedIntegrationsEnabled', () => {
  it('allows the default and non-disabled values', () => {
    expect(() => assertCuratedIntegrationsEnabled(undefined)).not.toThrow();
    expect(() => assertCuratedIntegrationsEnabled(false)).not.toThrow();
  });

  it('rejects operator-disabled integrations', () => {
    expect(() => assertCuratedIntegrationsEnabled(true)).toThrow(
      CURATED_INTEGRATIONS_DISABLED_MESSAGE,
    );
    expect(() => assertCuratedIntegrationsEnabled('true')).toThrow(
      CURATED_INTEGRATIONS_DISABLED_MESSAGE,
    );
  });
});
