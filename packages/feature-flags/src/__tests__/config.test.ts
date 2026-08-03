import { describe, expect, it } from 'vitest';

import { FEATURE_FLAG_CONFIG } from '../config';
import { FeatureFlag } from '../types';

describe('feature flags', () => {
  it('defines zero recognized flags and zero config entries', () => {
    expect(FeatureFlag).toEqual({});
    expect(FEATURE_FLAG_CONFIG).toEqual({});
  });
});
