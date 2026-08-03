import { describe, expect, it } from 'vitest';

import {
  ANONYMOUS_ANALYTICS_METADATA_KEY,
  isAnonymousAnalyticsEnabledFromMetadata,
} from '../index';

describe('isAnonymousAnalyticsEnabledFromMetadata', () => {
  it('defaults to enabled when the key is absent', () => {
    expect(isAnonymousAnalyticsEnabledFromMetadata(undefined)).toBe(true);
    expect(isAnonymousAnalyticsEnabledFromMetadata({})).toBe(true);
  });

  it('respects explicit values', () => {
    expect(
      isAnonymousAnalyticsEnabledFromMetadata({
        [ANONYMOUS_ANALYTICS_METADATA_KEY]: false,
      }),
    ).toBe(false);
    expect(
      isAnonymousAnalyticsEnabledFromMetadata({
        [ANONYMOUS_ANALYTICS_METADATA_KEY]: 'true',
      }),
    ).toBe(true);
  });

  it('forces analytics enabled for Roomote Cloud', () => {
    expect(
      isAnonymousAnalyticsEnabledFromMetadata(
        { [ANONYMOUS_ANALYTICS_METADATA_KEY]: false },
        true,
      ),
    ).toBe(true);
  });
});
