import { describe, expect, it } from 'vitest';

import {
  ANONYMOUS_ANALYTICS_METADATA_KEY,
  isAnonymousAnalyticsEnabledFromMetadata,
} from '../index';

describe('isAnonymousAnalyticsEnabledFromMetadata', () => {
  it('defaults to enabled when the key is absent (opt-out model)', () => {
    expect(isAnonymousAnalyticsEnabledFromMetadata({})).toBe(true);
    expect(isAnonymousAnalyticsEnabledFromMetadata(undefined)).toBe(true);
    expect(isAnonymousAnalyticsEnabledFromMetadata(null)).toBe(true);
    expect(isAnonymousAnalyticsEnabledFromMetadata({ other_key: false })).toBe(
      true,
    );
  });

  it('respects an explicit false', () => {
    expect(
      isAnonymousAnalyticsEnabledFromMetadata({
        [ANONYMOUS_ANALYTICS_METADATA_KEY]: false,
      }),
    ).toBe(false);
    expect(
      isAnonymousAnalyticsEnabledFromMetadata({
        [ANONYMOUS_ANALYTICS_METADATA_KEY]: 'false',
      }),
    ).toBe(false);
  });

  it('forces analytics enabled for Roomote Cloud', () => {
    expect(
      isAnonymousAnalyticsEnabledFromMetadata(
        { [ANONYMOUS_ANALYTICS_METADATA_KEY]: false },
        true,
      ),
    ).toBe(true);
  });

  it('respects an explicit true', () => {
    expect(
      isAnonymousAnalyticsEnabledFromMetadata({
        [ANONYMOUS_ANALYTICS_METADATA_KEY]: true,
      }),
    ).toBe(true);
    expect(
      isAnonymousAnalyticsEnabledFromMetadata({
        [ANONYMOUS_ANALYTICS_METADATA_KEY]: 'true',
      }),
    ).toBe(true);
  });

  it('treats malformed metadata as enabled', () => {
    expect(isAnonymousAnalyticsEnabledFromMetadata('garbage')).toBe(true);
    expect(isAnonymousAnalyticsEnabledFromMetadata([])).toBe(true);
  });
});
