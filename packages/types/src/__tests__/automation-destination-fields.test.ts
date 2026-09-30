import {
  getAutomationDestinationDescriptorById,
  getAutomationDestinationDescriptorByKey,
  getAutomationDestinationDescriptorBySlackField,
  isAutomationDestinationAutomationId,
} from '../automation-destination-fields';

describe('automation destination field registry', () => {
  it('looks up descriptors by settings id, automation key, and Slack field', () => {
    expect(
      getAutomationDestinationDescriptorById('managerStats'),
    ).toMatchObject({
      automationKey: 'manager_stats',
      slackField: 'managerStatsSlackChannel',
      discordField: 'managerStatsDiscordChannel',
      optionalDiscordInput: false,
      slackSettingsIncludesManagerFallback: true,
    });
    expect(
      getAutomationDestinationDescriptorByKey('platform_issue_alerts'),
    ).toMatchObject({
      automationId: 'platformIssueAlerts',
      optionalDiscordInput: true,
      slackSettingsIncludesManagerFallback: false,
    });
    expect(
      getAutomationDestinationDescriptorBySlackField(
        'codeQualityAuditorSlackChannel',
      ),
    ).toMatchObject({
      automationId: 'codeQualityAuditor',
      automationKey: 'code_quality_auditor',
    });
    expect(isAutomationDestinationAutomationId('ciFailureTriage')).toBe(true);
    expect(isAutomationDestinationAutomationId('reviewer')).toBe(false);
  });
});
