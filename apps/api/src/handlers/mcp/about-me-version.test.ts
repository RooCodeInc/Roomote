import { describe, expect, it } from 'vitest';

import { resolveAboutMeVersion } from './about-me-version';

describe('resolveAboutMeVersion', () => {
  it('formats the product version with a leading v', () => {
    expect(resolveAboutMeVersion('0.40.0', 'main-abc1234')).toBe('v0.40.0');
    expect(resolveAboutMeVersion(' v0.40.0 ', undefined)).toBe('v0.40.0');
  });

  it('falls back to the first available stable version', () => {
    expect(resolveAboutMeVersion(undefined, '0.40.0')).toBe('v0.40.0');
    expect(resolveAboutMeVersion(undefined, 'main-abc1234', '0.40.0')).toBe(
      'v0.40.0',
    );
  });

  it('omits unavailable and channel-only versions', () => {
    expect(resolveAboutMeVersion(undefined, undefined)).toBeUndefined();
    expect(resolveAboutMeVersion(undefined, 'main-abc1234')).toBeUndefined();
  });
});
