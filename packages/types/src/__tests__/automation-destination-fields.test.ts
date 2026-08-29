import {
  AUTOMATION_DESTINATION_DESCRIPTORS,
  getAutomationDestinationDescriptorById,
  getAutomationDestinationDescriptorByKey,
  getAutomationDestinationDescriptorBySlackField,
  isAutomationDestinationAutomationId,
} from '../automation-destination-fields';

describe('automation destination field registry', () => {
  it('keeps a stable one-of Slack/Discord descriptor for each destination automation', () => {
    expect(AUTOMATION_DESTINATION_DESCRIPTORS).toHaveLength(12);
    expect(
      new Set(
        AUTOMATION_DESTINATION_DESCRIPTORS.map(
          (descriptor) => descriptor.automationId,
        ),
      ).size,
    ).toBe(AUTOMATION_DESTINATION_DESCRIPTORS.length);
    expect(
      new Set(
        AUTOMATION_DESTINATION_DESCRIPTORS.map(
          (descriptor) => descriptor.automationKey,
        ),
      ).size,
    ).toBe(AUTOMATION_DESTINATION_DESCRIPTORS.length);
  });

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

  it('always manages Slack and Discord channel targets for the destination picker', () => {
    for (const descriptor of AUTOMATION_DESTINATION_DESCRIPTORS) {
      expect(descriptor.managedTargetKinds).toEqual(
        expect.arrayContaining(['slack_channel', 'discord_channel']),
      );
    }
  });
});
