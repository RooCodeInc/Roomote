import { describe, expect, it } from 'vitest';

import { getBooleanMetadataDescriptorByKey } from '../index';

describe('metadata descriptions', () => {
  it.each([
    'slack_eval_launcher',
    'show_debug_ui_setting',
    'show_debug_ui',
    'suggestion_routing',
    'visual_proof_auto_screencast',
    'background_subagents',
    'opencode_background_subagents',
    'opencode_code_mode',
  ])('classifies removed experiment metadata %s as legacy', (key) => {
    expect(getBooleanMetadataDescriptorByKey(key)).toEqual({
      kind: 'legacy',
      description: null,
      group: null,
    });
  });

  it('retains active deployment-control descriptors', () => {
    expect(getBooleanMetadataDescriptorByKey('deployment_disabled').kind).toBe(
      'deployment-control',
    );
    expect(
      getBooleanMetadataDescriptorByKey('anonymous_analytics_enabled').kind,
    ).toBe('deployment-control');
  });
});
