import { describe, expect, it } from 'vitest';

import {
  getBooleanMetadataDescriptorByKey,
  getDeploymentExperimentValues,
} from '../index';

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
    'composerSuggestions',
    'integration_keys_enabled',
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
    expect(getBooleanMetadataDescriptorByKey('results_page_enabled').kind).toBe(
      'deployment-control',
    );
  });

  it('enables deployment experiments only from explicit true metadata', () => {
    expect(
      getDeploymentExperimentValues({
        results_page_enabled: true,
        integration_keys_enabled: 'true',
      }),
    ).toEqual({
      results: true,
      slackPeerConversations: false,
      privateSessions: false,
      browserNotifications: false,
      toolApprovals: false,
    });
  });
});
