import { describe, expect, it } from 'vitest';

import { FEATURE_FLAG_CONFIG } from '../config';
import { FeatureFlag } from '../types';

describe('feature flags', () => {
  it('defines the independently reversible Sessions rollout flags', () => {
    expect(FeatureFlag).toEqual({
      SessionsData: 'sessions_data',
      SessionsUi: 'sessions_ui',
      SessionsComms: 'sessions_comms',
    });
    expect(FEATURE_FLAG_CONFIG).toEqual(
      expect.objectContaining({
        sessions_data: expect.objectContaining({ defaultValue: false }),
        sessions_ui: expect.objectContaining({ defaultValue: false }),
        sessions_comms: expect.objectContaining({ defaultValue: false }),
      }),
    );
  });
});
