import { describe, expect, it } from 'vitest';

import { DEPLOYMENT_METADATA_BOOLEAN_CONFIG } from '../config';

describe('deployment metadata config', () => {
  it('retains active metadata descriptors', () => {
    expect(Object.keys(DEPLOYMENT_METADATA_BOOLEAN_CONFIG).sort()).toEqual([
      'anonymous_analytics_enabled',
      'deployment_disabled',
      'opencode_code_mode',
    ]);
    expect(DEPLOYMENT_METADATA_BOOLEAN_CONFIG.opencode_code_mode?.kind).toBe(
      'experimental',
    );
  });
});
