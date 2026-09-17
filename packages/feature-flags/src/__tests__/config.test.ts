import { describe, expect, it } from 'vitest';

import { DEPLOYMENT_METADATA_BOOLEAN_CONFIG } from '../config';

describe('deployment metadata config', () => {
  it('retains the deployment-control metadata descriptors', () => {
    expect(Object.keys(DEPLOYMENT_METADATA_BOOLEAN_CONFIG).sort()).toEqual([
      'anonymous_analytics_enabled',
      'deployment_disabled',
      'private_sessions_experiment_enabled',
    ]);
    for (const descriptor of Object.values(
      DEPLOYMENT_METADATA_BOOLEAN_CONFIG,
    )) {
      expect(descriptor.kind).toBe('deployment-control');
    }
  });
});
