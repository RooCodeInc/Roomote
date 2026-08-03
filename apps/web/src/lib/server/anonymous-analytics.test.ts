import {
  ANONYMOUS_ANALYTICS_METADATA_KEY,
  isAnonymousAnalyticsEnabledFromMetadata,
} from './anonymous-analytics';

describe('isAnonymousAnalyticsEnabledFromMetadata', () => {
  it('defaults to enabled when metadata is absent', () => {
    expect(isAnonymousAnalyticsEnabledFromMetadata(undefined)).toBe(true);
    expect(isAnonymousAnalyticsEnabledFromMetadata({})).toBe(true);
  });

  it('honors an explicit opt-out outside Roomote Cloud', () => {
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

  it('stays enabled in Roomote Cloud', () => {
    expect(
      isAnonymousAnalyticsEnabledFromMetadata(
        { [ANONYMOUS_ANALYTICS_METADATA_KEY]: false },
        true,
      ),
    ).toBe(true);
  });
});
