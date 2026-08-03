import {
  CURATED_INTEGRATIONS_DISABLED_MESSAGE,
  assertCuratedIntegrationsEnabled,
} from './curated-integrations';

describe('assertCuratedIntegrationsEnabled', () => {
  it('allows explicitly enabled values', () => {
    expect(() => assertCuratedIntegrationsEnabled(true)).not.toThrow();
    expect(() => assertCuratedIntegrationsEnabled('true')).not.toThrow();
  });

  it('rejects the default and disabled values', () => {
    expect(() => assertCuratedIntegrationsEnabled(undefined)).toThrow(
      CURATED_INTEGRATIONS_DISABLED_MESSAGE,
    );
    expect(() => assertCuratedIntegrationsEnabled(false)).toThrow(
      CURATED_INTEGRATIONS_DISABLED_MESSAGE,
    );
  });
});
