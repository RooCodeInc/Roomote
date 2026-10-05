import {
  getBooleanMetadataDescriptorByKey,
  getDeploymentExperimentAudience,
  getDeploymentExperimentIdsForAudience,
  getDeploymentExperimentValues,
} from '../index';

describe('Auto tool approvals nightly experiment metadata', () => {
  it('ignores legacy customer-preview opt-ins and defaults the new nightly key off', () => {
    expect(
      getDeploymentExperimentValues({
        integration_tool_auto_approvals_experiment_enabled: true,
      }).integrationToolAutoApprovals,
    ).toBe(false);
    expect(
      getDeploymentExperimentValues({
        integration_tool_auto_approvals_nightly_experiment_enabled: true,
      }).integrationToolAutoApprovals,
    ).toBe(true);
    expect(
      getBooleanMetadataDescriptorByKey(
        'integration_tool_auto_approvals_experiment_enabled',
      ).kind,
    ).toBe('legacy');
  });

  it('classifies Auto tool approvals as an internal-nightly experiment', () => {
    expect(
      getDeploymentExperimentAudience('integrationToolAutoApprovals'),
    ).toBe('internal-nightly');
    expect(getDeploymentExperimentIdsForAudience('internal-nightly')).toContain(
      'integrationToolAutoApprovals',
    );
  });
});
