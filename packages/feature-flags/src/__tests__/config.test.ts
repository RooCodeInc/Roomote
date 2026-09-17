import { describe, expect, it } from 'vitest';

import { DEPLOYMENT_METADATA_BOOLEAN_CONFIG } from '../config';

describe('deployment metadata config', () => {
  it('retains the deployment-control metadata descriptors', () => {
    expect(Object.keys(DEPLOYMENT_METADATA_BOOLEAN_CONFIG).sort()).toEqual([
      'anonymous_analytics_enabled',
      'deployment_disabled',
      'home_composer_suggestions_enabled',
      'integration_keys_enabled',
      'private_sessions_experiment_enabled',
      'results_page_enabled',
      'slack_peer_conversations_experiment_enabled',
    ]);
    for (const descriptor of Object.values(
      DEPLOYMENT_METADATA_BOOLEAN_CONFIG,
    )) {
      expect(descriptor.kind).toBe('deployment-control');
    }
  });
});
