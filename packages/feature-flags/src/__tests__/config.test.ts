import { describe, expect, it } from 'vitest';

import {
  DEPLOYMENT_METADATA_BOOLEAN_CONFIG,
  FEATURE_FLAG_CONFIG,
} from '../config';
import { FeatureFlag } from '../types';

describe('feature flags', () => {
  it('defines the composer suggestions opt-in as the only active flag', () => {
    expect(Object.values(FeatureFlag)).toEqual(['composerSuggestions']);
    expect(Object.keys(FEATURE_FLAG_CONFIG)).toEqual(['composerSuggestions']);
    expect(FEATURE_FLAG_CONFIG.composerSuggestions.defaultValue).toBe(false);
  });

  it('retains the deployment-control metadata descriptors', () => {
    expect(Object.keys(DEPLOYMENT_METADATA_BOOLEAN_CONFIG).sort()).toEqual([
      'anonymous_analytics_enabled',
      'deployment_disabled',
    ]);
    for (const descriptor of Object.values(
      DEPLOYMENT_METADATA_BOOLEAN_CONFIG,
    )) {
      expect(descriptor.kind).toBe('deployment-control');
    }
  });
});
