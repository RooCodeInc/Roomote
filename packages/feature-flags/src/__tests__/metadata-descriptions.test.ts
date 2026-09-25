import { describe, expect, it } from 'vitest';

import {
  DEPLOYMENT_EXPERIMENT_AUDIENCE,
  DEPLOYMENT_EXPERIMENT_AUDIENCES,
  DEPLOYMENT_EXPERIMENT_IDS,
  getBooleanMetadataDescriptorByKey,
  getDeploymentExperimentAudience,
  getDeploymentExperimentIdsForAudience,
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
    'code_mode_integrations_experiment_enabled',
    'integration_tool_approvals_experiment_enabled',
    'results_page_enabled',
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
    expect(
      getBooleanMetadataDescriptorByKey(
        'automation_launch_criteria_experiment_enabled',
      ).kind,
    ).toBe('deployment-control');
  });

  it('enables deployment experiments only from explicit true metadata', () => {
    expect(
      getDeploymentExperimentValues(undefined).automationLaunchCriteria,
    ).toBe(false);
    expect(
      getDeploymentExperimentValues({
        results_page_enabled: true,
        private_sessions_experiment_enabled: true,
        automation_launch_criteria_experiment_enabled: true,
        integration_keys_enabled: 'true',
      }),
    ).toEqual({
      privateSessions: true,
      browserNotifications: false,
      integrationToolAutoApprovals: false,
      sessionTaskCommunicationTriage: false,
      automationLaunchCriteria: true,
      dizzy: false,
    });
  });

  it('requires an explicit supported audience for every experiment', () => {
    expect(Object.keys(DEPLOYMENT_EXPERIMENT_AUDIENCE).sort()).toEqual(
      [...DEPLOYMENT_EXPERIMENT_IDS].sort(),
    );
    expect(
      Object.values(DEPLOYMENT_EXPERIMENT_AUDIENCE).every((audience) =>
        DEPLOYMENT_EXPERIMENT_AUDIENCES.includes(audience),
      ),
    ).toBe(true);
    expect(getDeploymentExperimentAudience('unclassifiedFeature')).toBe(
      undefined,
    );
    expect(getDeploymentExperimentAudience('automationLaunchCriteria')).toBe(
      'internal-nightly',
    );
    expect(getDeploymentExperimentIdsForAudience('internal-nightly')).toEqual([
      'integrationToolAutoApprovals',
      'dizzy',
      'automationLaunchCriteria',
    ]);
  });
});
